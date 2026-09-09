import { Request, Response } from "express";
import { pool } from "../db/pool";

// ---------------------------------------------------------------------------
// Vaud (Lausanne) public holidays calculation
// ---------------------------------------------------------------------------

function computEaster(year: number): Date {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
}

function jeuneFederalMonday(year: number): Date {
    // 3rd Sunday of September → following Monday
    const sept1 = new Date(year, 8, 1);
    const dow = sept1.getDay();
    const daysToFirstSun = (7 - dow) % 7;
    const firstSun = daysToFirstSun === 0 ? 1 : 1 + daysToFirstSun;
    const thirdSun = firstSun + 14;
    return new Date(year, 8, thirdSun + 1);
}

function addDays(date: Date, n: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
}

function isWeekend(d: Date): boolean {
    const dow = d.getDay();
    return dow === 0 || dow === 6;
}

/**
 * Dates des jours fériés vaudois d'une année, filtrées week-ends (et dates futures si
 * toDate=true, comportement par défaut — utilisé pour les graphiques/tableaux mensuels).
 * toDate=false renvoie les 9 jours fériés de l'année complète, sans coupure à aujourd'hui —
 * utilisé pour les totaux annuels du panneau Synthèse (H. théoriques annuelles, Jours
 * fériés calculés), qui doivent représenter l'année entière, pas "à ce jour" (vérifié
 * contre une feuille de référence RH : ces totaux couvrent les 12 mois même en cours d'année).
 * Base commune pour computeVaudHolidays (référence 1 personne) et
 * computeTheoMensuelEmployee (prorata réel par employé).
 */
function getVaudHolidayDates(year: number, toDate: boolean = true): Date[] {
    const paques = computEaster(year);
    const now = new Date();

    const holidays: Date[] = [
        new Date(year, 0, 1),        // Nouvel An
        new Date(year, 0, 2),        // Saint-Berthold
        addDays(paques, -2),          // Vendredi Saint
        addDays(paques, 1),           // Lundi de Pâques
        addDays(paques, 39),          // Ascension
        addDays(paques, 50),          // Lundi de Pentecôte
        new Date(year, 7, 1),         // Fête nationale
        jeuneFederalMonday(year),     // Lundi du Jeûne fédéral
        new Date(year, 11, 25),       // Noël
    ];

    return holidays.filter(h => !isWeekend(h) && (!toDate || h <= now));
}

/** Convertit une liste de dates de jours fériés en répartition mensuelle (8h/jour). */
function holidaysToMonthly(dates: Date[]): { parMois: number[]; totalHeures: number } {
    const parMois = Array<number>(12).fill(0);
    let totalHeures = 0;

    for (const h of dates) {
        parMois[h.getMonth()] += 8;
        totalHeures += 8;
    }

    return { parMois, totalHeures };
}

function computeVaudHolidays(year: number, toDate: boolean = true): { parMois: number[]; totalHeures: number } {
    return holidaysToMonthly(getVaudHolidayDates(year, toDate));
}

// Libellés de resource.calendar.leaves connus comme n'étant PAS des fériés vaudois, à exclure.
// Repéré en explorant les données réelles Odoo : "Jeûne genevois" est un férié du canton de
// Genève, pas de Vaud. À compléter si d'autres cas apparaissent (voir docs/JOURS_FERIES_ODOO.md).
const NON_VAUD_HOLIDAY_NAMES = ['Jeûne genevois'];

/**
 * Jours fériés réels de l'année, lus depuis le vrai calendrier Odoo
 * (staging.resource_calendar_leaves), dédupliqués par date — chaque jour férié existe en 5 à 6
 * exemplaires identiques dans Odoo (imports répétés) — et filtrés sur les congés globaux
 * (resource_id vide, hors congés individuels) en excluant les libellés non-vaudois connus.
 * Renvoie TOUTES les dates officielles, y compris celles tombant un week-end (ex. 1er août 2026
 * tombe un samedi) : c'est à l'appelant de filtrer par jour de semaine selon le besoin (info
 * calendrier brute vs déduction réelle des heures théoriques).
 * Renvoie null si la table n'existe pas encore, ou si Odoo n'a aucune donnée pour cette année
 * (constaté pour 2025 et les années antérieures — seules 2026/2027 sont paramétrées à ce jour) :
 * dans ce cas, l'appelant doit retomber sur getVaudHolidayDates() (calcul par formule).
 */
async function resolveOdooHolidayDates(annee: number): Promise<Date[] | null> {
    try {
        const placeholders = NON_VAUD_HOLIDAY_NAMES.map((_, i) => `$${i + 2}`).join(', ');
        const res = await pool.query(
            `SELECT DISTINCT date_from::date AS d
             FROM staging.resource_calendar_leaves
             WHERE (resource_id IS NULL OR resource_id::text IN ('', 'False'))
               AND name NOT IN (${placeholders})
               AND EXTRACT(YEAR FROM date_from::date) = $1`,
            [annee, ...NON_VAUD_HOLIDAY_NAMES]
        );
        if (res.rows.length === 0) return null;
        return res.rows.map(r => new Date(r.d));
    } catch (_) {
        return null; // table pas encore extraite (avant premier run du DAG stage1_hr), fallback silencieux
    }
}

function computeMonthlyTheo(
    year: number, feriesParMois: number[], toDate: boolean = true
): { parMois: number[]; totalAnnuel: number } {
    const now = new Date();
    const isCurrentYear = now.getFullYear() === year;
    const currentMonth = now.getMonth();
    const today = now.getDate();

    const parMois = Array<number>(12).fill(0);
    let totalAnnuel = 0;

    for (let m = 0; m < 12; m++) {
        if (toDate && year > now.getFullYear()) break; // future year → all zeros
        if (toDate && isCurrentYear && m > currentMonth) continue; // future month → 0

        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const lastDay = (toDate && isCurrentYear && m === currentMonth) ? today : daysInMonth;
        let workingDays = 0;
        for (let d = 1; d <= lastDay; d++) {
            const dow = new Date(year, m, d).getDay();
            if (dow !== 0 && dow !== 6) workingDays++;
        }
        const theo = (workingDays * 8) - feriesParMois[m];
        parMois[m] = theo;
        totalAnnuel += theo;
    }

    return { parMois, totalAnnuel };
}

/**
 * Heures théoriques mensuelles par employé :
 * resource_calendar.hours_per_day × (jours ouvrés lun–ven − jours fériés vaudois),
 * avec prorata d'arrivée (first_contract_date) et de départ (departure_date),
 * et cutoff à la date du jour (mois courant / mois futurs).
 * Les fériés ne sont déduits que s'ils tombent dans la fenêtre où l'employé est
 * effectivement sous contrat ce mois-là (pas de déduction avant l'embauche/après le
 * départ) — contrairement à l'ancien calcul global qui appliquait un forfait plat
 * (8h × effectif brut) sans tenir compte du temps partiel ni des entrées/sorties.
 * toDate=false calcule l'année complète (mois futurs inclus, pas de coupure à aujourd'hui) —
 * utilisé pour "H. théoriques annuelles" du panneau Synthèse (voir getVaudHolidayDates).
 */
function computeTheoMensuelEmployee(
    emp: { hours_per_day: string | number | null; first_contract_date: string | null; departure_date: string | null },
    year: number,
    holidayDates: Date[],
    toDate: boolean = true
): number[] {
    const hpd = parseFloat(String(emp.hours_per_day ?? '')) || 8;
    const now = new Date();
    const isCurrentYear = now.getFullYear() === year;

    const parseDate = (s: string | null): Date | null => {
        if (!s || s === 'False') return null;
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    };
    const startDt = parseDate(emp.first_contract_date);
    const endDt = parseDate(emp.departure_date);

    const parMois = Array<number>(12).fill(0);
    for (let m = 0; m < 12; m++) {
        if (toDate && year > now.getFullYear()) break; // future year → all zeros
        if (toDate && isCurrentYear && m > now.getMonth()) continue; // future month → 0

        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const lastDay = (toDate && isCurrentYear && m === now.getMonth()) ? now.getDate() : daysInMonth;
        const d1 = new Date(year, m, 1);
        const d2 = new Date(year, m, lastDay);

        if (startDt && startDt > d2) continue; // embauché après la fin du mois
        if (endDt && endDt < d1) continue;     // parti avant le début du mois

        const from = startDt && startDt > d1 ? startDt : d1;
        const to = endDt && endDt < d2 ? endDt : d2;

        let workingDays = 0;
        for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
            const dow = d.getDay();
            if (dow !== 0 && dow !== 6) workingDays++;
        }
        const feriesDansFenetre = holidayDates.filter(h => h >= from && h <= to).length;
        parMois[m] = Math.round((workingDays - feriesDansFenetre) * hpd * 100) / 100;
    }

    return parMois;
}

export async function getDashboardData(req: Request, res: Response) {
    try {
        const annee = parseInt(req.query.annee as string) || 2026;
        const now = new Date();

        // 1 & 2. Query synthesis params, active employees, et le vrai calendrier Odoo en parallèle
        const [syntheseRes, employeesRes, odooHolidays] = await Promise.all([
            pool.query(
                `SELECT * FROM kpi.operationnel_synthese_annuelle WHERE annee = $1 LIMIT 1`,
                [annee]
            ),
            pool.query(
                `SELECT DISTINCT emp.id, emp.name,
                        rc.hours_per_day,
                        emp.first_contract_date,
                        emp.departure_date,
                        emp.department_id,
                        dept.name AS department_name
                 FROM kpi.operationnel_suivi_mensuel osm
                 JOIN staging.hr_employee emp ON osm.employee_id = emp.id
                 LEFT JOIN staging.resource_calendar rc ON emp.resource_calendar_id = rc.id
                 LEFT JOIN staging.hr_department dept ON dept.id = emp.department_id
                 WHERE osm.annee = $1
                 ORDER BY emp.name`,
                [annee]
            ),
            resolveOdooHolidayDates(annee)
        ]);

        // Jours fériés : source réelle Odoo si disponible pour l'année demandée (dédupliquée,
        // hors libellés non-vaudois), sinon calcul par formule (getVaudHolidayDates). Voir
        // docs/JOURS_FERIES_ODOO.md pour le détail de cette décision.
        let holidayDates: Date[];             // fériés ouvrés, "à ce jour" — graphiques/tableaux mensuels
        let holidayDatesFullYear: Date[];     // fériés ouvrés, année complète — H. théoriques annuelles
        let holidayDatesRawFullYear: Date[];  // TOUTES les dates officielles (même week-end) — Jours fériés calculés
        if (odooHolidays) {
            const weekdaysOnly = odooHolidays.filter(h => !isWeekend(h));
            holidayDates = weekdaysOnly.filter(h => h <= now);
            holidayDatesFullYear = weekdaysOnly;
            holidayDatesRawFullYear = odooHolidays;
        } else {
            holidayDates = getVaudHolidayDates(annee);
            holidayDatesFullYear = getVaudHolidayDates(annee, false);
            holidayDatesRawFullYear = holidayDatesFullYear;
        }

        const synthese = syntheseRes.rows[0] || {
            annee,
            tarif_horaire_chf: 180,
            heures_theoriques_annuelles: 2016,
            ca_budget_annuel_chf: 0,
            objectif_productivite_pct: 75,
            devise: "CHF"
        };
        const employees = employeesRes.rows;

        // Query employee annual budgets (safe fallback if table doesn't exist yet)
        const empBudgetMap: Record<number, number> = {};
        try {
            const budgetRes = await pool.query(
                `SELECT employee_id, budget_chf
                 FROM kpi.operationnel_budget_employe
                 WHERE annee = $1`,
                [annee]
            );
            budgetRes.rows.forEach(b => {
                empBudgetMap[b.employee_id] = parseFloat(b.budget_chf) || 0;
            });
        } catch (_) {
            // Table may not exist yet (before first Airflow run); use default budgets
        }

        // Query per-employee vacation allocation (days → hours × 8)
        // Chaîne de secours : table KPI → staging.hr_leave_allocation → défaut 22 jours (176h)
        const empVacMap: Record<number, number> = {};
        const vacSources: (() => Promise<boolean>)[] = [
            async () => {
                const res = await pool.query(
                    `SELECT employee_id, jours_alloues
                     FROM kpi.operationnel_solde_vacances`
                );
                if (res.rows.length === 0) return false;
                res.rows.forEach(v => {
                    empVacMap[v.employee_id] = (parseFloat(v.jours_alloues) || 0) * 8;
                });
                return true;
            },
            async () => {
                const res = await pool.query(
                    `SELECT employee_id, SUM(number_of_days::float) AS jours
                     FROM staging.hr_leave_allocation
                     WHERE state = 'validate'
                       AND employee_id IS NOT NULL
                       AND number_of_days IS NOT NULL
                     GROUP BY employee_id`
                );
                if (res.rows.length === 0) return false;
                res.rows.forEach(v => {
                    empVacMap[v.employee_id] = (parseFloat(v.jours) || 0) * 8;
                });
                return true;
            }
        ];
        for (const source of vacSources) {
            try {
                if (await source()) break;
            } catch (e: any) {
                console.warn('[operationnel] solde vacances — source indisponible:', e.message);
            }
        }
        if (Object.keys(empVacMap).length === 0) {
            // Aucune allocation trouvée → défaut 22 jours (176h) par employé
            console.warn('[operationnel] solde vacances — aucune allocation trouvée, défaut 176h/employé');
            employees.forEach(e => { empVacMap[e.id] = 176; });
        }

        // Query per-employee average billing rate from sale order lines linked via timesheets
        const empTarifMap: Record<number, number> = {};
        try {
            const tarifRes = await pool.query(
                `SELECT
                   aal.employee_id,
                   ROUND(SUM(aal.unit_amount * sol.price_unit) / NULLIF(SUM(aal.unit_amount), 0), 2) AS tarif_moyen
                 FROM staging.account_analytic_line aal
                 JOIN staging.sale_order_line sol ON aal.so_line = sol.id
                 WHERE aal.employee_id IS NOT NULL
                   AND aal.so_line IS NOT NULL
                   AND aal.date IS NOT NULL
                   AND EXTRACT(YEAR FROM aal.date::date) = $1
                   AND aal.unit_amount > 0
                 GROUP BY aal.employee_id`,
                [annee]
            );
            tarifRes.rows.forEach(r => {
                empTarifMap[r.employee_id] = parseFloat(r.tarif_moyen) || 0;
            });
        } catch (_) {
            // Table may not exist yet or so_line not extracted yet
        }

        // Query xx_hourly_price from hr_employee (fallback billing rate)
        const empPriceMap: Record<number, number> = {};
        try {
            const priceRes = await pool.query(
                `SELECT id, xx_hourly_price FROM staging.hr_employee WHERE xx_hourly_price IS NOT NULL AND xx_hourly_price > 0`
            );
            priceRes.rows.forEach(r => {
                empPriceMap[r.id] = parseFloat(r.xx_hourly_price) || 0;
            });
        } catch (_) {
            // Table may not have the field yet
        }

        // Query ETP (taux d'activité individuel, ex. 0.8 pour un 80%) depuis le contrat actif.
        // DISTINCT ON sans second critère de tri était non-déterministe : si un employé a
        // plusieurs lignes hr_contract à l'état 'open', Postgres pouvait piocher n'importe
        // laquelle selon le plan d'exécution → ETP individuel incohérent d'une exécution à
        // l'autre (cas rapporté : BARBEN Thibaut). Ajout de `date_start DESC` pour retenir
        // systématiquement le contrat le plus récent.
        const empEtpMap: Record<number, number> = {};
        try {
            const etpRes = await pool.query(
                `SELECT DISTINCT ON (c.employee_id)
                   c.employee_id,
                   COALESCE(rc.hours_per_day, 8) / 8.0 AS etp
                 FROM staging.hr_contract c
                 LEFT JOIN staging.resource_calendar rc ON c.resource_calendar_id = rc.id
                 WHERE (c.state IS NULL OR c.state = 'open')
                 ORDER BY c.employee_id, c.date_start::date DESC NULLS LAST`
            );
            etpRes.rows.forEach(r => {
                empEtpMap[r.employee_id] = parseFloat(r.etp) || 1;
            });
        } catch (_) {
            // Tables may not exist yet
        }

        // Map employee ID to Name for quick lookup
        const empNameMap: Record<number, string> = {};
        const collab: Record<string, any> = {};

        employees.forEach(emp => {
            const annualBudget = empBudgetMap[emp.id] || parseFloat(synthese.ca_budget_annuel_chf) || 0;
            const monthlyBudget = annualBudget / 12;
            const vacInitH = empVacMap[emp.id] || 0;
            empNameMap[emp.id] = emp.name;
            collab[emp.name] = {
                real: Array(12).fill(0),
                ca_real: Array(12).fill(0),
                billable: Array(12).fill(0),
                theo: computeTheoMensuelEmployee(emp, annee, holidayDates),
                // Théorique année complète (pas de coupure à aujourd'hui) — sert uniquement à
                // "H. théoriques annuelles" du panneau Synthèse (voir toDate=false ci-dessus).
                theoFullYear: computeTheoMensuelEmployee(emp, annee, holidayDatesFullYear, false),
                ca_bud: Array(12).fill(monthlyBudget),
                ca_budget_annuel: annualBudget,
                vac_m: Array(12).fill(0),
                mal_m: Array(12).fill(0),
                abs_m: Array(12).fill(0),
                vac_init: vacInitH,
                non_fact: {
                    admin: Array(12).fill(0), vacances: Array(12).fill(0), rh_it: Array(12).fill(0),
                    marketing: Array(12).fill(0), formation: Array(12).fill(0), maladie: Array(12).fill(0)
                },
                // Priorité à xx_hourly_price (empPriceMap) : c'est le tarif de référence RH
                // saisi sur la fiche employé Odoo ("Hourly Price"), pas la moyenne des prix de
                // vente réels (empTarifMap) qui varie selon les mandats facturés. Vérifié sur
                // AGACHII Igor : xx_hourly_price=180 correspond exactement au "CA Brut" de
                // référence (981h × 180 = 176'580), alors que sa moyenne de vente réelle
                // (560.70) n'a aucun rapport avec ce total.
                tarif_moyen: empPriceMap[emp.id] || empTarifMap[emp.id] || parseFloat(synthese.tarif_horaire_chf) || 180,
                etp: empEtpMap[emp.id] || 1,
                department: emp.department_name || null
            };
        });

        // Liste des départements présents, pour peupler le filtre côté frontend
        const departments = Array.from(
            new Set(employees.map(emp => emp.department_name).filter((d): d is string => !!d))
        ).sort();

        // 3-8. Run the 7 independent queries (tracking, billable, vacations, illnesses, absences, non-facturable, repartition) in parallel
        const [trackingRes, billableRes, vacRes, malRes, absRes, nonFactRes, repartitionRes] = await Promise.all([
            // 3. Monthly hours & ca tracking
            pool.query(
                `SELECT employee_id, mois, heures_realisees, ca_realise_chf, ca_budget_chf, heures_theoriques
                 FROM kpi.operationnel_suivi_mensuel
                 WHERE annee = $1
                 ORDER BY employee_id, mois`,
                [annee]
            ),
            // 4. Billable hours from account_analytic_line (amount < 0)
            pool.query(
                `SELECT
                   employee_id,
                   EXTRACT(MONTH FROM date::date)::int as mois,
                   SUM(unit_amount) as hours
                 FROM staging.account_analytic_line
                 WHERE date IS NOT NULL
                   AND employee_id IS NOT NULL
                   AND amount < 0
                   AND EXTRACT(YEAR FROM date::date)::int = $1
                 GROUP BY employee_id, mois`,
                [annee]
            ),
            // 5. Vacations from hr_leave (holiday_status_id = 1)
            // Réparties jour par jour (jours ouvrés uniquement) entre date_from et date_to,
            // au lieu de tout compter sur le mois de date_from — un congé du 20/06 au 05/07
            // comptait auparavant ses 15 jours entièrement en juin, 0 en juillet.
            pool.query(
                `WITH leave_days AS (
                     SELECT hl.id AS leave_id, hl.employee_id, hl.number_of_hours,
                            gs.day::date AS day
                     FROM staging.hr_leave hl
                     CROSS JOIN LATERAL generate_series(hl.date_from::date, hl.date_to::date, '1 day'::interval) AS gs(day)
                     WHERE hl.date_from IS NOT NULL AND hl.date_from <> '' AND hl.date_from <> 'False'
                       AND hl.date_to IS NOT NULL AND hl.date_to <> '' AND hl.date_to <> 'False'
                       AND hl.state = 'validate'
                       AND hl.holiday_status_id = 1
                       AND EXTRACT(DOW FROM gs.day) NOT IN (0, 6)
                 ),
                 leave_span AS (
                     SELECT leave_id, number_of_hours, COUNT(*) AS nb_jours_ouvres
                     FROM leave_days GROUP BY leave_id, number_of_hours
                 )
                 SELECT ld.employee_id,
                        EXTRACT(MONTH FROM ld.day)::int AS mois,
                        SUM(ls.number_of_hours / NULLIF(ls.nb_jours_ouvres, 0)) AS hours
                 FROM leave_days ld
                 JOIN leave_span ls ON ls.leave_id = ld.leave_id
                 WHERE EXTRACT(YEAR FROM ld.day)::int = $1
                 GROUP BY ld.employee_id, EXTRACT(MONTH FROM ld.day)::int`,
                [annee]
            ),
            // 6. Illnesses from hr_leave (holiday_status_id = 7, 8, 14) — même répartition jour par jour
            pool.query(
                `WITH leave_days AS (
                     SELECT hl.id AS leave_id, hl.employee_id, hl.number_of_hours,
                            gs.day::date AS day
                     FROM staging.hr_leave hl
                     CROSS JOIN LATERAL generate_series(hl.date_from::date, hl.date_to::date, '1 day'::interval) AS gs(day)
                     WHERE hl.date_from IS NOT NULL AND hl.date_from <> '' AND hl.date_from <> 'False'
                       AND hl.date_to IS NOT NULL AND hl.date_to <> '' AND hl.date_to <> 'False'
                       AND hl.state = 'validate'
                       AND hl.holiday_status_id IN (7, 8, 14)
                       AND EXTRACT(DOW FROM gs.day) NOT IN (0, 6)
                 ),
                 leave_span AS (
                     SELECT leave_id, number_of_hours, COUNT(*) AS nb_jours_ouvres
                     FROM leave_days GROUP BY leave_id, number_of_hours
                 )
                 SELECT ld.employee_id,
                        EXTRACT(MONTH FROM ld.day)::int AS mois,
                        SUM(ls.number_of_hours / NULLIF(ls.nb_jours_ouvres, 0)) AS hours
                 FROM leave_days ld
                 JOIN leave_span ls ON ls.leave_id = ld.leave_id
                 WHERE EXTRACT(YEAR FROM ld.day)::int = $1
                 GROUP BY ld.employee_id, EXTRACT(MONTH FROM ld.day)::int`,
                [annee]
            ),
            // 7. Absences from hr_leave joined to hr_leave_type (types sélectionnés dynamiquement, pas d'ids codés)
            // Même répartition jour par jour que vacances/maladie.
            pool.query(
                `WITH leave_days AS (
                     SELECT hl.id AS leave_id, hl.employee_id, hl.number_of_hours,
                            gs.day::date AS day
                     FROM staging.hr_leave hl
                     JOIN staging.hr_leave_type hlt ON hl.holiday_status_id = hlt.id
                     CROSS JOIN LATERAL generate_series(hl.date_from::date, hl.date_to::date, '1 day'::interval) AS gs(day)
                     WHERE hl.date_from IS NOT NULL AND hl.date_from <> '' AND hl.date_from <> 'False'
                       AND hl.date_to IS NOT NULL AND hl.date_to <> '' AND hl.date_to <> 'False'
                       AND hl.state = 'validate'
                       AND hlt.time_type = 'leave'
                       AND EXTRACT(DOW FROM gs.day) NOT IN (0, 6)
                 ),
                 leave_span AS (
                     SELECT leave_id, number_of_hours, COUNT(*) AS nb_jours_ouvres
                     FROM leave_days GROUP BY leave_id, number_of_hours
                 )
                 SELECT ld.employee_id,
                        EXTRACT(MONTH FROM ld.day)::int AS mois,
                        SUM(ls.number_of_hours / NULLIF(ls.nb_jours_ouvres, 0)) AS hours
                 FROM leave_days ld
                 JOIN leave_span ls ON ls.leave_id = ld.leave_id
                 WHERE EXTRACT(YEAR FROM ld.day)::int = $1
                 GROUP BY ld.employee_id, EXTRACT(MONTH FROM ld.day)::int`,
                [annee]
            ),
            // 8. Non-facturable categories breakdown from account_analytic_line, par mois
            pool.query(
                `SELECT
                   employee_id,
                   EXTRACT(MONTH FROM date::date)::int AS mois,
                   CASE
                     WHEN name LIKE 'Congé (1/%' THEN 'vacances'
                     WHEN name LIKE 'Congé (7/%' OR name LIKE 'Congé (8/%' OR name LIKE 'Congé (14/%' THEN 'maladie'
                     WHEN name LIKE 'Congé (%' THEN 'admin'
                     WHEN LOWER(name) LIKE '%ecole%' OR LOWER(name) LIKE '%école%' OR LOWER(name) LIKE '%cours%' OR LOWER(name) LIKE '%epcl%' OR LOWER(name) LIKE '%formation%' OR LOWER(name) LIKE '%diplome%' THEN 'formation'
                     WHEN LOWER(name) LIKE '%marketing%' OR LOWER(name) LIKE '%vente%' OR LOWER(name) LIKE '%commercial%' THEN 'marketing'
                     WHEN LOWER(name) LIKE '%it%' OR LOWER(name) LIKE '%rh%' OR LOWER(name) LIKE '%recrutement%' OR LOWER(name) LIKE '%entretien%' THEN 'rh_it'
                     ELSE 'admin'
                   END AS category,
                   SUM(unit_amount) AS hours
                 FROM staging.account_analytic_line
                 WHERE (amount <= 0 OR amount IS NULL)
                   AND date IS NOT NULL
                   AND EXTRACT(YEAR FROM date::date) = $1
                 GROUP BY employee_id, 2, 3`,
                [annee]
            ),
            // 9. Global hours repartition by month
            pool.query(
                `SELECT period_key, categorie, SUM(heures) as heures 
                 FROM kpi.operationnel_heures_repartition 
                 WHERE period_key LIKE $1 || '-%'
                 GROUP BY period_key, categorie
                 ORDER BY period_key, categorie`,
                [`${annee}`]
            )
        ]);

        // Build dynamic lists for global budget & theoretical hours
        const monthlyTheo = Array(12).fill(168);
        const monthlyBudget = Array(12).fill(0);

        trackingRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (mIdx >= 0 && mIdx < 12) {
                // Populate employee-specific values (theo = calendrier/prorata, calculé ci-dessus)
                if (empName) {
                    collab[empName].real[mIdx] = parseFloat(row.heures_realisees) || 0;
                    // ca_real n'est plus lu depuis ca_realise_chf : cette colonne est calculée
                    // à l'ETL avec un tarif horaire FIXE (180 CHF, OPERATIONAL_DEFAULTS), pas le
                    // vrai tarif par employé. Voir plus bas (billableRes) pour le calcul corrigé.
                }
                // Populate global monthly theoretical hours & budgets
                monthlyTheo[mIdx] = parseFloat(row.heures_theoriques) || 168;
                monthlyBudget[mIdx] = parseFloat(row.ca_budget_chf) || 0;
            }
        });

        // Process billable hours — sert aussi de base au CA réalisé (voir ci-dessous)
        billableRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && mIdx >= 0 && mIdx < 12) {
                const hours = parseFloat(row.hours) || 0;
                collab[empName].billable[mIdx] = hours;
                // CA réalisé = heures facturables réelles × tarif réel de l'employé (prix de
                // vente Odoo, ou tarif fixe hr_employee, ou tarif horaire par défaut en dernier
                // recours) — remplace l'ancien ca_realise_chf de l'ETL qui appliquait un tarif
                // fixe (180 CHF) identique à tout le monde, sans lien avec le vrai prix facturé.
                const tarifEmp = empTarifMap[row.employee_id] || empPriceMap[row.employee_id]
                    || parseFloat(synthese.tarif_horaire_chf) || 180;
                collab[empName].ca_real[mIdx] = Math.round(hours * tarifEmp * 100) / 100;
            }
        });

        // Process vacations
        vacRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && mIdx >= 0 && mIdx < 12) {
                collab[empName].vac_m[mIdx] = parseFloat(row.hours) || 0;
            }
        });

        // Process illnesses
        malRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && mIdx >= 0 && mIdx < 12) {
                collab[empName].mal_m[mIdx] = parseFloat(row.hours) || 0;
            }
        });

        // Process absences (toutes les absences validées, types via hr_leave_type)
        absRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && mIdx >= 0 && mIdx < 12) {
                collab[empName].abs_m[mIdx] = parseFloat(row.hours) || 0;
            }
        });

        // Process non-facturable categories breakdown, par mois
        nonFactRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && collab[empName] && mIdx >= 0 && mIdx < 12 && collab[empName].non_fact[row.category] !== undefined) {
                collab[empName].non_fact[row.category][mIdx] = parseFloat(row.hours) || 0;
            }
        });

        // Process global hours repartition
        const hours_repartition: Record<string, { facturable: number; non_facturable: number }> = {};
        repartitionRes.rows.forEach(row => {
            if (!hours_repartition[row.period_key]) {
                hours_repartition[row.period_key] = { facturable: 0, non_facturable: 0 };
            }
            if (row.categorie === "facturable") {
                hours_repartition[row.period_key].facturable = parseFloat(row.heures) || 0;
            } else if (row.categorie === "non_facturable") {
                hours_repartition[row.period_key].non_facturable = parseFloat(row.heures) || 0;
            }
        });

        // Compute global average tarif (so_line → xx_hourly_price → default)
        // Même priorité que tarif_moyen ci-dessus : xx_hourly_price (référence RH) avant la
        // moyenne de vente réelle.
        const tarifValues = employees
            .map(emp => empPriceMap[emp.id] || empTarifMap[emp.id] || 0)
            .filter(v => v > 0);
        const tarifGlobal = tarifValues.length > 0
            ? Math.round(tarifValues.reduce((s, v) => s + v, 0) / tarifValues.length)
            : (parseFloat(synthese.tarif_horaire_chf) || 180);

        // Compute holidays & theoretical hours for the year — dérivé des dates déjà résolues
        // plus haut (Odoo si disponible, sinon formule), pas d'un recalcul indépendant.
        const feries = holidaysToMonthly(holidayDates);
        // Année complète, TOUTES les dates officielles (même week-end) — sert uniquement à
        // "Jours fériés calculés" du panneau Synthèse (un décompte informatif du calendrier,
        // distinct de theoFullYear qui ne déduit que les fériés tombant un jour ouvré).
        const feriesFullYear = holidaysToMonthly(holidayDatesRawFullYear);
        // Référence 1 employé plein temps (8h/j, jours ouvrés − fériés) — dénominateur de l'ETP
        const refTheo = computeMonthlyTheo(annee, feries.parMois);

        // Heures théoriques globales = somme des heures théoriques par employé (calendrier + prorata)
        const theoMensuel = { parMois: Array(12).fill(0) as number[], totalAnnuel: 0 };
        Object.values(collab).forEach((c: any) => {
            c.theo.forEach((v: number, i: number) => {
                theoMensuel.parMois[i] += v;
                theoMensuel.totalAnnuel += v;
            });
        });
        if (theoMensuel.totalAnnuel === 0) {
            // Fallback : aucun employé avec données → heures théoriques globales (jours ouvrés × 8h − fériés)
            theoMensuel.parMois = [...refTheo.parMois];
            theoMensuel.totalAnnuel = refTheo.totalAnnuel;
        }

        // ETP mensuel = Σ H.théoriques employés (déjà net fériés, prorata embauche/départ)
        // ÷ H.théorique d'1 employé plein temps référence (net fériés) — remplace l'ancienne
        // somme de ratios de contrat (empEtpMap), qui ignorait totalement les dates
        // d'embauche/départ et comptait un employé arrivé en cours d'année comme présent
        // toute l'année (cas BARBEN Thibaut).
        const etpMensuel = theoMensuel.parMois.map((v, i) => refTheo.parMois[i] > 0 ? v / refTheo.parMois[i] : 0);

        res.json({
            collab,
            departments,
            global: {
                theo: monthlyTheo,
                ca_bud: monthlyBudget,
                hours_repartition,
                synthese: { ...synthese, tarif_horaire_moyen: tarifGlobal },
                feries,
                feriesFullYear,
                theoMensuel,
                etpMensuel,
                // Référence brute (1 employé plein temps, net fériés) — exposée pour que le
                // frontend puisse recalculer l'ETP sur un sous-ensemble d'employés (filtre
                // département) sans redemander l'API : ETP = Σ theo du sous-ensemble ÷ refTheoMensuel.
                refTheoMensuel: refTheo.parMois
            }
        });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: "Erreur lors de la récupération des données du dashboard" });
    }
}