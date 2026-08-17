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

function computeVaudHolidays(year: number): { parMois: number[]; totalHeures: number } {
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

    const parMois = Array<number>(12).fill(0);
    let totalHeures = 0;

    for (const h of holidays) {
        if (isWeekend(h)) continue;
        // Only count holidays up to today (past dates for past years included)
        if (h > now) continue;
        parMois[h.getMonth()] += 8;
        totalHeures += 8;
    }

    return { parMois, totalHeures };
}

function computeMonthlyTheo(year: number, feriesParMois: number[]): { parMois: number[]; totalAnnuel: number } {
    const now = new Date();
    const isCurrentYear = now.getFullYear() === year;
    const currentMonth = now.getMonth();
    const today = now.getDate();

    const parMois = Array<number>(12).fill(0);
    let totalAnnuel = 0;

    for (let m = 0; m < 12; m++) {
        if (year > now.getFullYear()) break; // future year → all zeros
        if (isCurrentYear && m > currentMonth) continue; // future month → 0

        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const lastDay = (isCurrentYear && m === currentMonth) ? today : daysInMonth;
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
 * resource_calendar.hours_per_day × jours ouvrés (lun–ven),
 * avec prorata d'arrivée (first_contract_date) et de départ (departure_date),
 * et cutoff à la date du jour (mois courant / mois futurs).
 */
function computeTheoMensuelEmployee(
    emp: { hours_per_day: string | number | null; first_contract_date: string | null; departure_date: string | null },
    year: number
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
        if (year > now.getFullYear()) break; // future year → all zeros
        if (isCurrentYear && m > now.getMonth()) continue; // future month → 0

        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const lastDay = (isCurrentYear && m === now.getMonth()) ? now.getDate() : daysInMonth;
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
        parMois[m] = Math.round(workingDays * hpd * 100) / 100;
    }

    return parMois;
}

export async function getDashboardData(req: Request, res: Response) {
    try {
        const annee = parseInt(req.query.annee as string) || 2026;

        // 1 & 2. Query synthesis params and active employees in parallel (independent queries)
        const [syntheseRes, employeesRes] = await Promise.all([
            pool.query(
                `SELECT * FROM kpi.operationnel_synthese_annuelle WHERE annee = $1 LIMIT 1`,
                [annee]
            ),
            pool.query(
                `SELECT DISTINCT emp.id, emp.name,
                        rc.hours_per_day,
                        emp.first_contract_date,
                        emp.departure_date
                 FROM kpi.operationnel_suivi_mensuel osm
                 JOIN staging.hr_employee emp ON osm.employee_id = emp.id
                 LEFT JOIN staging.resource_calendar rc ON emp.resource_calendar_id = rc.id
                 WHERE osm.annee = $1
                 ORDER BY emp.name`,
                [annee]
            )
        ]);

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

        // Query ETP from active contract × resource_calendar
        const empEtpMap: Record<number, number> = {};
        try {
            const etpRes = await pool.query(
                `SELECT DISTINCT ON (c.employee_id)
                   c.employee_id,
                   COALESCE(rc.hours_per_day, 8) / 8.0 AS etp
                 FROM staging.hr_contract c
                 LEFT JOIN staging.resource_calendar rc ON c.resource_calendar_id = rc.id
                 WHERE (c.state IS NULL OR c.state = 'open')
                 ORDER BY c.employee_id`
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
                theo: computeTheoMensuelEmployee(emp, annee),
                ca_bud: Array(12).fill(monthlyBudget),
                ca_budget_annuel: annualBudget,
                vac_m: Array(12).fill(0),
                mal_m: Array(12).fill(0),
                abs_m: Array(12).fill(0),
                vac_init: vacInitH,
                non_fact: { admin: 0, vacances: 0, rh_it: 0, marketing: 0, formation: 0, maladie: 0 },
                tarif_moyen: empTarifMap[emp.id] || empPriceMap[emp.id] || parseFloat(synthese.tarif_horaire_chf) || 180,
                etp: empEtpMap[emp.id] || 1
            };
        });

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
            pool.query(
                `SELECT 
                   employee_id,
                   EXTRACT(MONTH FROM date_from::timestamp)::int as mois,
                   SUM(number_of_hours) as hours
                 FROM staging.hr_leave
                 WHERE date_from IS NOT NULL 
                   AND date_from <> ''
                   AND date_from <> 'False'
                   AND EXTRACT(YEAR FROM date_from::timestamp)::int = $1
                   AND state = 'validate'
                   AND holiday_status_id = 1
                 GROUP BY employee_id, mois`,
                [annee]
            ),
            // 6. Illnesses from hr_leave (holiday_status_id = 7, 8, 14)
            pool.query(
                `SELECT 
                   employee_id,
                   EXTRACT(MONTH FROM date_from::timestamp)::int as mois,
                   SUM(number_of_hours) as hours
                 FROM staging.hr_leave
                 WHERE date_from IS NOT NULL 
                   AND date_from <> ''
                   AND date_from <> 'False'
                   AND EXTRACT(YEAR FROM date_from::timestamp)::int = $1
                   AND state = 'validate'
                   AND holiday_status_id IN (7, 8, 14)
                 GROUP BY employee_id, mois`,
                [annee]
            ),
            // 7. Absences from hr_leave joined to hr_leave_type (types sélectionnés dynamiquement, pas d'ids codés)
            pool.query(
                `SELECT
                   hl.employee_id,
                   EXTRACT(MONTH FROM hl.date_from::timestamp)::int as mois,
                   SUM(hl.number_of_hours) as hours
                 FROM staging.hr_leave hl
                 JOIN staging.hr_leave_type hlt ON hl.holiday_status_id = hlt.id
                 WHERE hl.date_from IS NOT NULL
                   AND hl.date_from <> ''
                   AND hl.date_from <> 'False'
                   AND EXTRACT(YEAR FROM hl.date_from::timestamp)::int = $1
                   AND hl.state = 'validate'
                   AND hlt.time_type = 'leave'
                 GROUP BY hl.employee_id, mois`,
                [annee]
            ),
            // 8. Non-facturable categories breakdown from account_analytic_line
            pool.query(
                `SELECT 
                   employee_id,
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
                 GROUP BY employee_id, 2`,
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
                    collab[empName].ca_real[mIdx] = parseFloat(row.ca_realise_chf) || 0;
                }
                // Populate global monthly theoretical hours & budgets
                monthlyTheo[mIdx] = parseFloat(row.heures_theoriques) || 168;
                monthlyBudget[mIdx] = parseFloat(row.ca_budget_chf) || 0;
            }
        });

        // Process billable hours
        billableRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && mIdx >= 0 && mIdx < 12) {
                collab[empName].billable[mIdx] = parseFloat(row.hours) || 0;
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

        // Process non-facturable categories breakdown
        nonFactRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            if (empName && collab[empName] && collab[empName].non_fact[row.category] !== undefined) {
                collab[empName].non_fact[row.category] = parseFloat(row.hours) || 0;
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
        const tarifValues = employees
            .map(emp => empTarifMap[emp.id] || empPriceMap[emp.id] || 0)
            .filter(v => v > 0);
        const tarifGlobal = tarifValues.length > 0
            ? Math.round(tarifValues.reduce((s, v) => s + v, 0) / tarifValues.length)
            : (parseFloat(synthese.tarif_horaire_chf) || 180);

        // Compute holidays & theoretical hours for the year
        const feries = computeVaudHolidays(annee);

        // Heures théoriques globales = somme des heures théoriques par employé (calendrier + prorata)
        const theoMensuel = { parMois: Array(12).fill(0) as number[], totalAnnuel: 0 };
        Object.values(collab).forEach((c: any) => {
            c.theo.forEach((v: number, i: number) => {
                theoMensuel.parMois[i] += v;
                theoMensuel.totalAnnuel += v;
            });
        });
        if (theoMensuel.totalAnnuel === 0) {
            // Fallback : aucun employé avec données → heurs théoriques théoriques globales (jours ouvrés × 8h − fériés)
            const fb = computeMonthlyTheo(annee, feries.parMois);
            theoMensuel.parMois = fb.parMois;
            theoMensuel.totalAnnuel = fb.totalAnnuel;
        }

        res.json({
            collab,
            global: {
                theo: monthlyTheo,
                ca_bud: monthlyBudget,
                hours_repartition,
                synthese: { ...synthese, tarif_horaire_moyen: tarifGlobal },
                feries,
                theoMensuel
            }
        });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: "Erreur lors de la récupération des données du dashboard" });
    }
}