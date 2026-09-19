import { Request, Response } from "express";
import { pool } from "../db/pool";

// ---------------------------------------------------------------------------
// Dashboard Finance — calculs portés depuis le DAG Airflow stage3_okr vers
// l'API (voir docs/finance.md), pour permettre un filtre société + période
// appliqué à la volée, comme operationnel.controller.ts le fait déjà pour
// le dashboard Opérationnel. Les formules et seuils reproduisent
// exactement ceux de utils/kpi_config.py et utils/kpi_calculations.py
// (compute_status) du repo Dashboard (Airflow).
// ---------------------------------------------------------------------------

type ThresholdType =
    | "absolute"
    | "pct_below"
    | "pct_above"
    | "days_above"
    | "days_late"
    | "pct_above_budget"
    | "pct_below_budget";

interface KrThreshold {
    target: number | null;
    thresholdType: ThresholdType;
    orange: number;
    red: number;
}

// Reprise de KEY_RESULTS (kpi_config.py) pour les 7 KR Finance affichés.
const KR_CONFIG: Record<string, KrThreshold> = {
    KR15: { target: null, thresholdType: "pct_below_budget", orange: 5, red: 10 },
    KR14: { target: null, thresholdType: "pct_below_budget", orange: 5, red: 10 },
    KR13: { target: null, thresholdType: "pct_above_budget", orange: 5, red: 10 },
    KR11: { target: 500000, thresholdType: "pct_below", orange: 5, red: 10 },
    KR12: { target: 10, thresholdType: "days_above", orange: 1, red: 2 },
    KR20: { target: 45, thresholdType: "days_above", orange: 5, red: 15 },
    KR24: { target: 60, thresholdType: "pct_above", orange: 5, red: 10 },
};

// Port 1:1 de compute_status() (Dashboard/airflow/dags/utils/kpi_calculations.py)
function computeStatus(
    value: number | null,
    target: number | null,
    thresholdType: ThresholdType,
    orangeDelta: number,
    redDelta: number
): "green" | "orange" | "red" | "unknown" {
    if (value === null) return "unknown";
    if (thresholdType === "absolute") return "green";
    if (target === null && thresholdType !== "pct_above_budget" && thresholdType !== "pct_below_budget") {
        return "green";
    }

    if (thresholdType === "pct_below") {
        if (target === 0) return "green";
        const pctDiff = ((value - (target as number)) / Math.abs(target as number)) * 100;
        if (pctDiff <= -redDelta) return "red";
        if (pctDiff <= -orangeDelta) return "orange";
        return "green";
    }
    if (thresholdType === "pct_above") {
        const pctDiff = target ? ((value - target) / Math.abs(target)) * 100 : 0;
        if (pctDiff >= redDelta) return "red";
        if (pctDiff >= orangeDelta) return "orange";
        return "green";
    }
    if (thresholdType === "days_above") {
        const diff = value - (target as number);
        if (diff >= redDelta) return "red";
        if (diff >= orangeDelta) return "orange";
        return "green";
    }
    if (thresholdType === "days_late") {
        if (value >= redDelta) return "red";
        if (value >= orangeDelta) return "orange";
        return "green";
    }
    if (thresholdType === "pct_above_budget") {
        if (value >= redDelta) return "red";
        if (value >= orangeDelta) return "orange";
        return "green";
    }
    if (thresholdType === "pct_below_budget") {
        if (target === null || target === 0) return "green";
        const pct = ((value - target) / Math.abs(target)) * 100;
        if (pct <= -redDelta) return "red";
        if (pct <= -orangeDelta) return "orange";
        return "green";
    }
    return "green";
}

interface KrEntry {
    period_key: string;
    period_month: number;
    actual_value: number | null;
    target_value: number | null;
    variance_pct: number | null;
    status: string;
    ca?: number | null;
}

// Port de _okr_row() (stage3_okr/dag.py) — variance_pct = ((actual - target) / |target|) * 100
function buildEntry(periodKey: string, actual: number | null, cfg: KrThreshold, targetOverride?: number | null): KrEntry {
    const month = parseInt(periodKey.slice(5, 7), 10);
    const target = targetOverride !== undefined ? targetOverride : cfg.target;
    const variance =
        actual !== null && target !== null && target !== 0
            ? Math.round(((actual - target) / Math.abs(target)) * 10000) / 100
            : null;
    const status = computeStatus(actual, target, cfg.thresholdType, cfg.orange, cfg.red);
    return { period_key: periodKey, period_month: month, actual_value: actual, target_value: target, variance_pct: variance, status };
}

// Moyenne glissante des 12 mois précédents (n'inclut jamais le mois courant) —
// port de kr14_hist[:-1][-12:] / kr13_hist[-12:], toutes deux équivalentes à
// "moyenne de l'historique strictement avant le mois courant, borné à 12 mois".
function trailingAvg(hist: number[]): number | null {
    if (hist.length === 0) return null;
    const window = hist.slice(-12);
    return Math.round((window.reduce((a, b) => a + b, 0) / window.length) * 100) / 100;
}

function parseCompanies(q: unknown): number[] | null {
    if (!q) return null;
    const arr = String(q)
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
    return arr.length ? arr : null;
}

function parseDateRange(req: Request): { dateFrom: string; dateTo: string } {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const defaultFrom = `${now.getFullYear()}-01-01`;
    const dateFrom = (req.query.date_from as string) || defaultFrom;
    // Plafonné à aujourd'hui, même si un date_to futur est fourni explicitement : évite
    // qu'une écriture de test/erreur datée dans le futur (déjà rencontré dans Odoo — une
    // facture à 0.03 CHF datée en novembre alors qu'on est en septembre) ne devienne le
    // "dernier mois" affiché à la place du mois réellement en cours. Voir docs/finance.md.
    const requestedTo = (req.query.date_to as string) || today;
    const dateTo = requestedTo > today ? today : requestedTo;
    return { dateFrom, dateTo };
}

// ---------------------------------------------------------------------------
// GET /api/finance/companies
// Liste des sociétés (staging.res_company) avec hiérarchie parent/filiale,
// pour le sélecteur multi-société façon Odoo (Accounting > Reporting).
// ---------------------------------------------------------------------------
export async function getFinanceCompanies(_req: Request, res: Response) {
    try {
        const result = await pool.query(
            `SELECT id, name, parent_id FROM staging."res_company" ORDER BY COALESCE(parent_id, id), parent_id NULLS FIRST, name`
        );
        // Tri : société racine, puis ses filiales juste en dessous (indentation niveau 1).
        const rows = result.rows as { id: number; name: string; parent_id: number | null }[];
        const byParent = new Map<number | null, typeof rows>();
        rows.forEach((r) => {
            const key = r.parent_id ?? null;
            if (!byParent.has(key)) byParent.set(key, []);
            byParent.get(key)!.push(r);
        });
        const ordered: { id: number; name: string; level: number }[] = [];
        const visit = (parentId: number | null, level: number) => {
            const children = byParent.get(parentId) || [];
            children.forEach((c) => {
                ordered.push({ id: c.id, name: c.name, level });
                visit(c.id, level + 1);
            });
        };
        // Racines = sociétés dont le parent_id ne correspond à aucune société connue.
        const knownIds = new Set(rows.map((r) => r.id));
        const rootIds = new Set<number | null>();
        rows.forEach((r) => {
            if (r.parent_id === null || !knownIds.has(r.parent_id)) rootIds.add(null);
        });
        rows.forEach((r) => {
            if (r.parent_id === null || !knownIds.has(r.parent_id)) {
                ordered.push({ id: r.id, name: r.name, level: 0 });
                visit(r.id, 1);
            }
        });
        res.json({ companies: ordered });
    } catch (err: any) {
        console.error("[finance/companies]", err);
        res.status(500).json({ error: "Erreur lors de la récupération des sociétés" });
    }
}

// ---------------------------------------------------------------------------
// GET /api/finance/dashboard?companies=1,2,3&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
// Calcule à la volée les 7 KR Finance (KR15, KR14, KR11, KR20, KR13, KR12, KR24)
// depuis staging.*, filtrés par société et par période (KR20/KR24 exceptés :
// ce sont des photos "à l'instant présent", non filtrables par période — voir
// docs/finance.md).
// ---------------------------------------------------------------------------
export async function getFinanceDashboard(req: Request, res: Response) {
    try {
        const companies = parseCompanies(req.query.companies);
        const { dateFrom, dateTo } = parseDateRange(req);

        const kr_id_map: Record<string, KrEntry[]> = {
            KR15: [], KR14: [], KR11: [], KR13: [], KR12: [], KR20: [], KR24: [],
        };

        // --- Budget CA (KR15) — staging.account_report_budget_item, un montant par compte ×
        // mois, agrégé sur les comptes classe 3 (même convention de signe que pos3 : négatif
        // pour un compte de revenu). Un vrai budget existe dans Odoo (Configuration > Financial
        // Budgets, modèle account.report.budget / account.report.budget.item) — l'ancienne
        // extraction pointait à tort vers 'account.budget', un modèle qui n'existe pas dans
        // cette instance Odoo, d'où la fausse conclusion "aucun budget saisi". Voir docs/finance.md.
        // Isolé dans son propre try/catch : staging.account_report_budget(_item) n'existe que
        // depuis l'ajout de ces modèles à l'extraction Airflow (stage1_accounting) — tant que ce
        // DAG n'a pas encore tourné avec le changement, la table n'existe pas côté staging. Sans
        // cet isolement, l'échec de cette requête ferait planter tout le dashboard Finance au
        // lieu de simplement afficher KR15 sans budget (comportement d'avant).
        const budgetCaByMonth = new Map<string, number>();
        try {
            const params: any[] = [];
            let companyClause = "";
            if (companies) { params.push(companies); companyClause = ` AND b.company_id = ANY($${params.length}::int[])`; }
            const r = await pool.query(
                `SELECT TO_CHAR(bi.date::date, 'YYYY-MM') AS month,
                        SUM(COALESCE(bi.amount, 0)) AS budget_pos3
                 FROM staging."account_report_budget_item" bi
                 JOIN staging."account_report_budget" b ON b.id = bi.budget_id
                 LEFT JOIN staging."account_account" aa ON aa.id = bi.account_id
                 WHERE LEFT(aa.code, 1) = '3'${companyClause}
                 GROUP BY 1`,
                params
            );
            r.rows.forEach((row) => { budgetCaByMonth.set(row.month, -(parseFloat(row.budget_pos3) || 0)); });
        } catch (e: any) {
            console.error("[finance/dashboard] budget CA indisponible (table pas encore extraite ?)", e.message);
        }

        // --- KR15 (CA) / KR14 (MB2) / KR13 (frais fixes) — historique complet (hors filtre de
        // période, pour la moyenne glissante 12 mois), puis on ne renvoie que les
        // mois dans [dateFrom, dateTo]. Le CA (KR15) est le solde des comptes classe 3
        // (pos3) — la vraie définition comptable du chiffre d'affaires (vérifiée contre
        // le rapport Profit & Loss d'Odoo), et non la somme des montants facturés : une
        // facture peut être reconnue en revenu sur plusieurs mois (comptes de
        // régularisation "Charges et produits constatés d'avance"), donc facturation et
        // CA comptable divergent. Voir docs/finance.md. --------------------------------
        {
            const params: any[] = [];
            let companyClause = "";
            if (companies) { params.push(companies); companyClause = ` AND aml.company_id = ANY($${params.length}::int[])`; }
            const r = await pool.query(
                `SELECT TO_CHAR(aml.date::date, 'YYYY-MM') AS month,
                        SUM(CASE WHEN LEFT(aa.code, 1) = '3' THEN COALESCE(aml.balance, 0) ELSE 0 END) AS pos3,
                        SUM(CASE WHEN LEFT(aa.code, 1) = '4' THEN COALESCE(aml.balance, 0) ELSE 0 END) AS pos4,
                        SUM(CASE WHEN LEFT(aa.code, 1) = '5' THEN COALESCE(aml.balance, 0) ELSE 0 END) AS pos5,
                        SUM(CASE WHEN LEFT(aa.code, 1) = '6' THEN COALESCE(aml.balance, 0) ELSE 0 END) AS pos6
                 FROM staging."account_move_line" aml
                 JOIN staging."account_move" am ON am.id = aml.move_id
                 LEFT JOIN staging."account_account" aa ON aa.id = aml.account_id
                 WHERE am.state = 'posted'
                   AND aml.date IS NOT NULL AND aml.date <> '' AND aml.date <> 'False'
                   AND aml.date::date <= CURRENT_DATE
                   AND (aml.display_type IS NULL OR aml.display_type NOT IN ('line_section', 'line_note'))
                   AND LEFT(aa.code, 1) IN ('3', '4', '5', '6')${companyClause}
                 GROUP BY 1 ORDER BY 1`,
                params
            );

            const kr14Hist: number[] = [];
            const kr13Hist: number[] = [];
            const kr15All: KrEntry[] = [];
            const kr14All: KrEntry[] = [];
            const kr13All: KrEntry[] = [];
            r.rows.forEach((row) => {
                const pos3 = parseFloat(row.pos3) || 0;
                const pos4 = parseFloat(row.pos4) || 0;
                const pos5 = parseFloat(row.pos5) || 0;
                const pos6 = parseFloat(row.pos6) || 0;
                const ca = -pos3; // solde des comptes classe 3 = CA comptable (KR15)
                const mb1 = ca - pos4;
                const mb2 = mb1 - pos5;
                const caBudget = budgetCaByMonth.get(row.month) ?? null;
                kr15All.push(buildEntry(row.month, ca, KR_CONFIG.KR15, caBudget));
                const target14 = trailingAvg(kr14Hist);
                const entry14 = buildEntry(row.month, mb2, KR_CONFIG.KR14, target14);
                entry14.ca = ca;
                kr14All.push(entry14);
                kr14Hist.push(mb2);

                const realise = pos6;
                const budget13 = trailingAvg(kr13Hist);
                if (budget13 === null || budget13 === 0) {
                    kr13All.push(buildEntry(row.month, realise, { ...KR_CONFIG.KR13, thresholdType: "absolute" }, null));
                } else {
                    const depassementPct = Math.round(((realise - budget13) / Math.abs(budget13)) * 10000) / 100;
                    const entry = buildEntry(row.month, depassementPct, KR_CONFIG.KR13, 0);
                    kr13All.push(entry);
                }
                kr13Hist.push(realise);
            });

            const inRange = (e: KrEntry) => e.period_key >= dateFrom.slice(0, 7) && e.period_key <= dateTo.slice(0, 7);
            kr_id_map.KR15 = kr15All.filter(inRange);
            kr_id_map.KR14 = kr14All.filter(inRange);
            kr_id_map.KR13 = kr13All.filter(inRange);
        }

        // --- KR11 — Trésorerie (mouvement bancaire net mensuel) ---------------------
        {
            const params: any[] = [dateFrom, dateTo];
            let companyClause = "";
            if (companies) { params.push(companies); companyClause = ` AND bsl.company_id = ANY($${params.length}::int[])`; }
            const r = await pool.query(
                `SELECT TO_CHAR(bsl.date::date, 'YYYY-MM') AS month, SUM(bsl.amount) AS bank_movement_chf
                 FROM staging."account_bank_statement_line" bsl
                 JOIN staging."account_journal" j ON j.id = bsl.journal_id
                 WHERE j.type = 'bank' AND bsl.date IS NOT NULL
                   AND bsl.date::date BETWEEN $1 AND $2${companyClause}
                 GROUP BY 1 ORDER BY 1`,
                params
            );
            kr_id_map.KR11 = r.rows.map((row) => buildEntry(row.month, parseFloat(row.bank_movement_chf) || 0, KR_CONFIG.KR11));
        }

        // --- KR12 — Rapports livrés (clôture des projets) ---------------------------
        {
            const params: any[] = [dateFrom, dateTo];
            let companyClause = "";
            if (companies) { params.push(companies); companyClause = ` AND company_id = ANY($${params.length}::int[])`; }
            const r = await pool.query(
                `SELECT TO_CHAR(write_date::date, 'YYYY-MM') AS month,
                        ROUND(AVG(write_date::date - COALESCE(date_start::date, create_date::date))::numeric, 2) AS avg_days
                 FROM staging."project_project"
                 WHERE active = FALSE
                   AND write_date IS NOT NULL AND write_date <> '' AND write_date <> 'False'
                   AND write_date::date BETWEEN $1 AND $2${companyClause}
                 GROUP BY 1 ORDER BY 1`,
                params
            );
            kr_id_map.KR12 = r.rows.map((row) => buildEntry(row.month, row.avg_days !== null ? parseFloat(row.avg_days) : null, KR_CONFIG.KR12));
        }

        // --- KR20 (DSO) / KR24 (aging) — photo à CURRENT_DATE, société uniquement ---
        {
            const params: any[] = [];
            let companyClause = "";
            if (companies) { params.push(companies); companyClause = ` AND aml.company_id = ANY($${params.length}::int[])`; }
            const r = await pool.query(
                `SELECT aml.balance,
                        GREATEST(CURRENT_DATE - COALESCE(aml.date_maturity, aml.date)::date, 0) AS age_days,
                        CASE
                          WHEN aml.reconciled = TRUE THEN 'paid'
                          WHEN COALESCE(aml.date_maturity, aml.date)::date < CURRENT_DATE THEN 'overdue'
                          ELSE 'open'
                        END AS aging_bucket
                 FROM staging."account_move_line" aml
                 JOIN staging."account_move" am ON am.id = aml.move_id
                 WHERE am.move_type IN ('out_invoice', 'out_refund') AND am.state = 'posted'
                   AND aml.partner_id IS NOT NULL
                   AND (aml.display_type IS NULL OR aml.display_type NOT IN ('line_section', 'line_note'))${companyClause}`,
                params
            );
            const overdue = r.rows.filter((row) => row.aging_bucket === "overdue");
            const currentMonth = new Date().toISOString().slice(0, 7);
            let dso: number | null = null;
            if (overdue.length) {
                const sum = overdue.reduce((a, row) => a + parseFloat(row.age_days), 0);
                dso = Math.round((sum / overdue.length) * 100) / 100;
            }
            kr_id_map.KR20 = dso !== null ? [buildEntry(currentMonth, dso, KR_CONFIG.KR20)] : [];
            kr_id_map.KR24 = dso !== null ? [buildEntry(currentMonth, dso, KR_CONFIG.KR24)] : [];

            const buckets = [
                { label: "< 15j", min: -Infinity, max: 15 },
                { label: "15-30j", min: 15, max: 30 },
                { label: "30-45j", min: 30, max: 45 },
                { label: "45-60j", min: 45, max: 60 },
                { label: "> 60j", min: 60, max: Infinity },
            ];
            const kr24Buckets = buckets.map((b) => {
                const amount = overdue
                    .filter((row) => { const age = parseFloat(row.age_days); return age >= b.min && age < b.max; })
                    .reduce((a, row) => a + (parseFloat(row.balance) || 0), 0);
                return { label: b.label, amount: Math.round(amount * 100) / 100 };
            });
            (kr_id_map as any).__kr24Buckets = kr24Buckets;
        }

        const kr24Buckets = (kr_id_map as any).__kr24Buckets;
        delete (kr_id_map as any).__kr24Buckets;

        const latest: Record<string, KrEntry> = {};
        Object.keys(kr_id_map).forEach((krId) => {
            const entries = kr_id_map[krId];
            if (entries.length) latest[krId] = entries[entries.length - 1];
        });

        res.json({ date_from: dateFrom, date_to: dateTo, kr_id_map, latest, kr24Buckets });
    } catch (err: any) {
        console.error("[finance/dashboard]", err);
        res.status(500).json({ error: "Erreur lors du calcul du dashboard Finance" });
    }
}
