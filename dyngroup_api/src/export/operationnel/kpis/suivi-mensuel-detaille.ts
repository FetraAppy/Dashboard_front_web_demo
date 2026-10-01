import { pool } from "../../../db/pool";
import {
    buildHolidaysByCanton,
    Canton,
    computeTheoSegments,
    loadCantonByEmployee,
    loadContractsByEmployee,
    resolveOdooHolidayEntries,
    TheoEmployeeFields,
    theoPeriodsForEmployee,
} from "../../../services/theo-hours";
import { DataSheet, FormulaCell, KpiExport } from "../../excel/kpi-export.types";
import { cellRef, columnRange } from "../../excel/workbook-builder";
import { EmployeeScope, MOIS, OperationnelExportFilters } from "../export-filters";

// Export du "Tableau de suivi mensuel détaillé" (onglet Suivi Mensuel & Détails).
// Chaîne de calcul, uniquement par formules Excel :
//   Timesheets + Segments de contrat (← Contrats, Collaborateurs, Jours fériés)
//     → Par collaborateur → Tableau → arbre de la feuille Informations.
// Les requêtes reprennent exactement les conditions du dashboard (operationnel.controller.ts), et
// le théorique vient du même calcul partagé (services/theo-hours.ts).

/** Même exclusion que "H. réalisées"/"H. Productivité" du dashboard : jours fériés fictifs Odoo. */
const EXCLUSION_FERIES_FICTIFS = "NOT (aal.name LIKE 'Congé (%' AND aal.amount = 0)";

const NUM = "0.00";
const DATE = "dd.mm.yyyy";

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");
/** Jour calendaire en UTC : Excel affiche sinon la veille pour une date à minuit heure locale. */
const toExcelDate = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const isoLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const frDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const fx = (formula: string, result: number | string): FormulaCell => ({ formula, result });

/** Date Odoo brute (texte "YYYY-MM-DD…" ou Date) → jour UTC pour Excel ; null si vide/"False". */
function odooDay(value: unknown): Date | null {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : toExcelDate(value);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

interface Mesures { theo: number; ref100: number; real: number; prod: number }

export async function exportSuiviMensuelDetaille(
    filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    const { annee } = filters;
    const months = scope.months;

    const [odooHolidays, cantonMap, contractsMap, empFieldsRes, tsRes, contratsRes, lieuRes] = await Promise.all([
        resolveOdooHolidayEntries(annee),
        loadCantonByEmployee(),
        loadContractsByEmployee(),
        // Mêmes champs que la liste d'employés du dashboard (repli quand il n'y a pas de contrat).
        pool.query(
            `SELECT emp.id, rc.hours_per_day, rc.name AS horaire, emp.first_contract_date, emp.departure_date
             FROM staging.hr_employee emp
             LEFT JOIN staging.resource_calendar rc ON emp.resource_calendar_id = rc.id
             WHERE emp.id = ANY($1::int[])`,
            [scope.employeeIds]
        ),
        pool.query(
            `SELECT TO_CHAR(aal.date::date, 'YYYY-MM-DD') AS date, aal.employee_id, aal.name AS libelle,
                    aal.unit_amount AS heures, aal.productivity, pp.name AS projet, pt.name AS tache
             FROM staging.account_analytic_line aal
             LEFT JOIN staging.project_project pp ON pp.id = aal.project_id
             LEFT JOIN staging.project_task pt ON pt.id = aal.task_id
             WHERE aal.employee_id = ANY($1::int[])
               AND aal.date IS NOT NULL
               AND aal.date::date BETWEEN $2::date AND $3::date
               AND ${EXCLUSION_FERIES_FICTIFS}
             ORDER BY aal.date::date, aal.employee_id, aal.id`,
            [scope.employeeIds, scope.dateFrom, scope.dateTo]
        ),
        // Contrats bruts d'Odoo (mêmes états que loadContractsByEmployee : open + close).
        pool.query(
            `SELECT c.id, c.name, c.employee_id, c.state, c.date_start, c.date_end,
                    rc.name AS horaire, COALESCE(rc.hours_per_day, 8) AS hpj
             FROM staging.hr_contract c
             LEFT JOIN staging.resource_calendar rc ON c.resource_calendar_id = rc.id
             WHERE c.employee_id = ANY($1::int[]) AND c.state IN ('open', 'close') AND c.date_start IS NOT NULL
             ORDER BY c.employee_id, c.date_start::date`,
            [scope.employeeIds]
        ).catch(() => ({ rows: [] as any[] })), // staging.hr_contract pas encore extrait
        // Lieu de travail brut (d'où vient le canton) — colonne pas encore extraite avant stage1_hr.
        pool.query(
            `SELECT id, work_location_name FROM staging.hr_employee WHERE id = ANY($1::int[])`,
            [scope.employeeIds]
        ).catch(() => ({ rows: [] as any[] })),
    ]);

    const holidaysByCanton = buildHolidaysByCanton(odooHolidays, annee);
    const empFields: Record<number, TheoEmployeeFields & { horaire: string | null }> = {};
    empFieldsRes.rows.forEach(r => { empFields[r.id] = r; });
    const lieuById = new Map<number, string>(lieuRes.rows.map((r: any) => [r.id, r.work_location_name ?? ""]));
    const empById = new Map(scope.employees.map(e => [e.id, e]));
    const monthSet = new Set(months);

    // Mesures par collaborateur × mois, calculées ici pour servir de résultat affiché aux formules.
    const mesures = new Map<string, Mesures>();
    const keyOf = (empId: number, mois: number) => `${empId}|${mois}`;
    scope.employees.forEach(e => months.forEach(m => mesures.set(keyOf(e.id, m), { theo: 0, ref100: 0, real: 0, prod: 0 })));

    // --- Feuille Timesheets -------------------------------------------------------------------
    const timesheets: DataSheet = {
        name: "Timesheets",
        description: "Lignes de feuille de temps comptées dans H. réalisées (la colonne Productivité détermine H. Productivité)",
        columns: [
            { header: "Date", key: "date", width: 12, numFmt: DATE },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Projet", key: "projet", width: 34 },
            { header: "Tâche", key: "tache", width: 34 },
            { header: "Libellé", key: "libelle", width: 50 },
            { header: "Heures", key: "heures", width: 9, numFmt: NUM },
            { header: "Productivité", key: "productivite", width: 13 },
        ],
        rows: [],
    };
    tsRes.rows.forEach(r => {
        const emp = empById.get(r.employee_id);
        if (!emp) return;
        const [y, mo, d] = r.date.split("-").map(Number);
        const heures = parseFloat(r.heures) || 0;
        const productive = r.productivity === true;
        const m = mesures.get(keyOf(emp.id, mo));
        if (m) {
            m.real += heures;
            if (productive) m.prod += heures;
        }
        timesheets.rows.push({
            date: new Date(Date.UTC(y, mo - 1, d)),
            mois: mo,
            collab: emp.name,
            societe: emp.company ?? "",
            projet: r.projet ?? "",
            tache: r.tache ?? "",
            libelle: r.libelle ?? "",
            heures,
            productivite: productive ? "Oui" : "Non",
        });
    });

    // --- Feuille Contrats (Odoo : hr.contract + resource.calendar) ------------------------------
    const contrats: DataSheet = {
        name: "Contrats",
        description: "Contrats Odoo (en cours et clos) du périmètre, avec leur horaire de travail",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Contrat", key: "contrat", width: 28 },
            { header: "État", key: "etat", width: 9 },
            { header: "Début", key: "debut", width: 12, numFmt: DATE },
            { header: "Fin", key: "fin", width: 12, numFmt: DATE },
            { header: "Horaire de travail", key: "horaire", width: 28 },
            { header: "Heures/jour", key: "hpj", width: 12, numFmt: NUM },
        ],
        rows: [],
    };
    contratsRes.rows.forEach((r: any) => {
        const emp = empById.get(r.employee_id);
        if (!emp) return;
        contrats.rows.push({
            collab: emp.name,
            contrat: r.name ?? "",
            etat: r.state === "close" ? "Clos" : "En cours",
            debut: odooDay(r.date_start),
            fin: odooDay(r.date_end),
            horaire: r.horaire ?? "",
            hpj: parseFloat(r.hpj) || 8,
        });
    });

    // --- Feuille Collaborateurs (Odoo : hr.employee) -------------------------------------------
    const collaborateurs: DataSheet = {
        name: "Collaborateurs",
        description: "Fiche employé Odoo : société, lieu de travail (→ canton des jours fériés), base du théorique",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Lieu de travail", key: "lieu", width: 20 },
            { header: "Canton", key: "canton", width: 8 },
            { header: "1er contrat", key: "premier", width: 12, numFmt: DATE },
            { header: "Départ", key: "depart", width: 12, numFmt: DATE },
            { header: "Horaire (fiche)", key: "horaire", width: 24 },
            { header: "Heures/jour (fiche)", key: "hpj", width: 18, numFmt: NUM },
            { header: "Théorique calculé d'après", key: "source", width: 24 },
        ],
        rows: [],
    };

    // --- Feuille Jours fériés -----------------------------------------------------------------
    // Construite avant les segments : leurs « Jours fériés déduits » la comptent par formule.
    const cantonOf = (empId: number): Canton => cantonMap[empId] || "VD";
    const cantonsUtilises = new Set<Canton>(scope.employees.map(e => cantonOf(e.id)));
    const feriesSheet: DataSheet = {
        name: "Jours fériés",
        description: "Jours fériés de la période par canton ; seuls les jours ouvrés sont déduits du théorique",
        columns: [
            { header: "Date", key: "date", width: 12, numFmt: DATE },
            { header: "Nom", key: "nom", width: 40 },
            { header: "Canton", key: "canton", width: 8 },
            { header: "Jour ouvré (déduit)", key: "ouvre", width: 19 },
            { header: "Source", key: "source", width: 22 },
        ],
        rows: [],
    };
    [...cantonsUtilises].sort().forEach(canton => {
        const set = holidaysByCanton[canton];
        set.entries
            .filter(e => isoLocal(e.date) >= scope.dateFrom && isoLocal(e.date) <= scope.dateTo)
            .sort((a, b) => a.date.getTime() - b.date.getTime())
            .forEach(e => {
                const dow = e.date.getDay();
                feriesSheet.rows.push({
                    date: toExcelDate(e.date),
                    nom: e.name,
                    canton,
                    ouvre: dow !== 0 && dow !== 6 ? "Oui" : "Non",
                    source: set.source === "odoo" ? "Calendrier Odoo" : "Formule (Vaud)",
                });
            });
    });

    // --- Feuille Segments de contrat (théorique et référence 100% de l'ETP) -------------------
    const segmentsSheet: DataSheet = {
        name: "Segments de contrat",
        description: "Théorique par collaborateur, mois et période de contrat (mois coupé si le contrat change en cours de mois)",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Canton", key: "canton", width: 8 },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Début", key: "debut", width: 12, numFmt: DATE },
            { header: "Fin", key: "fin", width: 12, numFmt: DATE },
            { header: "Source", key: "source", width: 14 },
            { header: "Heures/jour", key: "hpj", width: 12, numFmt: NUM },
            { header: "Jours ouvrés", key: "jours_ouvres", width: 13 },
            { header: "Jours fériés déduits", key: "feries", width: 19 },
            { header: "Dates fériées", key: "feries_dates", width: 26 },
            { header: "H. théoriques", key: "theo", width: 14, numFmt: NUM },
            { header: "Référence 100%", key: "ref100", width: 15, numFmt: NUM },
        ],
        rows: [],
    };
    const unrounded = new Map<string, { theo: number; ref100: number }>();
    scope.employees.forEach(emp => {
        const canton = cantonOf(emp.id);
        const fields = empFields[emp.id] ?? { hours_per_day: null, first_contract_date: null, departure_date: null, horaire: null };
        const { periods, source } = theoPeriodsForEmployee(contractsMap[emp.id], fields, annee);
        const sourceLabel = source === "contrat" ? "Contrat" : "Fiche employé";

        collaborateurs.rows.push({
            collab: emp.name,
            societe: emp.company ?? "",
            lieu: lieuById.get(emp.id) ?? "",
            canton,
            premier: odooDay(fields.first_contract_date),
            depart: odooDay(fields.departure_date),
            horaire: fields.horaire ?? "",
            hpj: fields.hours_per_day === null || fields.hours_per_day === undefined
                ? null
                : parseFloat(String(fields.hours_per_day)) || null,
            source: sourceLabel,
        });

        // Année complète (toDate=false), comme la colonne H. théoriques du dashboard.
        computeTheoSegments(periods, annee, holidaysByCanton[canton].fullYear, false)
            .filter(s => monthSet.has(s.month + 1))
            .forEach(s => {
                const i = segmentsSheet.rows.length;
                const ref100 = (s.workingDays - s.holidays.length) * 8;
                const acc = unrounded.get(keyOf(emp.id, s.month + 1)) ?? { theo: 0, ref100: 0 };
                acc.theo += s.hours;
                acc.ref100 += ref100;
                unrounded.set(keyOf(emp.id, s.month + 1), acc);
                const seg = (key: string) => cellRef(segmentsSheet, key, i);
                const joursRef = `(${seg("jours_ouvres")}-${seg("feries")})`;
                segmentsSheet.rows.push({
                    collab: emp.name,
                    canton,
                    mois: s.month + 1,
                    debut: toExcelDate(s.from),
                    fin: toExcelDate(s.to),
                    source: sourceLabel,
                    hpj: s.hoursPerDay,
                    // Lundi → vendredi entre Début et Fin inclus.
                    jours_ouvres: fx(`NETWORKDAYS(${seg("debut")},${seg("fin")})`, s.workingDays),
                    // Jours fériés ouvrés du canton tombant entre Début et Fin (feuille Jours fériés).
                    feries: fx(
                        `COUNTIFS(${columnRange(feriesSheet, "date")},">="&${seg("debut")},${columnRange(feriesSheet, "date")},"<="&${seg("fin")},`
                        + `${columnRange(feriesSheet, "canton")},${seg("canton")},${columnRange(feriesSheet, "ouvre")},"Oui")`,
                        s.holidays.length
                    ),
                    feries_dates: s.holidays.map(frDate).join(", "),
                    theo: fx(`${joursRef}*${seg("hpj")}`, s.hours),
                    ref100: fx(`${joursRef}*8`, ref100),
                });
            });
    });
    // Arrondi à 2 décimales par collaborateur et par mois, comme le dashboard.
    unrounded.forEach((v, k) => {
        const m = mesures.get(k);
        if (m) { m.theo = round2(v.theo); m.ref100 = round2(v.ref100); }
    });

    // --- Feuille Par collaborateur --------------------------------------------------------------
    const parCollab: DataSheet = {
        name: "Par collaborateur",
        description: "Mesures par collaborateur et par mois, sommées depuis Timesheets et Segments de contrat",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Nom du mois", key: "mois_nom", width: 12 },
            { header: "H. théoriques", key: "theo", width: 14, numFmt: NUM },
            { header: "Référence 100%", key: "ref100", width: 15, numFmt: NUM },
            { header: "H. réalisées", key: "real", width: 13, numFmt: NUM },
            { header: "H. Productivité", key: "prod", width: 15, numFmt: NUM },
            { header: "ETP", key: "etp", width: 7, numFmt: NUM },
        ],
        rows: [],
    };
    const segSum = (key: string, i: number) =>
        `SUMIFS(${columnRange(segmentsSheet, key)},${columnRange(segmentsSheet, "collab")},${cellRef(parCollab, "collab", i)},${columnRange(segmentsSheet, "mois")},${cellRef(parCollab, "mois", i)})`;
    const tsSum = (i: number, extra = "") =>
        `SUMIFS(${columnRange(timesheets, "heures")},${columnRange(timesheets, "collab")},${cellRef(parCollab, "collab", i)},${columnRange(timesheets, "mois")},${cellRef(parCollab, "mois", i)}${extra})`;
    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(emp => {
        months.forEach(mois => {
            const i = parCollab.rows.length;
            const m = mesures.get(keyOf(emp.id, mois))!;
            const etp = m.ref100 > 0 ? Math.min(1, round2(m.theo / m.ref100)) : 0;
            const theoC = cellRef(parCollab, "theo", i);
            const refC = cellRef(parCollab, "ref100", i);
            parCollab.rows.push({
                collab: emp.name,
                mois,
                mois_nom: MOIS[mois - 1],
                theo: fx(`ROUND(${segSum("theo", i)},2)`, m.theo),
                ref100: fx(`ROUND(${segSum("ref100", i)},2)`, m.ref100),
                real: fx(tsSum(i), m.real),
                prod: fx(tsSum(i, `,${columnRange(timesheets, "productivite")},"Oui"`), m.prod),
                etp: fx(`IF(${refC}>0,MIN(1,ROUND(${theoC}/${refC},2)),0)`, etp),
            });
        });
    });

    // --- Feuille Tableau (réplique du tableau du dashboard) -------------------------------------
    const tableau: DataSheet = {
        name: "Tableau",
        description: "Réplique du Tableau de suivi mensuel détaillé du dashboard (une ligne par mois + Total ou Moy.)",
        columns: [
            { header: "N° mois", key: "mois", width: 9 },
            { header: "Mois", key: "mois_nom", width: 16 },
            { header: "H. théoriques", key: "theo", width: 14, numFmt: NUM },
            { header: "H. réalisées", key: "real", width: 13, numFmt: NUM },
            { header: "Taux effort (%)", key: "taux_effort", width: 15, numFmt: NUM },
            { header: "H. Productivité", key: "prod", width: 15, numFmt: NUM },
            { header: "Taux Productivité (%)", key: "taux_prod", width: 21, numFmt: NUM },
            { header: "ETP", key: "etp", width: 7, numFmt: NUM },
        ],
        rows: [],
        lastRowIsTotal: true,
    };
    const pcSum = (key: string, i: number) =>
        `SUMIFS(${columnRange(parCollab, key)},${columnRange(parCollab, "mois")},${cellRef(tableau, "mois", i)})`;
    const ref = (key: string, i: number) => cellRef(tableau, key, i);
    const totals = { theo: 0, real: 0, prod: 0, etp: 0 };
    months.forEach(mois => {
        const i = tableau.rows.length;
        const agg = { theo: 0, ref100: 0, real: 0, prod: 0 };
        scope.employees.forEach(e => {
            const m = mesures.get(keyOf(e.id, mois))!;
            agg.theo += m.theo; agg.ref100 += m.ref100; agg.real += m.real; agg.prod += m.prod;
        });
        const etp = agg.ref100 > 0 ? Math.min(1, round2(agg.theo / agg.ref100)) : 0;
        totals.theo += agg.theo; totals.real += agg.real; totals.prod += agg.prod; totals.etp += etp;
        tableau.rows.push({
            mois,
            mois_nom: MOIS[mois - 1],
            theo: fx(pcSum("theo", i), agg.theo),
            real: fx(pcSum("real", i), agg.real),
            taux_effort: fx(
                `IF(AND(${ref("real", i)}>0,${ref("theo", i)}>0),${ref("real", i)}/${ref("theo", i)}*100,"—")`,
                agg.real > 0 && agg.theo > 0 ? (agg.real / agg.theo) * 100 : "—"
            ),
            prod: fx(pcSum("prod", i), agg.prod),
            taux_prod: fx(
                `IF(${ref("real", i)}>0,${ref("prod", i)}/${ref("real", i)}*100,"—")`,
                agg.real > 0 ? (agg.prod / agg.real) * 100 : "—"
            ),
            etp: fx(
                `IF(${pcSum("ref100", i)}>0,MIN(1,ROUND(${pcSum("theo", i)}/${pcSum("ref100", i)},2)),0)`,
                etp
            ),
        });
    });
    const t = tableau.rows.length; // index de la ligne Total
    const sumCol = (key: string) => `SUM(${ref(key, 0)}:${ref(key, t - 1)})`;
    const tauxEffortTotal = totals.real > 0 && totals.theo > 0 ? (totals.real / totals.theo) * 100 : "—";
    const tauxProdTotal = totals.real > 0 ? (totals.prod / totals.real) * 100 : "—";
    tableau.rows.push({
        mois: null,
        mois_nom: "Total ou Moy.",
        theo: fx(sumCol("theo"), totals.theo),
        real: fx(sumCol("real"), totals.real),
        taux_effort: fx(`IF(AND(${ref("real", t)}>0,${ref("theo", t)}>0),${ref("real", t)}/${ref("theo", t)}*100,"—")`, tauxEffortTotal),
        prod: fx(sumCol("prod"), totals.prod),
        taux_prod: fx(`IF(${ref("real", t)}>0,${ref("prod", t)}/${ref("real", t)}*100,"—")`, tauxProdTotal),
        etp: fx(sumCol("etp"), totals.etp),
    });

    // --- Chemin de calcul (une racine par colonne, valeur = ligne Total du Tableau) -------------
    const total = (key: string) => cellRef(tableau, key, t, true);
    const nbCollab = scope.employees.length;
    const nbLignes = timesheets.rows.length;
    const nbProductives = timesheets.rows.filter(r => r.productivite === "Oui").length;
    const sourcesFeries = [...cantonsUtilises].sort()
        .map(c => `${c} : ${holidaysByCanton[c].source === "odoo" ? "calendrier Odoo" : "formule (Vaud)"}`)
        .join(" · ");
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""}, du ${frDate(new Date(scope.dateFrom))} au ${frDate(new Date(scope.dateTo))}`;
    const exclusion = "Hors lignes « Congé (…) » à 0 CHF (jours fériés fictifs Odoo)";
    const sommeHeures = "Σ par collaborateur et mois (Par collaborateur) → Σ par mois (Tableau) → Σ des mois";

    return {
        definition: {
            id: "suivi-mensuel-detaille",
            titre: "Tableau de suivi mensuel détaillé",
            onglet: "Suivi Mensuel & Détails",
            description: "Heures théoriques, réalisées et productives, taux d'effort et de productivité, et ETP, par mois",
            tables: [
                "staging.account_analytic_line", "staging.project_project", "staging.project_task",
                "staging.hr_employee", "staging.hr_contract", "staging.resource_calendar",
                "staging.resource_calendar_leaves", "staging.res_company", "kpi.operationnel_suivi_mensuel",
            ],
            colonnes: [
                {
                    nom: "H. théoriques",
                    description: "Heures dues selon le contrat",
                    metier: "Charge de travail contractuelle attendue",
                    formule: "(j. ouvrés − j. fériés du canton) × h/jour du contrat, par sous-période de contrat",
                    source: "Contrats + jours fériés",
                    commentaire: "Année complète, mois futurs inclus",
                },
                {
                    nom: "H. réalisées",
                    description: "Heures saisies en feuille de temps",
                    metier: "Présence / activité réelle",
                    formule: "Σ heures de timesheet",
                    source: "Timesheets",
                    commentaire: exclusion,
                },
                {
                    nom: "Taux effort",
                    description: "% du contrat effectivement travaillé",
                    metier: "Sur- ou sous-régime par rapport au contrat",
                    formule: "H. réalisées ÷ H. théoriques × 100",
                    source: "Calculé",
                    commentaire: "≥ 95% vert · 85–95% orange · < 85% rouge",
                },
                {
                    nom: "H. Productivité",
                    description: "Heures marquées « productives »",
                    metier: "Volume de travail à valeur ajoutée",
                    formule: "Σ heures de timesheet avec Productivité = Oui",
                    source: "Timesheets",
                    commentaire: exclusion,
                },
                {
                    nom: "Taux Productivité",
                    description: "% du réalisé qui est productif",
                    metier: "Efficacité individuelle",
                    formule: "H. Productivité ÷ H. réalisées × 100",
                    source: "Calculé",
                    commentaire: "≥ 100% vert · 80–99% orange · < 80% rouge",
                },
                {
                    nom: "ETP",
                    description: "Équivalent temps plein contractuel",
                    metier: "Part du temps plein pour laquelle la personne est engagée",
                    formule: "min(1, H. théoriques ÷ H. théoriques à 8h/jour)",
                    source: "Calculé (contrats)",
                    commentaire: "Total : somme des ETP mensuels",
                },
            ],
        },
        derivation: [
            {
                label: "H. théoriques", formula: total("theo"), value: totals.theo, numFmt: NUM,
                children: [
                    { label: "Périmètre", detail: perimetre },
                    { label: "Contrats", detail: `${contrats.rows.length} contrats (Contrats) ; sans contrat : horaire de la fiche employé (Collaborateurs)` },
                    { label: "Jours fériés", detail: `${feriesSheet.rows.length} jours (Jours fériés) — ${sourcesFeries}` },
                    { label: "Par segment", detail: `(j. ouvrés − j. fériés) × h/jour → ${segmentsSheet.rows.length} segments (Segments de contrat)` },
                    { label: "Agrégation", detail: "Σ segments par collaborateur et mois, arrondi à 2 décimales → Σ par mois (Tableau) → Σ des mois" },
                ],
            },
            {
                label: "H. réalisées", formula: total("real"), value: totals.real, numFmt: NUM,
                children: [
                    { label: "Source", detail: `${nbLignes} lignes de timesheet (Timesheets)` },
                    { label: "Exclusion", detail: exclusion },
                    { label: "Agrégation", detail: sommeHeures },
                ],
            },
            {
                label: "Taux effort (%)", formula: total("taux_effort"), value: tauxEffortTotal, numFmt: NUM,
                children: [
                    { label: "H. réalisées", formula: total("real"), value: totals.real, numFmt: NUM },
                    { label: "H. théoriques", formula: total("theo"), value: totals.theo, numFmt: NUM },
                    { label: "Formule", detail: "H. réalisées ÷ H. théoriques × 100 (Total : rapport des totaux)" },
                ],
            },
            {
                label: "H. Productivité", formula: total("prod"), value: totals.prod, numFmt: NUM,
                children: [
                    { label: "Source", detail: `${nbProductives} lignes avec Productivité = Oui (Timesheets)` },
                    { label: "Exclusion", detail: exclusion },
                    { label: "Agrégation", detail: sommeHeures },
                ],
            },
            {
                label: "Taux Productivité (%)", formula: total("taux_prod"), value: tauxProdTotal, numFmt: NUM,
                children: [
                    { label: "H. Productivité", formula: total("prod"), value: totals.prod, numFmt: NUM },
                    { label: "H. réalisées", formula: total("real"), value: totals.real, numFmt: NUM },
                    { label: "Formule", detail: "H. Productivité ÷ H. réalisées × 100 (Total : rapport des totaux)" },
                ],
            },
            {
                label: "ETP", formula: total("etp"), value: round2(totals.etp), numFmt: NUM,
                children: [
                    { label: "Par mois", detail: "min(1, Σ H. théoriques ÷ Σ Référence 100%), arrondi à 2 décimales (Tableau)" },
                    { label: "Référence 100%", detail: "Mêmes segments de contrat à 8h/jour (Segments de contrat)" },
                    { label: "Total", detail: "Somme des ETP mensuels (pas une moyenne)" },
                ],
            },
        ],
        sheets: [tableau, parCollab, timesheets, contrats, collaborateurs, segmentsSheet, feriesSheet],
    };
}
