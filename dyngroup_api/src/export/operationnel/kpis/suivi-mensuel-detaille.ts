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
//   Timesheets + Segments de contrat → Par collaborateur → Tableau → arbre de la feuille Informations.
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

interface Mesures { theo: number; ref100: number; real: number; prod: number }

export async function exportSuiviMensuelDetaille(
    filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    const { annee } = filters;
    const months = scope.months;

    const [odooHolidays, cantonMap, contractsMap, empFieldsRes, tsRes] = await Promise.all([
        resolveOdooHolidayEntries(annee),
        loadCantonByEmployee(),
        loadContractsByEmployee(),
        // Mêmes champs que la liste d'employés du dashboard (repli quand il n'y a pas de contrat).
        pool.query(
            `SELECT emp.id, rc.hours_per_day, emp.first_contract_date, emp.departure_date
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
    ]);

    const holidaysByCanton = buildHolidaysByCanton(odooHolidays, annee);
    const empFields: Record<number, TheoEmployeeFields> = {};
    empFieldsRes.rows.forEach(r => { empFields[r.id] = r; });
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

    // --- Feuille Segments de contrat (théorique et référence 100% de l'ETP) -------------------
    const segmentsSheet: DataSheet = {
        name: "Segments de contrat",
        description: "Théorique par collaborateur, mois et période de contrat (un mois est coupé si le contrat change en cours de mois)",
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
    const cantonsUtilises = new Set<Canton>();
    const unrounded = new Map<string, { theo: number; ref100: number }>();
    scope.employees.forEach(emp => {
        const canton: Canton = cantonMap[emp.id] || "VD";
        cantonsUtilises.add(canton);
        const fields = empFields[emp.id] ?? { hours_per_day: null, first_contract_date: null, departure_date: null };
        const { periods, source } = theoPeriodsForEmployee(contractsMap[emp.id], fields, annee);
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
                const joursRef = `(${cellRef(segmentsSheet, "jours_ouvres", i)}-${cellRef(segmentsSheet, "feries", i)})`;
                segmentsSheet.rows.push({
                    collab: emp.name,
                    canton,
                    mois: s.month + 1,
                    debut: toExcelDate(s.from),
                    fin: toExcelDate(s.to),
                    source: source === "contrat" ? "Contrat" : "Fiche employé",
                    hpj: s.hoursPerDay,
                    jours_ouvres: s.workingDays,
                    feries: s.holidays.length,
                    feries_dates: s.holidays.map(frDate).join(", "),
                    theo: fx(`${joursRef}*${cellRef(segmentsSheet, "hpj", i)}`, s.hours),
                    ref100: fx(`${joursRef}*8`, ref100),
                });
            });
    });
    // Arrondi à 2 décimales par collaborateur et par mois, comme le dashboard.
    unrounded.forEach((v, k) => {
        const m = mesures.get(k);
        if (m) { m.theo = round2(v.theo); m.ref100 = round2(v.ref100); }
    });

    // --- Feuille Jours fériés -----------------------------------------------------------------
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
    const periode = `du ${frDate(new Date(scope.dateFrom))} au ${frDate(new Date(scope.dateTo))}`;
    const sourcesFeries = [...cantonsUtilises].sort()
        .map(c => `${c} : ${holidaysByCanton[c].source === "odoo" ? "calendrier Odoo" : "formule (Vaud)"}`)
        .join(" · ");
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""} · période ${periode}`;

    return {
        definition: {
            id: "suivi-mensuel-detaille",
            titre: "Tableau de suivi mensuel détaillé",
            onglet: "Suivi Mensuel & Détails",
            description: "Heures théoriques, réalisées et productives, taux d'effort et de productivité, et ETP, par mois",
            cible: "Taux effort : ≥ 95% vert · 85–95% orange · < 85% rouge ; Taux Productivité : ≥ 100% vert · 80–99% orange · < 80% rouge",
            tables: [
                "staging.account_analytic_line", "staging.project_project", "staging.project_task",
                "staging.hr_employee", "staging.hr_contract", "staging.resource_calendar",
                "staging.resource_calendar_leaves", "staging.res_company", "kpi.operationnel_suivi_mensuel",
            ],
            commentaires: [
                "Les lignes « Congé (…) » à 0 CHF (jours fériés fictifs générés par Odoo) sont exclues des heures réalisées et productives.",
                "« Tous les mois » couvre l'année complète, mois futurs inclus (théorique et ETP calculés d'après les contrats).",
                "Ligne « Total ou Moy. » : sommes pour les heures, rapport des totaux pour les taux, somme des ETP mensuels pour l'ETP.",
            ],
            colonnes: [
                {
                    nom: "H. théoriques",
                    description: "Heures dues selon le contrat",
                    metier: "Charge de travail contractuelle attendue",
                    formule: "(jours ouvrés − jours fériés du canton) × heures/jour du contrat, calculé par sous-période si le contrat change en cours de mois, puis sommé",
                    source: "Contrats + calendrier des jours fériés",
                    commentaire: "Année complète (n'exclut pas les mois futurs)",
                },
                {
                    nom: "H. réalisées",
                    description: "Heures saisies en feuille de temps",
                    metier: "Présence/activité réelle",
                    formule: "H. réalisées = Σ heures de timesheet",
                    source: "Feuilles de temps",
                    commentaire: "Hors lignes « Congé (…) » à 0 CHF (jours fériés fictifs)",
                },
                {
                    nom: "Taux effort",
                    description: "% du contrat effectivement travaillé",
                    metier: "Sur-régime ou sous-régime par rapport au contrat",
                    formule: "Taux effort = (H. réalisées / H. théoriques) × 100",
                    source: "Calculé",
                    commentaire: "Seuils : ≥ 95% vert, 85–95% orange, < 85% rouge. Ligne Total : rapport des totaux",
                },
                {
                    nom: "H. Productivité",
                    description: "Heures marquées « productives »",
                    metier: "Volume de travail à valeur ajoutée",
                    formule: "H. Productivité = Σ heures de timesheet avec Productivité = Oui",
                    source: "Feuilles de temps (case « Productivité »)",
                    commentaire: "Hors lignes « Congé (…) » à 0 CHF (jours fériés fictifs)",
                },
                {
                    nom: "Taux Productivité",
                    description: "% du réalisé qui est productif",
                    metier: "Efficacité individuelle",
                    formule: "Taux Productivité = (H. Productivité / H. réalisées) × 100",
                    source: "Calculé",
                    commentaire: "Seuils : ≥ 100% vert, 80–99% orange, < 80% rouge. Ligne Total : rapport des totaux",
                },
                {
                    nom: "ETP",
                    description: "Taux d'activité contractuel (équivalent temps plein)",
                    metier: "% du temps plein pour lequel la personne est engagée",
                    formule: "ETP = min(1, H. théoriques réelles / H. théoriques référence 100%)",
                    source: "Calculé (contrats)",
                    commentaire: "Référence 100% = même fenêtre de contrat à 8h/jour. Ligne Total : somme des ETP mensuels (pas une moyenne)",
                },
            ],
        },
        derivation: [
            {
                label: "H. théoriques", formula: total("theo"), value: totals.theo, numFmt: NUM,
                children: [
                    { label: "Source", detail: `Contrats (hr_contract), repli fiche employé si aucun contrat → ${segmentsSheet.rows.length} segments (feuille Segments de contrat)` },
                    { label: "Source", detail: `Jours fériés du canton (feuille Jours fériés) — ${sourcesFeries}` },
                    { label: "Périmètre", detail: perimetre },
                    { label: "Par segment", detail: "(jours ouvrés lun–ven − jours fériés ouvrés) × heures/jour du contrat" },
                    { label: "Opération", detail: "Σ des segments par collaborateur et par mois, arrondi à 2 décimales (feuille Par collaborateur) → Σ des collaborateurs par mois (feuille Tableau) → Σ des mois" },
                ],
            },
            {
                label: "H. réalisées", formula: total("real"), value: totals.real, numFmt: NUM,
                children: [
                    {
                        label: "Source", detail: `Feuilles de temps (account_analytic_line) → ${nbLignes} lignes (feuille Timesheets)`,
                        children: [
                            { label: "Filtre", detail: perimetre },
                            { label: "Exclusion", detail: "Lignes « Congé (…) » à 0 CHF (jours fériés fictifs générés par Odoo)" },
                        ],
                    },
                    { label: "Opération", detail: "Σ Heures par collaborateur et par mois (feuille Par collaborateur) → Σ des collaborateurs par mois (feuille Tableau) → Σ des mois" },
                ],
            },
            {
                label: "Taux effort (%)", formula: total("taux_effort"), value: tauxEffortTotal, numFmt: NUM,
                children: [
                    { label: "Formule", detail: "H. réalisées ÷ H. théoriques × 100" },
                    { label: "H. réalisées", formula: total("real"), value: totals.real, numFmt: NUM },
                    { label: "H. théoriques", formula: total("theo"), value: totals.theo, numFmt: NUM },
                    { label: "Ligne Total", detail: "Σ H. réalisées ÷ Σ H. théoriques (pas la moyenne des taux mensuels)" },
                    { label: "Cible", detail: "≥ 95% vert · 85–95% orange · < 85% rouge" },
                ],
            },
            {
                label: "H. Productivité", formula: total("prod"), value: totals.prod, numFmt: NUM,
                children: [
                    {
                        label: "Source", detail: `Feuilles de temps (account_analytic_line) → ${nbProductives} lignes avec Productivité = Oui (feuille Timesheets)`,
                        children: [
                            { label: "Filtre", detail: "Productivité = Oui" },
                            { label: "Filtre", detail: perimetre },
                            { label: "Exclusion", detail: "Lignes « Congé (…) » à 0 CHF (jours fériés fictifs générés par Odoo)" },
                        ],
                    },
                    { label: "Opération", detail: "Σ Heures par collaborateur et par mois (feuille Par collaborateur) → Σ des collaborateurs par mois (feuille Tableau) → Σ des mois" },
                ],
            },
            {
                label: "Taux Productivité (%)", formula: total("taux_prod"), value: tauxProdTotal, numFmt: NUM,
                children: [
                    { label: "Formule", detail: "H. Productivité ÷ H. réalisées × 100" },
                    { label: "H. Productivité", formula: total("prod"), value: totals.prod, numFmt: NUM },
                    { label: "H. réalisées", formula: total("real"), value: totals.real, numFmt: NUM },
                    { label: "Ligne Total", detail: "Σ H. Productivité ÷ Σ H. réalisées" },
                    { label: "Cible", detail: "≥ 100% vert · 80–99% orange · < 80% rouge" },
                ],
            },
            {
                label: "ETP", formula: total("etp"), value: round2(totals.etp), numFmt: NUM,
                children: [
                    {
                        label: "Par mois", detail: "min(1, Σ H. théoriques ÷ Σ Référence 100%), arrondi à 2 décimales (feuille Tableau)",
                        children: [
                            { label: "Référence 100%", detail: "Mêmes segments de contrat, mais à 8h/jour (feuille Segments de contrat)" },
                        ],
                    },
                    { label: "Total", detail: "Somme des ETP mensuels (pas une moyenne)" },
                ],
            },
        ],
        sheets: [tableau, parCollab, timesheets, segmentsSheet, feriesSheet],
    };
}
