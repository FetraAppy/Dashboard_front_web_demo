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

// Export du graphique "Heures théoriques vs Heures réalisées" (onglet Indicateurs Clés), avec les
// données Odoo brutes qui le nourrissent. Chaîne de calcul, uniquement par formules Excel :
//   Timesheets + Segments de contrat (← Contrats, Collaborateurs, Jours fériés)
//     → Par collaborateur → Graphique → arbre de la feuille Informations.
// Les requêtes reprennent exactement les conditions du dashboard (operationnel.controller.ts), et
// le théorique vient du même calcul partagé (services/theo-hours.ts).

/** Même exclusion que "H. réalisées" du dashboard : jours fériés fictifs générés par Odoo. */
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

interface Mesures { theo: number; real: number; variable: number }

export async function exportHeuresTheoriquesRealisees(
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
                    aal.unit_amount AS heures, pp.name AS projet
             FROM staging.account_analytic_line aal
             LEFT JOIN staging.project_project pp ON pp.id = aal.project_id
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
    scope.employees.forEach(e => months.forEach(m => mesures.set(keyOf(e.id, m), { theo: 0, real: 0, variable: 0 })));

    // --- Feuille Timesheets (Odoo : account.analytic.line) -------------------------------------
    const timesheets: DataSheet = {
        name: "Timesheets",
        description: "Lignes de feuille de temps Odoo comptées dans H. réalisées",
        columns: [
            { header: "Date", key: "date", width: 12, numFmt: DATE },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Projet", key: "projet", width: 34 },
            { header: "Libellé", key: "libelle", width: 50 },
            { header: "Heures", key: "heures", width: 9, numFmt: NUM },
        ],
        rows: [],
    };
    tsRes.rows.forEach(r => {
        const emp = empById.get(r.employee_id);
        if (!emp) return;
        const [y, mo, d] = r.date.split("-").map(Number);
        const heures = parseFloat(r.heures) || 0;
        const m = mesures.get(keyOf(emp.id, mo));
        if (m) m.real += heures;
        timesheets.rows.push({
            date: new Date(Date.UTC(y, mo - 1, d)),
            mois: mo,
            collab: emp.name,
            societe: emp.company ?? "",
            projet: r.projet ?? "",
            libelle: r.libelle ?? "",
            heures,
        });
    });

    // --- Feuille Contrats (Odoo : hr.contract + resource.calendar) ------------------------------
    const contrats: DataSheet = {
        name: "Contrats",
        description: "Contrats Odoo (états open et close) des collaborateurs du périmètre, avec leur horaire de travail",
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

    // --- Feuilles Collaborateurs (Odoo : hr.employee) et Segments de contrat --------------------
    const collaborateurs: DataSheet = {
        name: "Collaborateurs",
        description: "Fiche employé Odoo : société, lieu de travail (→ canton des jours fériés) et base du théorique",
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
        ],
        rows: [],
    };
    const cantonsUtilises = new Set<Canton>();
    const unrounded = new Map<string, number>();
    scope.employees.forEach(emp => {
        const canton: Canton = cantonMap[emp.id] || "VD";
        cantonsUtilises.add(canton);
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
                unrounded.set(keyOf(emp.id, s.month + 1), (unrounded.get(keyOf(emp.id, s.month + 1)) ?? 0) + s.hours);
                const joursRef = `(${cellRef(segmentsSheet, "jours_ouvres", i)}-${cellRef(segmentsSheet, "feries", i)})`;
                segmentsSheet.rows.push({
                    collab: emp.name,
                    canton,
                    mois: s.month + 1,
                    debut: toExcelDate(s.from),
                    fin: toExcelDate(s.to),
                    source: sourceLabel,
                    hpj: s.hoursPerDay,
                    jours_ouvres: s.workingDays,
                    feries: s.holidays.length,
                    feries_dates: s.holidays.map(frDate).join(", "),
                    theo: fx(`${joursRef}*${cellRef(segmentsSheet, "hpj", i)}`, s.hours),
                });
            });
    });
    // Arrondi à 2 décimales par collaborateur et par mois, comme le dashboard.
    unrounded.forEach((v, k) => {
        const m = mesures.get(k);
        if (m) m.theo = round2(v);
    });
    // Heure variable PAR PERSONNE : réalisé − théorique seulement si son réalisé du mois est > 0.
    mesures.forEach(m => { m.variable = m.real > 0 ? m.real - m.theo : 0; });

    // --- Feuille Jours fériés (Odoo : resource.calendar.leaves) ---------------------------------
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
            { header: "H. réalisées", key: "real", width: 13, numFmt: NUM },
            { header: "Heure variable", key: "variable", width: 15, numFmt: NUM },
        ],
        rows: [],
    };
    const segSum = (i: number) =>
        `SUMIFS(${columnRange(segmentsSheet, "theo")},${columnRange(segmentsSheet, "collab")},${cellRef(parCollab, "collab", i)},${columnRange(segmentsSheet, "mois")},${cellRef(parCollab, "mois", i)})`;
    const tsSum = (i: number) =>
        `SUMIFS(${columnRange(timesheets, "heures")},${columnRange(timesheets, "collab")},${cellRef(parCollab, "collab", i)},${columnRange(timesheets, "mois")},${cellRef(parCollab, "mois", i)})`;
    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(emp => {
        months.forEach(mois => {
            const i = parCollab.rows.length;
            const m = mesures.get(keyOf(emp.id, mois))!;
            const theoC = cellRef(parCollab, "theo", i);
            const realC = cellRef(parCollab, "real", i);
            parCollab.rows.push({
                collab: emp.name,
                mois,
                mois_nom: MOIS[mois - 1],
                theo: fx(`ROUND(${segSum(i)},2)`, m.theo),
                real: fx(tsSum(i), m.real),
                variable: fx(`IF(${realC}>0,${realC}-${theoC},0)`, m.variable),
            });
        });
    });

    // --- Feuille Graphique (les données du graphique du dashboard) ------------------------------
    const graphique: DataSheet = {
        name: "Graphique",
        description: "Données du graphique « Heures théoriques vs Heures réalisées » (une ligne par mois + Total)",
        columns: [
            { header: "N° mois", key: "mois", width: 9 },
            { header: "Mois", key: "mois_nom", width: 16 },
            { header: "H. théoriques", key: "theo", width: 14, numFmt: NUM },
            { header: "H. réalisées", key: "real", width: 13, numFmt: NUM },
            { header: "Heure variable", key: "variable", width: 15, numFmt: NUM },
            { header: "Cumul variable", key: "cumul", width: 15, numFmt: NUM },
        ],
        rows: [],
        lastRowIsTotal: true,
    };
    const pcSum = (key: string, i: number) =>
        `SUMIFS(${columnRange(parCollab, key)},${columnRange(parCollab, "mois")},${cellRef(graphique, "mois", i)})`;
    const ref = (key: string, i: number) => cellRef(graphique, key, i);
    const totals = { theo: 0, real: 0, variable: 0 };
    months.forEach(mois => {
        const i = graphique.rows.length;
        const agg = { theo: 0, real: 0, variable: 0 };
        scope.employees.forEach(e => {
            const m = mesures.get(keyOf(e.id, mois))!;
            agg.theo += m.theo; agg.real += m.real; agg.variable += m.variable;
        });
        totals.theo += agg.theo; totals.real += agg.real; totals.variable += agg.variable;
        // Comme le dashboard : pas de point de cumul pour un mois sans aucune heure réalisée.
        graphique.rows.push({
            mois,
            mois_nom: MOIS[mois - 1],
            theo: fx(pcSum("theo", i), agg.theo),
            real: fx(pcSum("real", i), agg.real),
            variable: fx(pcSum("variable", i), agg.variable),
            cumul: fx(
                `IF(${ref("real", i)}>0,SUM(${ref("variable", 0)}:${ref("variable", i)}),"—")`,
                agg.real > 0 ? totals.variable : "—"
            ),
        });
    });
    const t = graphique.rows.length; // index de la ligne Total
    const sumCol = (key: string) => `SUM(${ref(key, 0)}:${ref(key, t - 1)})`;
    graphique.rows.push({
        mois: null,
        mois_nom: "Total",
        theo: fx(sumCol("theo"), totals.theo),
        real: fx(sumCol("real"), totals.real),
        variable: fx(sumCol("variable"), totals.variable),
        cumul: null,
    });

    // --- Chemin de calcul (une racine par mesure, valeur = ligne Total du Graphique) ------------
    const total = (key: string) => cellRef(graphique, key, t, true);
    const nbCollab = scope.employees.length;
    const sourcesFeries = [...cantonsUtilises].sort()
        .map(c => `${c} : ${holidaysByCanton[c].source === "odoo" ? "calendrier Odoo" : "formule (Vaud)"}`)
        .join(" · ");
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""}, du ${frDate(new Date(scope.dateFrom))} au ${frDate(new Date(scope.dateTo))}`;
    const exclusion = "Hors lignes « Congé (…) » à 0 CHF (jours fériés fictifs Odoo)";

    return {
        definition: {
            id: "heures-theoriques-realisees",
            titre: "Heures théoriques vs Heures réalisées",
            onglet: "Indicateurs Clés",
            description: "Barres mensuelles (théorique vs réalisé) + ligne de cumul variable",
            metier: "Suivi de la charge de travail par rapport au contrat",
            tables: [
                "staging.account_analytic_line", "staging.project_project", "staging.hr_employee",
                "staging.hr_contract", "staging.resource_calendar", "staging.resource_calendar_leaves",
                "staging.res_company", "kpi.operationnel_suivi_mensuel",
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
                    nom: "Heure variable",
                    description: "Écart réalisé − théorique du mois",
                    metier: "Heures sup. (+) ou déficit (−)",
                    formule: "Σ collaborateurs (H. réalisées − H. théoriques), si H. réalisées > 0",
                    source: "Calculé",
                    commentaire: "Un collaborateur sans heure réalisée ce mois-là compte 0",
                },
                {
                    nom: "Cumul variable",
                    description: "Solde progressif des heures variables",
                    metier: "Banque d'heures accumulée",
                    formule: "Σ des heures variables depuis le 1er mois exporté",
                    source: "Calculé",
                    commentaire: "Pas de point pour un mois sans heure réalisée",
                },
            ],
        },
        derivation: [
            {
                label: "H. théoriques", formula: total("theo"), value: totals.theo, numFmt: NUM,
                children: [
                    { label: "Périmètre", detail: perimetre },
                    { label: "Contrats", detail: `${contrats.rows.length} contrats (Contrats), repli fiche employé sans contrat (Collaborateurs)` },
                    { label: "Jours fériés", detail: `${feriesSheet.rows.length} jours (Jours fériés) — ${sourcesFeries}` },
                    { label: "Par segment", detail: `(j. ouvrés − j. fériés) × h/jour → ${segmentsSheet.rows.length} segments (Segments de contrat)` },
                    { label: "Agrégation", detail: "Σ segments par collaborateur et mois, arrondi 0.01 → Σ par mois (Graphique) → Σ des mois" },
                ],
            },
            {
                label: "H. réalisées", formula: total("real"), value: totals.real, numFmt: NUM,
                children: [
                    { label: "Source", detail: `${timesheets.rows.length} lignes de timesheet (Timesheets)` },
                    { label: "Exclusion", detail: exclusion },
                    { label: "Agrégation", detail: "Σ par collaborateur et mois (Par collaborateur) → Σ par mois (Graphique) → Σ des mois" },
                ],
            },
            {
                label: "Heure variable (solde de la période)", formula: total("variable"), value: totals.variable, numFmt: NUM,
                children: [
                    { label: "Par collaborateur", detail: "H. réalisées − H. théoriques si H. réalisées > 0, sinon 0 (Par collaborateur)" },
                    { label: "Agrégation", detail: "Σ par mois (Graphique) → Σ des mois ; Cumul variable = somme progressive" },
                ],
            },
        ],
        sheets: [graphique, parCollab, timesheets, contrats, collaborateurs, segmentsSheet, feriesSheet],
    };
}
