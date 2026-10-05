import { pool } from "../../../db/pool";
import {
    buildHolidaysByCanton,
    calendarDay,
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

// Export du tableau "Suivi heure variable & Vacances" (onglet Suivi Mensuel & Détails).
//   Heures variable = Σ collaborateurs (H. réalisées − H. théoriques année complète), si
//                      H. réalisées du mois > 0 pour ce collaborateur (calcul PAR PERSONNE,
//                      voir operationnel-dashboard.component.ts) — même métrique que la colonne
//                      "Heure variable" de l'export "Heures théoriques vs Heures réalisées".
//   Vacances prises  = congés validés (type "Paid Time Off"/holiday_status_id=1), répartis jour
//                      ouvré par jour ouvré sur la période du congé.
//   Solde vacances   = allocation totale du périmètre − cumul des vacances prises depuis janvier.
//   Total absences   = toutes les absences validées (tous types dont hr_leave_type.time_type =
//                      'leave', y compris les vacances : même périmètre que le dashboard, les deux
//                      colonnes se recoupent donc partiellement, par construction).
// Chaîne de calcul, par formules Excel :
//   Timesheets + Segments de contrat (← Contrats, Collaborateurs, Jours fériés)
//   + Vacances (jour par jour) + Absences (jour par jour)
//     → Par collaborateur → Suivi heure variable & Vacances.
// Le cumul du solde de vacances part toujours de janvier : les feuilles de données couvrent donc
// janvier → dernier mois du filtre, même si un seul mois est affiché (comme les autres exports).

const NUM = "0.00";
const DATE = "dd.mm.yyyy";

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");
const toExcelDate = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const isoLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const frDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const fx = (formula: string, result: number | string): FormulaCell => ({ formula, result });

/**
 * Congés d'un type donné (vacances ou toutes absences), répartis jour ouvré par jour ouvré entre
 * date_from et date_to de chaque demande validée — même requête que operationnel.controller.ts
 * (générée en SQL via generate_series, une ligne par jour ouvré de chaque congé).
 */
async function loadLeaveDays(
    ids: number[], dataFrom: string, dataTo: string, typeFilter: string
) {
    return (await pool.query(
        `WITH leave_days AS (
             SELECT hl.id AS leave_id, hl.employee_id, hl.number_of_hours, hlt.name AS type_conge,
                    gs.day::date AS day
             FROM staging.hr_leave hl
             JOIN staging.hr_leave_type hlt ON hlt.id = hl.holiday_status_id
             CROSS JOIN LATERAL generate_series(hl.date_from::date, hl.date_to::date, '1 day'::interval) AS gs(day)
             WHERE hl.employee_id = ANY($1::int[])
               AND hl.date_from IS NOT NULL AND hl.date_from <> '' AND hl.date_from <> 'False'
               AND hl.date_to IS NOT NULL AND hl.date_to <> '' AND hl.date_to <> 'False'
               AND hl.state = 'validate'
               AND ${typeFilter}
               AND EXTRACT(DOW FROM gs.day) NOT IN (0, 6)
         ),
         leave_span AS (
             SELECT leave_id, number_of_hours, COUNT(*) AS nb_jours_ouvres
             FROM leave_days GROUP BY leave_id, number_of_hours
         )
         SELECT ld.employee_id, ld.day, ld.type_conge,
                ls.number_of_hours / NULLIF(ls.nb_jours_ouvres, 0) AS heures
         FROM leave_days ld
         JOIN leave_span ls ON ls.leave_id = ld.leave_id
         WHERE ld.day BETWEEN $2::date AND $3::date
         ORDER BY ld.day, ld.employee_id`,
        [ids, dataFrom, dataTo]
    )).rows;
}

/**
 * Allocation de vacances par employé (heures) — même chaîne de repli que le dashboard
 * (operationnel.controller.ts) : staging.hr_leave_allocation (toutes les allocations validées,
 * TOUTE la base, pas seulement le périmètre exporté) en premier ; si cette source ne renvoie
 * STRICTEMENT AUCUNE ligne (pour personne, dans toute l'entreprise), repli sur
 * kpi.operationnel_solde_vacances ; si celle-ci est elle aussi totalement vide, 176h (22 jours)
 * pour chaque employé du périmètre. Un employé absent de la source retenue a une allocation de 0,
 * même si une autre source aurait eu une valeur pour lui — fidèle au comportement du dashboard,
 * qui ne mélange jamais deux sources entre elles.
 */
async function loadAllocationVacances(): Promise<{ map: Record<number, number>; source: string }> {
    try {
        const r = await pool.query(
            `SELECT employee_id, SUM(number_of_days::float) AS jours
             FROM staging.hr_leave_allocation
             WHERE state = 'validate' AND employee_id IS NOT NULL AND number_of_days IS NOT NULL
             GROUP BY employee_id`
        );
        if (r.rows.length > 0) {
            const map: Record<number, number> = {};
            r.rows.forEach(row => { map[row.employee_id] = (parseFloat(row.jours) || 0) * 8; });
            return { map, source: "Allocations validées (module Congés, hr_leave_allocation)" };
        }
    } catch (e: any) {
        console.warn("[export suivi-heure-variable-vacances] hr_leave_allocation indisponible :", e.message);
    }
    try {
        const r = await pool.query(`SELECT employee_id, jours_alloues FROM kpi.operationnel_solde_vacances`);
        if (r.rows.length > 0) {
            const map: Record<number, number> = {};
            r.rows.forEach(row => { map[row.employee_id] = (parseFloat(row.jours_alloues) || 0) * 8; });
            return { map, source: "Repli : dernier calcul Airflow (kpi.operationnel_solde_vacances)" };
        }
    } catch (e: any) {
        console.warn("[export suivi-heure-variable-vacances] operationnel_solde_vacances indisponible :", e.message);
    }
    return { map: {}, source: "Repli : aucune allocation trouvée, 176h (22 jours) par défaut pour chacun" };
}

interface Mesures { theo: number; real: number; variable: number; vacances: number; absences: number }

export async function exportSuiviHeureVariableVacances(
    filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    const { annee } = filters;
    // Mois affichés (filtre) et mois lus : de janvier jusqu'au dernier mois affiché, pour que le
    // solde de vacances cumule correctement même en vue "un seul mois".
    const months = scope.months;
    const dataMonths = Array.from({ length: months[months.length - 1] }, (_, i) => i + 1);
    const dataFrom = `${annee}-01-01`;
    const dataTo = scope.dateTo;

    const [odooHolidays, cantonMap, contractsMap, empFieldsRes, tsRes, allocation, vacRows, absRows] = await Promise.all([
        resolveOdooHolidayEntries(annee),
        loadCantonByEmployee(),
        loadContractsByEmployee(),
        pool.query(
            `SELECT emp.id, rc.hours_per_day, emp.first_contract_date, emp.departure_date
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
               AND NOT (aal.name LIKE 'Congé (%' AND aal.amount = 0)
             ORDER BY aal.date::date, aal.employee_id, aal.id`,
            [scope.employeeIds, dataFrom, dataTo]
        ),
        loadAllocationVacances(),
        // Vacances : type "Paid Time Off" (holiday_status_id = 1), même filtre que le dashboard.
        loadLeaveDays(scope.employeeIds, dataFrom, dataTo, "hl.holiday_status_id = 1"),
        // Absences : TOUS les types d'absence (hr_leave_type.time_type = 'leave') — périmètre plus
        // large que les vacances ci-dessus, qu'il recouvre partiellement (même logique que le
        // dashboard : deux requêtes indépendantes, pas une déduction de l'une à partir de l'autre).
        loadLeaveDays(scope.employeeIds, dataFrom, dataTo, "hlt.time_type = 'leave'"),
    ]);

    const holidaysByCanton = buildHolidaysByCanton(odooHolidays, annee);
    const empFields: Record<number, TheoEmployeeFields> = {};
    empFieldsRes.rows.forEach(r => { empFields[r.id] = r; });
    const empById = new Map(scope.employees.map(e => [e.id, e]));
    const monthSet = new Set(dataMonths);

    const mesures = new Map<string, Mesures>();
    const keyOf = (empId: number, mois: number) => `${empId}|${mois}`;
    scope.employees.forEach(e => dataMonths.forEach(m => mesures.set(keyOf(e.id, m), { theo: 0, real: 0, variable: 0, vacances: 0, absences: 0 })));

    // --- Feuille Timesheets (Odoo : account.analytic.line) -------------------------------------
    const timesheets: DataSheet = {
        name: "Timesheets",
        description: "Lignes de feuille de temps comptées dans H. réalisées (depuis janvier, pour le solde de vacances)",
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

    // --- Feuilles Vacances et Absences (jour par jour) ------------------------------------------
    const buildLeaveSheet = (name: string, description: string, rows: any[], accKey: "vacances" | "absences"): DataSheet => {
        const sheet: DataSheet = {
            name,
            description,
            columns: [
                { header: "Date", key: "date", width: 12, numFmt: DATE },
                { header: "Mois", key: "mois", width: 7 },
                { header: "Collaborateur", key: "collab", width: 28 },
                { header: "Société", key: "societe", width: 24 },
                { header: "Type de congé", key: "type", width: 30 },
                { header: "Heures ce jour", key: "heures", width: 14, numFmt: NUM },
            ],
            rows: [],
        };
        rows.forEach(r => {
            const emp = empById.get(r.employee_id);
            if (!emp) return;
            const d: Date = r.day instanceof Date ? r.day : new Date(r.day);
            const mois = d.getUTCMonth() + 1;
            if (!monthSet.has(mois)) return;
            const heures = parseFloat(r.heures) || 0;
            const m = mesures.get(keyOf(emp.id, mois));
            if (m) m[accKey] += heures;
            sheet.rows.push({
                date: toExcelDate(d),
                mois,
                collab: emp.name,
                societe: emp.company ?? "",
                type: r.type_conge ?? "",
                heures,
            });
        });
        return sheet;
    };
    const vacances = buildLeaveSheet(
        "Vacances", "Jours ouvrés de congés « Paid Time Off » validés, répartis jour par jour sur la période du congé", vacRows, "vacances"
    );
    const absencesSheet = buildLeaveSheet(
        "Absences", "Jours ouvrés de toutes les absences validées (congés, maladie…), répartis jour par jour — recoupe en partie la feuille Vacances", absRows, "absences"
    );

    // --- Feuille Jours fériés (Odoo : resource.calendar.leaves) ---------------------------------
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
            .filter(e => isoLocal(e.date) >= dataFrom && isoLocal(e.date) <= dataTo)
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

    // --- Feuille Collaborateurs (allocation de vacances incluse) -------------------------------
    const collaborateurs: DataSheet = {
        name: "Collaborateurs",
        description: "Fiche employé Odoo : société, lieu de travail (→ canton des jours fériés), base du théorique et allocation de vacances",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Canton", key: "canton", width: 8 },
            { header: "1er contrat", key: "premier", width: 12, numFmt: DATE },
            { header: "Départ", key: "depart", width: 12, numFmt: DATE },
            { header: "Théorique calculé d'après", key: "source", width: 24 },
            { header: "Allocation vacances (h)", key: "allocation", width: 20, numFmt: NUM },
        ],
        rows: [],
    };

    // --- Feuille Segments de contrat (théorique année complète, comme variableHoursMonth) ------
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
    const unrounded = new Map<string, number>();
    scope.employees.forEach(emp => {
        const canton = cantonOf(emp.id);
        const fields = empFields[emp.id] ?? { hours_per_day: null, first_contract_date: null, departure_date: null };
        const { periods, source } = theoPeriodsForEmployee(contractsMap[emp.id], fields, annee);
        const sourceLabel = source === "contrat" ? "Contrat" : "Fiche employé";

        collaborateurs.rows.push({
            collab: emp.name,
            societe: emp.company ?? "",
            canton,
            premier: (() => { const d = calendarDay(fields.first_contract_date); return d ? toExcelDate(d) : null; })(),
            depart: (() => { const d = calendarDay(fields.departure_date); return d ? toExcelDate(d) : null; })(),
            source: sourceLabel,
            allocation: round2(allocation.map[emp.id] ?? 0),
        });

        // Année complète (toDate=false), comme theoFullYear utilisé par variableHoursMonth.
        computeTheoSegments(periods, annee, holidaysByCanton[canton].fullYear, false)
            .filter(s => monthSet.has(s.month + 1))
            .forEach(s => {
                const i = segmentsSheet.rows.length;
                unrounded.set(keyOf(emp.id, s.month + 1), (unrounded.get(keyOf(emp.id, s.month + 1)) ?? 0) + s.hours);
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
                    jours_ouvres: fx(`NETWORKDAYS(${seg("debut")},${seg("fin")})`, s.workingDays),
                    feries: fx(
                        `COUNTIFS(${columnRange(feriesSheet, "date")},">="&${seg("debut")},${columnRange(feriesSheet, "date")},"<="&${seg("fin")},`
                        + `${columnRange(feriesSheet, "canton")},${seg("canton")},${columnRange(feriesSheet, "ouvre")},"Oui")`,
                        s.holidays.length
                    ),
                    feries_dates: s.holidays.map(frDate).join(", "),
                    theo: fx(`${joursRef}*${seg("hpj")}`, s.hours),
                });
            });
    });
    unrounded.forEach((v, k) => {
        const m = mesures.get(k);
        if (m) m.theo = round2(v);
    });
    // Heure variable PAR PERSONNE : réalisé − théorique seulement si son réalisé du mois est > 0.
    mesures.forEach(m => { m.variable = m.real > 0 ? m.real - m.theo : 0; });

    // --- Feuille Par collaborateur --------------------------------------------------------------
    const parCollab: DataSheet = {
        name: "Par collaborateur",
        description: "Mesures par collaborateur et par mois, sommées depuis Timesheets, Segments de contrat, Vacances et Absences",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Nom du mois", key: "mois_nom", width: 12 },
            { header: "H. théoriques", key: "theo", width: 14, numFmt: NUM },
            { header: "H. réalisées", key: "real", width: 13, numFmt: NUM },
            { header: "Heure variable", key: "variable", width: 15, numFmt: NUM },
            { header: "Vacances prises", key: "vacances", width: 15, numFmt: NUM },
            { header: "Total absences", key: "absences", width: 15, numFmt: NUM },
        ],
        rows: [],
    };
    const segSum = (i: number) =>
        `SUMIFS(${columnRange(segmentsSheet, "theo")},${columnRange(segmentsSheet, "collab")},${cellRef(parCollab, "collab", i)},${columnRange(segmentsSheet, "mois")},${cellRef(parCollab, "mois", i)})`;
    const tsSum = (i: number) =>
        `SUMIFS(${columnRange(timesheets, "heures")},${columnRange(timesheets, "collab")},${cellRef(parCollab, "collab", i)},${columnRange(timesheets, "mois")},${cellRef(parCollab, "mois", i)})`;
    const leaveSum = (feuille: DataSheet, i: number) =>
        `SUMIFS(${columnRange(feuille, "heures")},${columnRange(feuille, "collab")},${cellRef(parCollab, "collab", i)},${columnRange(feuille, "mois")},${cellRef(parCollab, "mois", i)})`;
    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(emp => {
        dataMonths.forEach(mois => {
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
                vacances: fx(leaveSum(vacances, i), round2(m.vacances)),
                absences: fx(leaveSum(absencesSheet, i), round2(m.absences)),
            });
        });
    });

    // --- Feuille Suivi heure variable & Vacances (les données du tableau du dashboard) ---------
    const suivi: DataSheet = {
        name: "Suivi heure variable & Vacances",
        description: "Données du tableau « Suivi heure variable & Vacances » (une ligne par mois du filtre + Total/Période)",
        columns: [
            { header: "N° mois", key: "mois", width: 9 },
            { header: "Mois", key: "mois_nom", width: 16 },
            { header: "Heures variable", key: "variable", width: 16, numFmt: NUM },
            { header: "Vacances prises", key: "vacances", width: 16, numFmt: NUM },
            { header: "Solde vacances", key: "solde", width: 16, numFmt: NUM },
            { header: "Total absences", key: "absences", width: 16, numFmt: NUM },
        ],
        rows: [],
        lastRowIsTotal: true,
    };
    const pcSum = (key: string, i: number) =>
        `SUMIFS(${columnRange(parCollab, key)},${columnRange(parCollab, "mois")},${cellRef(suivi, "mois", i)})`;
    const pcSumCumul = (key: string, i: number) =>
        `SUMIFS(${columnRange(parCollab, key)},${columnRange(parCollab, "mois")},"<="&${cellRef(suivi, "mois", i)})`;
    const allocationTotale = scope.employees.reduce((s, e) => s + round2(allocation.map[e.id] ?? 0), 0);

    // Agrégats par mois sur TOUS les mois de données (dataMonths, depuis janvier) : le solde de
    // vacances cumule depuis janvier même quand un seul mois est affiché (scope.months) — comme
    // pour le cumul de "Suivi de l'objectif mensuel". Calculer le cumul uniquement sur les mois
    // affichés aurait recommencé à 0 à chaque mois filtré au lieu de partir de janvier.
    const aggParMois = new Map<number, { variable: number; vacances: number; absences: number }>();
    dataMonths.forEach(mois => {
        const agg = { variable: 0, vacances: 0, absences: 0 };
        scope.employees.forEach(e => {
            const m = mesures.get(keyOf(e.id, mois))!;
            agg.variable += m.variable; agg.vacances += round2(m.vacances); agg.absences += round2(m.absences);
        });
        aggParMois.set(mois, agg);
    });
    let cumulCourant = 0;
    const cumulParMois = new Map<number, number>();
    dataMonths.forEach(mois => {
        cumulCourant += aggParMois.get(mois)!.vacances;
        cumulParMois.set(mois, cumulCourant);
    });

    const totals = { variable: 0, vacances: 0, absences: 0 };
    months.forEach(mois => {
        const i = suivi.rows.length;
        const agg = aggParMois.get(mois)!;
        totals.variable += agg.variable; totals.vacances += agg.vacances; totals.absences += agg.absences;
        suivi.rows.push({
            mois,
            mois_nom: MOIS[mois - 1],
            variable: fx(pcSum("variable", i), round2(agg.variable)),
            vacances: fx(pcSum("vacances", i), round2(agg.vacances)),
            // Solde = allocation totale du périmètre − cumul des vacances prises depuis janvier.
            solde: fx(
                `${allocationTotale}-${pcSumCumul("vacances", i)}`,
                round2(allocationTotale - cumulParMois.get(mois)!)
            ),
            absences: fx(pcSum("absences", i), round2(agg.absences)),
        });
    });
    const t = suivi.rows.length;
    const sumCol = (key: string) => `SUM(${cellRef(suivi, key, 0)}:${cellRef(suivi, key, t - 1)})`;
    const soldeFinal = allocationTotale - cumulParMois.get(months[months.length - 1])!;
    suivi.rows.push({
        mois: null,
        mois_nom: "Total / Période",
        variable: fx(sumCol("variable"), round2(totals.variable)),
        vacances: fx(sumCol("vacances"), round2(totals.vacances)),
        // Solde de fin de période : celui de la dernière ligne, pas une somme (comme le dashboard).
        solde: fx(cellRef(suivi, "solde", t - 1), round2(soldeFinal)),
        absences: fx(sumCol("absences"), round2(totals.absences)),
    });

    // --- Chemin de calcul ------------------------------------------------------------------------
    const total = (key: string) => cellRef(suivi, key, t, true);
    const nbCollab = scope.employees.length;
    const sourcesFeries = [...cantonsUtilises].sort()
        .map(c => `${c} : ${holidaysByCanton[c].source === "odoo" ? "calendrier Odoo" : "formule (Vaud)"}`)
        .join(" · ");
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""}, du ${frDate(new Date(scope.dateFrom))} au ${frDate(new Date(scope.dateTo))}`
        + (filters.mois && filters.mois > 1 ? ` (données depuis le 01.01.${annee} pour le solde de vacances)` : "");

    return {
        definition: {
            id: "suivi-heure-variable-vacances",
            titre: "Suivi heure variable & Vacances",
            onglet: "Suivi Mensuel & Détails",
            description: "Absences, soldes de vacances restants et écarts horaires",
            tables: [
                "staging.account_analytic_line", "staging.project_project", "staging.hr_employee",
                "staging.hr_contract", "staging.resource_calendar", "staging.resource_calendar_leaves",
                "staging.hr_leave", "staging.hr_leave_type", "staging.hr_leave_allocation",
                "staging.res_company", "kpi.operationnel_suivi_mensuel", "kpi.operationnel_solde_vacances",
            ],
            colonnes: [
                {
                    nom: "Heures variable",
                    description: "Écart réalisé − théorique du mois",
                    metier: "Heures sup. (+) ou déficit (−)",
                    formule: "Σ collaborateurs (H. réalisées − H. théoriques), si H. réalisées > 0",
                    source: "Timesheets + Segments de contrat",
                    commentaire: "Un collaborateur sans heure réalisée ce mois-là compte 0",
                },
                {
                    nom: "Vacances prises",
                    description: "Congés payés validés, répartis par mois",
                    metier: "Consommation réelle du droit aux congés",
                    formule: "Σ heures de congé « Paid Time Off » validé, jour ouvré par jour ouvré",
                    source: "Module Congés (Time Off)",
                    commentaire: "Un congé à cheval sur deux mois répartit ses heures sur chacun au prorata des jours ouvrés",
                },
                {
                    nom: "Solde vacances",
                    description: "Compteur de congés restants",
                    metier: "« Combien il me reste de vacances »",
                    formule: "Allocation totale − Σ Vacances prises depuis janvier",
                    source: "Allocations validées, voir feuille Collaborateurs",
                    commentaire: "Cumul depuis janvier affiché, peut devenir négatif si plus pris qu'alloué",
                },
                {
                    nom: "Total absences",
                    description: "Toutes absences validées (congés, maladie, autres)",
                    metier: "Vue large de l'indisponibilité",
                    formule: "Σ heures d'absence validée, tous types, jour ouvré par jour ouvré",
                    source: "Module Congés, tous types d'absence",
                    commentaire: "Recoupe en partie « Vacances prises » (périmètre plus large, pas un complément)",
                },
            ],
        },
        derivation: [
            {
                label: "Heures variable (période)", formula: total("variable"), value: round2(totals.variable), numFmt: NUM,
                children: [
                    { label: "Périmètre", detail: perimetre },
                    { label: "Contrats", detail: `Repli fiche employé sans contrat (Collaborateurs) ; ${segmentsSheet.rows.length} segments (Segments de contrat)` },
                    { label: "Jours fériés", detail: `${feriesSheet.rows.length} jours (Jours fériés) — ${sourcesFeries}` },
                    { label: "H. réalisées", detail: `${timesheets.rows.length} lignes de timesheet (Timesheets), hors lignes « Congé (…) » à 0 CHF (jours fériés fictifs Odoo)` },
                    { label: "Par collaborateur", detail: "H. réalisées − H. théoriques si H. réalisées > 0, sinon 0 (Par collaborateur)" },
                    { label: "Agrégation", detail: "Σ par mois (Suivi heure variable & Vacances) → Σ des mois affichés" },
                ],
            },
            {
                label: "Vacances prises (période)", formula: total("vacances"), value: round2(totals.vacances), numFmt: NUM,
                children: [
                    { label: "Source", detail: `${vacances.rows.length} jours ouvrés de congé « Paid Time Off » (Vacances)` },
                    { label: "Agrégation", detail: "Σ par collaborateur et mois (Par collaborateur) → Σ par mois → Σ des mois affichés" },
                ],
            },
            {
                label: "Solde vacances (fin de période)", formula: total("solde"), value: round2(soldeFinal), numFmt: NUM,
                children: [
                    { label: "Allocation", detail: `${round2(allocationTotale)}h au total pour le périmètre (feuille Collaborateurs) — ${allocation.source}` },
                    { label: "Calcul", detail: "Allocation totale − Σ Vacances prises de janvier au dernier mois affiché" },
                ],
            },
            {
                label: "Total absences (période)", formula: total("absences"), value: round2(totals.absences), numFmt: NUM,
                children: [
                    { label: "Source", detail: `${absencesSheet.rows.length} jours ouvrés d'absence validée, tous types (Absences)` },
                    { label: "Agrégation", detail: "Σ par collaborateur et mois (Par collaborateur) → Σ par mois → Σ des mois affichés" },
                ],
            },
        ],
        sheets: [suivi, parCollab, timesheets, vacances, absencesSheet, collaborateurs, segmentsSheet, feriesSheet],
    };
}
