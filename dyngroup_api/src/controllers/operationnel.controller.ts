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
 * Base commune pour holidaysToMonthly (référence 1 personne) et computeTheoMensuelEmployee
 * (prorata réel par employé) — calcul de repli quand Odoo n'a pas le calendrier réel de l'année
 * (voir resolveOdooHolidayEntries plus bas). Vaud uniquement, pas de variante Genève en secours.
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

// Canton de travail d'un employé — détermine quels jours fériés s'appliquent (voir
// holidayDatesForCanton ci-dessous). Dérivé de hr_employee.work_location_name.
type Canton = 'VD' | 'GE';

/**
 * "Plan-les-Ouates" = Genève ; tout le reste (Lausanne, Echichens, ou lieu non renseigné) =
 * Vaud par défaut (canton majoritaire chez DYN — 27+5 employés sur 51 contre 9 à Genève).
 */
function cantonFromWorkLocation(loc: string | null | undefined): Canton {
    if (loc && loc.trim().toLowerCase() === 'plan-les-ouates') return 'GE';
    return 'VD';
}

// Classification des jours fériés Odoo (resource.calendar.leaves) par canton. Tout libellé
// absent des 2 listes ci-dessous est considéré commun aux deux cantons (fériés fédéraux/suisses
// et jours offerts par l'entreprise, ex. "Nouvel An - jour offert par DYN"). Confirmé par
// recoupement avec une feuille de référence RH (AGACHII Igor, basé à Lausanne/VD) : "Restauration
// de la République" y est compté comme jour commun, pas comme un jour exclusivement genevois,
// malgré son origine historique genevoise — décision utilisateur du 2026-09-09.
const GENEVA_ONLY_HOLIDAY_NAMES = ['Jeûne genevois'];
const VAUD_ONLY_HOLIDAY_NAMES = ['Lundi du Jeûne'];

/**
 * Jours fériés réels de l'année, lus depuis le vrai calendrier Odoo
 * (staging.resource_calendar_leaves), dédupliqués par (date, libellé) — chaque jour férié existe
 * en 5 à 6 exemplaires identiques dans Odoo (imports répétés) — filtrés sur les congés globaux
 * uniquement (resource_id vide, hors congés individuels). Renvoie le nom ET la date de chaque
 * entrée : la classification par canton (holidayDatesForCanton) se fait ensuite, pas ici.
 * Renvoie null si la table n'existe pas encore, ou si Odoo n'a aucune donnée pour cette année
 * (constaté pour 2025 et les années antérieures — seules 2026/2027 sont paramétrées à ce jour) :
 * dans ce cas, l'appelant doit retomber sur getVaudHolidayDates() (calcul par formule, Vaud
 * uniquement — pas de variante Genève disponible en secours).
 */
async function resolveOdooHolidayEntries(annee: number): Promise<{ date: Date; name: string }[] | null> {
    try {
        const res = await pool.query(
            `SELECT DISTINCT date_from::date AS d, name
             FROM staging.resource_calendar_leaves
             WHERE (resource_id IS NULL OR resource_id::text IN ('', 'False'))
               AND EXTRACT(YEAR FROM date_from::date) = $1`,
            [annee]
        );
        if (res.rows.length === 0) return null;
        return res.rows.map(r => ({ date: new Date(r.d), name: r.name }));
    } catch (_) {
        return null; // table pas encore extraite (avant premier run du DAG stage1_hr), fallback silencieux
    }
}

/**
 * Filtre une liste d'entrées fériées Odoo pour un canton donné, et déduplique par date (un jour
 * comme le 31 décembre peut porter 2 libellés différents mais ne compte qu'une fois).
 */
function holidayDatesForCanton(entries: { date: Date; name: string }[], canton: Canton): Date[] {
    const relevant = entries.filter(e => {
        if (GENEVA_ONLY_HOLIDAY_NAMES.includes(e.name)) return canton === 'GE';
        if (VAUD_ONLY_HOLIDAY_NAMES.includes(e.name)) return canton === 'VD';
        return true; // commun aux deux cantons
    });
    const seen = new Set<string>();
    const result: Date[] = [];
    for (const e of relevant) {
        const key = e.date.toISOString().slice(0, 10);
        if (!seen.has(key)) { seen.add(key); result.push(e.date); }
    }
    return result;
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

interface ContractPeriod { start: Date; end: Date | null; hoursPerDay: number; }

/**
 * Heures théoriques mensuelles par employé, en tenant compte de TOUS ses contrats
 * (pas seulement le contrat courant) — demande utilisateur du 2026-09-16.
 * Si le taux d'activité change en cours de mois (nouveau contrat), le mois est découpé
 * en sous-intervalles aux dates de changement de contrat ; chaque sous-intervalle est
 * calculé indépendamment (jours ouvrés − fériés dans CET intervalle) × hours_per_day du
 * contrat actif sur cet intervalle, puis les sous-intervalles sont additionnés.
 * Exemple : contrat A (90%, jusqu'au 15 fév) + contrat B (80%, dès le 16 fév) → théorique
 * de février = (jours ouvrés du 1-15 fév − fériés) × hpd_A + (jours ouvrés du 16-28 fév
 * − fériés) × hpd_B, plutôt qu'un seul hours_per_day appliqué au mois entier comme avant.
 */
function computeTheoMensuelEmployeeContrats(
    contracts: ContractPeriod[],
    year: number,
    holidayDates: Date[],
    toDate: boolean = true
): number[] {
    const now = new Date();
    const isCurrentYear = now.getFullYear() === year;
    const parMois = Array<number>(12).fill(0);

    for (let m = 0; m < 12; m++) {
        if (toDate && year > now.getFullYear()) break; // future year → all zeros
        if (toDate && isCurrentYear && m > now.getMonth()) continue; // future month → 0

        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const lastDay = (toDate && isCurrentYear && m === now.getMonth()) ? now.getDate() : daysInMonth;
        const monthStart = new Date(year, m, 1);
        const monthEnd = new Date(year, m, lastDay);

        let total = 0;
        for (const c of contracts) {
            const cEnd = c.end ?? monthEnd; // contrat encore actif → pas de borne de fin
            const from = c.start > monthStart ? c.start : monthStart;
            const to = cEnd < monthEnd ? cEnd : monthEnd;
            if (from > to) continue; // ce contrat ne chevauche pas ce mois

            let workingDays = 0;
            for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
                const dow = d.getDay();
                if (dow !== 0 && dow !== 6) workingDays++;
            }
            const feriesDansFenetre = holidayDates.filter(h => h >= from && h <= to).length;
            total += (workingDays - feriesDansFenetre) * c.hoursPerDay;
        }
        parMois[m] = Math.round(total * 100) / 100;
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
            resolveOdooHolidayEntries(annee)
        ]);

        type HolidaySet = {
            toDate: Date[];         // fériés ouvrés, "à ce jour" — graphiques/tableaux mensuels
            fullYear: Date[];       // fériés ouvrés, année complète — H. théoriques annuelles
            rawFullYear: Date[];    // TOUTES les dates officielles (même week-end) — Jours fériés calculés
        };

        /**
         * Résout le jeu de jours fériés applicable à un canton donné : source réelle Odoo si
         * disponible pour l'année demandée (dédupliquée, classée par canton), sinon calcul par
         * formule (getVaudHolidayDates — Vaud uniquement, pas de variante Genève en secours).
         * Voir docs/JOURS_FERIES_ODOO.md pour le détail de cette décision.
         */
        function resolveHolidaySet(canton: Canton): HolidaySet {
            if (odooHolidays) {
                const relevant = holidayDatesForCanton(odooHolidays, canton);
                const weekdaysOnly = relevant.filter(h => !isWeekend(h));
                return {
                    toDate: weekdaysOnly.filter(h => h <= now),
                    fullYear: weekdaysOnly,
                    rawFullYear: relevant,
                };
            }
            const fullYear = getVaudHolidayDates(annee, false);
            return { toDate: getVaudHolidayDates(annee), fullYear, rawFullYear: fullYear };
        }

        const holidaysByCanton: Record<Canton, HolidaySet> = {
            VD: resolveHolidaySet('VD'),
            GE: resolveHolidaySet('GE'),
        };
        // Jeu par défaut (Vaud) pour les totaux company-wide qui n'ont pas de notion de canton
        // (référence ETP 1 employé plein temps, panneau Synthèse) — inchangé par rapport à avant.
        const holidayDates = holidaysByCanton.VD.toDate;
        const holidayDatesRawFullYear = holidaysByCanton.VD.rawFullYear;

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

        // Canton de travail par employé (Vaud/Genève), pour choisir le bon jeu de jours fériés
        // (holidaysByCanton ci-dessus). Requête à part et défensive : work_location_name n'est
        // pas encore extrait tant que stage1_hr n'a pas tourné avec ce nouveau champ — dans ce
        // cas, tout le monde retombe sur Vaud (comportement identique à avant cette fonctionnalité).
        const empCantonMap: Record<number, Canton> = {};
        try {
            const cantonRes = await pool.query(
                `SELECT id, work_location_name FROM staging.hr_employee WHERE work_location_name IS NOT NULL`
            );
            cantonRes.rows.forEach(r => {
                empCantonMap[r.id] = cantonFromWorkLocation(r.work_location_name);
            });
        } catch (_) {
            // Colonne pas encore extraite (avant le prochain run de stage1_hr) — fallback Vaud
        }

        // Société par employé (filtre "Société", 2026-09-17, remplace le filtre Département).
        // Requête à part et défensive : staging.res_company n'existe pas tant que stage1_hr n'a
        // pas tourné avec cette nouvelle table.
        const empCompanyMap: Record<number, string> = {};
        try {
            const companyRes = await pool.query(
                `SELECT emp.id, rc.name AS company_name
                 FROM staging.hr_employee emp
                 JOIN staging.res_company rc ON rc.id = emp.company_id
                 WHERE emp.company_id IS NOT NULL`
            );
            companyRes.rows.forEach(r => {
                empCompanyMap[r.id] = r.company_name;
            });
        } catch (_) {
            // staging.res_company pas encore extraite
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

        // Historique COMPLET des contrats par employé (pas seulement le plus récent, contrairement
        // à empEtpMap ci-dessus) — sert à calculer l'heure théorique mensuelle en tenant compte
        // d'un changement de taux d'activité en cours de mois (demande utilisateur du 2026-09-16).
        // 'open' et 'close' inclus (un contrat clos reste un historique réel) ; 'draft'/'cancel'
        // exclus (jamais entrés en vigueur).
        const empContractsMap: Record<number, ContractPeriod[]> = {};
        try {
            const contractsRes = await pool.query(
                `SELECT c.employee_id, c.date_start, c.date_end,
                        COALESCE(rc.hours_per_day, 8) AS hours_per_day
                 FROM staging.hr_contract c
                 LEFT JOIN staging.resource_calendar rc ON c.resource_calendar_id = rc.id
                 WHERE c.state IN ('open', 'close') AND c.date_start IS NOT NULL
                 ORDER BY c.employee_id, c.date_start::date ASC`
            );
            contractsRes.rows.forEach(r => {
                const empId = r.employee_id;
                if (!empContractsMap[empId]) empContractsMap[empId] = [];
                empContractsMap[empId].push({
                    start: new Date(r.date_start),
                    end: r.date_end ? new Date(r.date_end) : null,
                    hoursPerDay: parseFloat(r.hours_per_day) || 8
                });
            });
        } catch (_) {
            // staging.hr_contract pas encore extrait — fallback sur computeTheoMensuelEmployee
        }

        // Map employee ID to Name for quick lookup
        const empNameMap: Record<number, string> = {};
        const collab: Record<string, any> = {};

        employees.forEach(emp => {
            const annualBudget = empBudgetMap[emp.id] || parseFloat(synthese.ca_budget_annuel_chf) || 0;
            const monthlyBudget = annualBudget / 12;
            const vacInitH = empVacMap[emp.id] || 0;
            const canton = empCantonMap[emp.id] || 'VD';
            const holidays = holidaysByCanton[canton];
            empNameMap[emp.id] = emp.name;
            // Contrats connus pour cet employé → calcul par sous-intervalle (voir
            // computeTheoMensuelEmployeeContrats). Repli sur l'ancien calcul à taux fixe si
            // aucun contrat n'a pu être extrait pour cet employé.
            const contracts = empContractsMap[emp.id];
            const theoOf = (holidayDates: Date[], toDate: boolean) =>
                contracts && contracts.length > 0
                    ? computeTheoMensuelEmployeeContrats(contracts, annee, holidayDates, toDate)
                    : computeTheoMensuelEmployee(emp, annee, holidayDates, toDate);
            // Référence "100%" pour l'ETP (demande utilisateur du 2026-09-16) : même fenêtre de
            // présence (dates de contrat) et même canton que l'employé, mais SANS le taux
            // d'activité — hoursPerDay forcé à 8 sur chaque intervalle. ETP = théorique réel ÷
            // cette référence 100% (ex: 128h / 160h = 0.8 pour un contrat à 80%), pas
            // réalisé/théorique (qui reste le "Taux effort", une mesure différente).
            const theo100Of = (holidayDates: Date[], toDate: boolean) =>
                contracts && contracts.length > 0
                    ? computeTheoMensuelEmployeeContrats(
                        contracts.map(c => ({ ...c, hoursPerDay: 8 })), annee, holidayDates, toDate)
                    : computeTheoMensuelEmployee({ ...emp, hours_per_day: 8 }, annee, holidayDates, toDate);
            collab[emp.name] = {
                real: Array(12).fill(0),
                ca_real: Array(12).fill(0),
                billable: Array(12).fill(0),
                productif: Array(12).fill(0),
                theo: theoOf(holidays.toDate, true),
                // Théorique année complète (pas de coupure à aujourd'hui) — sert uniquement à
                // "H. théoriques annuelles" du panneau Synthèse (voir toDate=false ci-dessus).
                theoFullYear: theoOf(holidays.fullYear, false),
                // Référence 100% "à ce jour" — dénominateur de l'ETP (voir theo100Of ci-dessus).
                theo100: theo100Of(holidays.toDate, true),
                // Référence 100% année complète (pas de coupure à aujourd'hui) — dénominateur de
                // l'ETP en vue "tous les mois" (2026-09-22) : sans ça, l'ETP d'un mois futur
                // retombe à 0/0 → 0.00 alors que theoFullYear affiche déjà un théorique plein
                // pour ce même mois, incohérence relevée sur Octobre (176h théorique mais ETP 0).
                theo100FullYear: theo100Of(holidays.fullYear, false),
                canton,
                ca_bud: Array(12).fill(monthlyBudget),
                ca_budget_annuel: annualBudget,
                // CA objectif CHF (onglet "Objectif" de la fiche employé, x_studio_objectif_chf,
                // par mois) — distinct de ca_bud/ca_budget_annuel (ancien système de budget).
                ca_objectif_chf: Array(12).fill(0),
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
                department: emp.department_name || null,
                company: empCompanyMap[emp.id] || null
            };
        });

        // Liste des départements présents, pour peupler le filtre côté frontend
        const departments = Array.from(
            new Set(employees.map(emp => emp.department_name).filter((d): d is string => !!d))
        ).sort();

        // Liste des sociétés présentes, pour peupler le filtre "Société" (2026-09-17, remplace
        // le filtre Département).
        const companies = Array.from(
            new Set(employees.map(emp => empCompanyMap[emp.id]).filter((c): c is string => !!c))
        ).sort();

        // 3-8. Run the 7 independent queries (tracking, billable, vacations, illnesses, absences, non-facturable, repartition) in parallel
        const [trackingRes, billableRes, vacRes, malRes, absRes, nonFactRes, repartitionRes, realHoursRes] = await Promise.all([
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
            // 8. Non-facturable categories breakdown from account_analytic_line, par mois.
            // Périmètre = heures NON productives (productivity = false/NULL), pas "amount<=0"
            // comme avant (2026-09-16) : ce dernier filtre attrapait aussi de vraies heures de
            // travail productif dont le prix de vente n'était pas renseigné, ce qui gonflait
            // artificiellement "Administratif" (le fallback ELSE) très au-delà de la réalité
            // (ex: AGACHII Igor).
            // "formation"/"marketing"/"rh_it" détectées via la tâche Odoo (project_task.name),
            // scopées au projet "CLIENT DYN SA - INTERNE" — pas par mot-clé dans le nom libre du
            // timesheet comme avant (2026-09-16, demande utilisateur) : les tâches de ce projet
            // sont une nomenclature stable/curatée par les RH, contrairement au texte libre saisi
            // par chacun. Basé sur le nom de la TÂCHE (pas un id figé) pour qu'une nouvelle tâche
            // ajoutée plus tard sous ce projet soit prise en compte automatiquement, sans
            // modification de code. "admin" = tout le reste (heures non productives qui ne sont
            // ni un congé, ni une tâche marketing/rh-it/formation de ce projet) — inclut donc les
            // autres tâches internes (Administratif, Facturation, Innovation...) ET du vrai
            // travail client non encore flagué "Productivité" dans Odoo (cas non résolu ici,
            // dépend de la saisie Odoo — vérifié sur NETO DA SILVA Inês).
            pool.query(
                `SELECT
                   aal.employee_id,
                   EXTRACT(MONTH FROM aal.date::date)::int AS mois,
                   CASE
                     WHEN aal.name LIKE 'Congé (1/%' THEN 'vacances'
                     WHEN aal.name LIKE 'Congé (7/%' OR aal.name LIKE 'Congé (8/%' OR aal.name LIKE 'Congé (14/%' THEN 'maladie'
                     WHEN aal.name LIKE 'Congé (%' THEN 'admin'
                     WHEN pp.name = 'CLIENT DYN SA - INTERNE' AND (LOWER(pt.name) LIKE '%formation%' OR LOWER(pt.name) LIKE '%école%' OR LOWER(pt.name) LIKE '%ecole%' OR LOWER(pt.name) LIKE '%diplome%') THEN 'formation'
                     WHEN pp.name = 'CLIENT DYN SA - INTERNE' AND (LOWER(pt.name) LIKE '%marketing%' OR LOWER(pt.name) LIKE '%commercial%') THEN 'marketing'
                     WHEN pp.name = 'CLIENT DYN SA - INTERNE' AND (LOWER(pt.name) LIKE '%informatique%' OR LOWER(pt.name) LIKE '%ressources humaines%') THEN 'rh_it'
                     ELSE 'admin'
                   END AS category,
                   SUM(aal.unit_amount) AS hours
                 FROM staging.account_analytic_line aal
                 LEFT JOIN staging.project_task pt ON pt.id = aal.task_id
                 LEFT JOIN staging.project_project pp ON pp.id = pt.project_id
                 WHERE (aal.productivity = false OR aal.productivity IS NULL)
                   AND aal.date IS NOT NULL
                   AND EXTRACT(YEAR FROM aal.date::date) = $1
                   -- Même exclusion que "H. réalisées"/"H. Productivité" (requêtes 10/11) : les
                   -- lignes "Congé (N/M)" à amount=0, auto-générées par Odoo pour les jours fériés
                   -- d'entreprise, ne sont pas de vraies heures — sans cette exclusion elles
                   -- gonflaient "admin"/"maladie" au-delà de (H.réalisées - H.Productivité).
                   AND NOT (aal.name LIKE 'Congé (%' AND aal.amount = 0)
                 GROUP BY aal.employee_id, 2, 3`,
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
            ),
            // 10. Heures réalisées mensuelles par employé, HORS jours fériés — remplace la
            // colonne heures_realisees de kpi.operationnel_suivi_mensuel, qui sommait aussi les
            // lignes "Congé (N/M)" à amount=0 générées automatiquement par Odoo pour les jours
            // fériés d'entreprise (voir docs/JOURS_FERIES_ODOO.md) : ce ne sont pas des heures
            // de travail, elles gonflaient artificiellement les heures réalisées de tout le monde.
            pool.query(
                `SELECT employee_id, EXTRACT(MONTH FROM date::date)::int AS mois, SUM(unit_amount) AS hours
                 FROM staging.account_analytic_line
                 WHERE date IS NOT NULL AND employee_id IS NOT NULL
                   AND EXTRACT(YEAR FROM date::date) = $1
                   AND NOT (name LIKE 'Congé (%' AND amount = 0)
                 GROUP BY employee_id, mois`,
                [annee]
            )
        ]);

        // 11. Heures "productives" par employé/mois — règle simplifiée le 2026-09-11 à la
        // demande de l'utilisateur : uniquement le champ Odoo account_analytic_line.productivity
        // (booléen "Productivité"), sans exclusion par nom de projet (l'exclusion "dyn"/"interne"
        // a été retirée — on ne vérifie plus que productivity = true). Hors fériés, comme pour
        // "heures réalisées" ci-dessus.
        // Défensif : `productivity` n'est pas encore extrait tant que stage1_project n'a pas
        // tourné avec ce nouveau champ (voir kpi_fields.py) — en attendant, on retombe sur
        // l'ancienne définition (heures facturables, amount<0) pour ne pas casser l'affichage.
        let productifRes: { rows: { employee_id: number; mois: number; hours: string }[] } | null = null;
        try {
            productifRes = await pool.query(
                `SELECT aal.employee_id, EXTRACT(MONTH FROM aal.date::date)::int AS mois,
                        SUM(aal.unit_amount) AS hours
                 FROM staging.account_analytic_line aal
                 WHERE aal.date IS NOT NULL AND aal.employee_id IS NOT NULL
                   AND EXTRACT(YEAR FROM aal.date::date) = $1
                   AND NOT (aal.name LIKE 'Congé (%' AND aal.amount = 0)
                   AND aal.productivity = true
                 GROUP BY aal.employee_id, mois`,
                [annee]
            );
        } catch (_) {
            productifRes = null; // colonne productivity pas encore extraite — fallback plus bas
        }

        // 12. Tarif horaire moyen par employé/mois, à partir des timesheets réels
        // (x_studio_tarif_horaire, un champ Studio dédié — pas empTarifMap/empPriceMap, qui
        // servent de repli si aucune donnée mensuelle n'existe). CA réalisé = heures réalisées
        // × cette moyenne mensuelle (demande utilisateur du 2026-09-11).
        // Défensif : colonne pas encore extraite tant que stage1_project n'a pas tourné avec ce
        // nouveau champ (voir kpi_fields.py).
        let tarifMoisRes: { rows: { employee_id: number; mois: number; tarif_moyen: string }[] } | null = null;
        try {
            tarifMoisRes = await pool.query(
                `SELECT employee_id, EXTRACT(MONTH FROM date::date)::int AS mois,
                        AVG(x_studio_tarif_horaire) AS tarif_moyen
                 FROM staging.account_analytic_line
                 WHERE date IS NOT NULL AND employee_id IS NOT NULL
                   AND EXTRACT(YEAR FROM date::date) = $1
                   AND x_studio_tarif_horaire > 0
                 GROUP BY employee_id, mois`,
                [annee]
            );
        } catch (_) {
            tarifMoisRes = null; // colonne pas encore extraite — repli sur tarif_moyen par employé
        }
        const tarifMoisMap: Record<string, number> = {};
        if (tarifMoisRes) {
            tarifMoisRes.rows.forEach(r => {
                tarifMoisMap[`${r.employee_id}_${r.mois}`] = parseFloat(r.tarif_moyen) || 0;
            });
        }

        // 13. CA objectif CHF par employé/mois — onglet "Objectif" de la fiche employé Odoo
        // (x_suivi_annuel_employe.x_studio_objectif_chf, daté par x_studio_mois_objectif).
        // Défensif : ces 2 champs viennent d'être ajoutés à l'extraction (voir kpi_fields.py) —
        // pas encore présents tant que stage1_hr n'a pas tourné avec.
        let objectifChfRes: { rows: { employee_id: number; mois: number; objectif_chf: string }[] } | null = null;
        try {
            objectifChfRes = await pool.query(
                `SELECT x_studio_employ AS employee_id,
                        EXTRACT(MONTH FROM x_studio_mois_objectif::date)::int AS mois,
                        SUM(x_studio_objectif_chf) AS objectif_chf
                 FROM staging.x_suivi_annuel_employe
                 WHERE x_active = true AND x_studio_employ IS NOT NULL
                   AND x_studio_mois_objectif IS NOT NULL
                   AND EXTRACT(YEAR FROM x_studio_mois_objectif::date) = $1
                 GROUP BY x_studio_employ, mois`,
                [annee]
            );
        } catch (_) {
            objectifChfRes = null; // champs pas encore extraits
        }

        // Build dynamic lists for global budget & theoretical hours
        const monthlyTheo = Array(12).fill(168);
        const monthlyBudget = Array(12).fill(0);

        trackingRes.rows.forEach(row => {
            const mIdx = row.mois - 1;
            if (mIdx >= 0 && mIdx < 12) {
                // real n'est plus lu depuis heures_realisees (voir realHoursRes ci-dessous) : cette
                // colonne de kpi.operationnel_suivi_mensuel sommait aussi les jours fériés.
                // ca_real n'est plus lu depuis ca_realise_chf : cette colonne est calculée
                // à l'ETL avec un tarif horaire FIXE (180 CHF, OPERATIONAL_DEFAULTS), pas le
                // vrai tarif par employé. Voir plus bas (billableRes) pour le calcul corrigé.
                // Populate global monthly theoretical hours & budgets
                monthlyTheo[mIdx] = parseFloat(row.heures_theoriques) || 168;
                monthlyBudget[mIdx] = parseFloat(row.ca_budget_chf) || 0;
            }
        });

        // Heures réalisées, hors fériés (voir requête 10 ci-dessus)
        realHoursRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && mIdx >= 0 && mIdx < 12) {
                collab[empName].real[mIdx] = parseFloat(row.hours) || 0;
            }
        });

        // Heures productives (voir requête 11 ci-dessus). Fallback tant que `productivity`
        // n'est pas extrait : ancienne définition (heures facturables, amount<0) — remplacée
        // automatiquement dès que stage1_project aura tourné avec le nouveau champ.
        (productifRes ? productifRes.rows : billableRes.rows).forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && mIdx >= 0 && mIdx < 12) {
                collab[empName].productif[mIdx] = parseFloat(row.hours) || 0;
            }
        });

        // Process billable hours (encore utilisé par l'ancien tableau "Suivi productivité
        // mensuelle", désactivé mais pas supprimé — voir operationnel-dashboard.component.html)
        billableRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && mIdx >= 0 && mIdx < 12) {
                collab[empName].billable[mIdx] = parseFloat(row.hours) || 0;
            }
        });

        // CA réalisé = heures PRODUCTIVES (account_analytic_line.productivity = true, pas
        // toutes les heures réalisées) × tarif horaire moyen du mois, calculé à partir des
        // vraies lignes de temps (x_studio_tarif_horaire). Repli sur le tarif de référence de
        // l'employé (tarif_moyen — xx_hourly_price ou moyenne de vente) si aucune ligne de ce
        // mois n'a de tarif renseigné (mois sans activité, ou colonne pas encore extraite).
        // Demande utilisateur du 2026-09-16 : remplace le calcul précédent (toutes les heures
        // réalisées × tarif), qui surestimait le CA en comptant aussi les heures non productives.
        employees.forEach(emp => {
            const c = collab[emp.name];
            for (let m = 0; m < 12; m++) {
                const tarifMois = tarifMoisMap[`${emp.id}_${m + 1}`];
                const tarif = tarifMois || c.tarif_moyen;
                c.ca_real[m] = Math.round(c.productif[m] * tarif * 100) / 100;
            }
            // Tarif horaire "effectif" de l'employé sur l'année = CA réalisé total ÷ heures
            // productives totales — reconstitue le vrai mélange des tarifs mensuels appliqués
            // ci-dessus (peut varier d'un mois à l'autre), contrairement à tarif_moyen qui n'est
            // qu'un tarif de référence statique (xx_hourly_price). Repli sur tarif_moyen si
            // l'employé n'a aucune heure productive cette année.
            const totalCaEmp = c.ca_real.reduce((s: number, v: number) => s + v, 0);
            const totalHeuresEmp = c.productif.reduce((s: number, v: number) => s + v, 0);
            c.tarif_effectif = totalHeuresEmp > 0 ? Math.round((totalCaEmp / totalHeuresEmp) * 100) / 100 : c.tarif_moyen;
        });

        // CA objectif CHF (onglet "Objectif" de la fiche employé) — voir requête 13 ci-dessus.
        if (objectifChfRes) {
            objectifChfRes.rows.forEach(row => {
                const empName = empNameMap[row.employee_id];
                const mIdx = row.mois - 1;
                if (empName && mIdx >= 0 && mIdx < 12) {
                    collab[empName].ca_objectif_chf[mIdx] = parseFloat(row.objectif_chf) || 0;
                }
            });
        }

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

        // Tarif horaire moyen global = CA réalisé total ÷ heures PRODUCTIVES totales (moyenne
        // pondérée par les heures qui génèrent effectivement ce CA depuis le 2026-09-16) —
        // cohérent avec le CA réalisé effectivement affiché (voir tarif_effectif ci-dessus),
        // plutôt qu'une simple moyenne non pondérée des tarifs de référence par employé qui
        // ignorait leur volume d'heures respectif. Diviser par les heures réalisées (toutes,
        // pas seulement productives) donnerait un tarif artificiellement dilué. Repli sur
        // l'ancienne moyenne (xx_hourly_price → prix de vente moyen → défaut) si personne n'a
        // encore d'heures productives sur l'année.
        let totalCaRealAnnuel = 0;
        let totalHeuresRealAnnuel = 0;
        Object.values(collab).forEach((c: any) => {
            totalCaRealAnnuel += c.ca_real.reduce((s: number, v: number) => s + v, 0);
            totalHeuresRealAnnuel += c.productif.reduce((s: number, v: number) => s + v, 0);
        });
        const tarifValues = employees
            .map(emp => empPriceMap[emp.id] || empTarifMap[emp.id] || 0)
            .filter(v => v > 0);
        const tarifGlobal = totalHeuresRealAnnuel > 0
            ? Math.round((totalCaRealAnnuel / totalHeuresRealAnnuel) * 100) / 100
            : (tarifValues.length > 0
                ? Math.round(tarifValues.reduce((s, v) => s + v, 0) / tarifValues.length)
                : (parseFloat(synthese.tarif_horaire_chf) || 180));

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
            companies,
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