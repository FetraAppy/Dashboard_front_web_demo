import { pool } from "../db/pool";

// Heures théoriques et jours fériés — source unique partagée par le dashboard Opérationnel
// (operationnel.controller.ts) et ses exports Excel, pour que les deux donnent toujours les
// mêmes chiffres.

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

export function isWeekend(d: Date): boolean {
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
 * Base commune pour holidaysToMonthly (référence 1 personne) et computeTheoSegments
 * (prorata réel par employé) — calcul de repli quand Odoo n'a pas le calendrier réel de l'année
 * (voir resolveOdooHolidayEntries plus bas). Vaud uniquement, pas de variante Genève en secours.
 */
export function getVaudHolidayDates(year: number, toDate: boolean = true): Date[] {
    return getVaudHolidayEntries(year, toDate).map(e => e.date);
}

/** Même liste que getVaudHolidayDates, avec le nom de chaque jour férié (export Excel). */
export function getVaudHolidayEntries(year: number, toDate: boolean = true): HolidayEntry[] {
    const paques = computEaster(year);
    const now = new Date();

    const holidays: HolidayEntry[] = [
        { date: new Date(year, 0, 1), name: 'Nouvel An' },
        { date: new Date(year, 0, 2), name: 'Saint-Berthold' },
        { date: addDays(paques, -2), name: 'Vendredi Saint' },
        { date: addDays(paques, 1), name: 'Lundi de Pâques' },
        { date: addDays(paques, 39), name: 'Ascension' },
        { date: addDays(paques, 50), name: 'Lundi de Pentecôte' },
        { date: new Date(year, 7, 1), name: 'Fête nationale' },
        { date: jeuneFederalMonday(year), name: 'Lundi du Jeûne fédéral' },
        { date: new Date(year, 11, 25), name: 'Noël' },
    ];

    return holidays.filter(h => !isWeekend(h.date) && (!toDate || h.date <= now));
}

export interface HolidayEntry {
    date: Date;
    name: string;
}

/** Convertit une liste de dates de jours fériés en répartition mensuelle (8h/jour). */
export function holidaysToMonthly(dates: Date[]): { parMois: number[]; totalHeures: number } {
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
export type Canton = 'VD' | 'GE';

/**
 * "Plan-les-Ouates" = Genève ; tout le reste (Lausanne, Echichens, ou lieu non renseigné) =
 * Vaud par défaut (canton majoritaire chez DYN — 27+5 employés sur 51 contre 9 à Genève).
 */
export function cantonFromWorkLocation(loc: string | null | undefined): Canton {
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
export async function resolveOdooHolidayEntries(annee: number): Promise<HolidayEntry[] | null> {
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
export function holidayDatesForCanton(entries: HolidayEntry[], canton: Canton): Date[] {
    return holidayEntriesForCanton(entries, canton).map(e => e.date);
}

/** Même filtre que holidayDatesForCanton, en gardant le libellé (1er libellé rencontré par date). */
export function holidayEntriesForCanton(entries: HolidayEntry[], canton: Canton): HolidayEntry[] {
    const relevant = entries.filter(e => {
        if (GENEVA_ONLY_HOLIDAY_NAMES.includes(e.name)) return canton === 'GE';
        if (VAUD_ONLY_HOLIDAY_NAMES.includes(e.name)) return canton === 'VD';
        return true; // commun aux deux cantons
    });
    const seen = new Set<string>();
    const result: HolidayEntry[] = [];
    for (const e of relevant) {
        const key = e.date.toISOString().slice(0, 10);
        if (!seen.has(key)) { seen.add(key); result.push(e); }
    }
    return result;
}

export interface HolidaySet {
    /** Fériés ouvrés, "à ce jour" — graphiques/tableaux mensuels "à ce jour". */
    toDate: Date[];
    /** Fériés ouvrés, année complète — H. théoriques année complète. */
    fullYear: Date[];
    /** TOUTES les dates officielles (même week-end) — "Jours fériés calculés". */
    rawFullYear: Date[];
    /** Fériés de l'année avec leur libellé (même week-end), et la source de la liste. */
    entries: HolidayEntry[];
    source: 'odoo' | 'formule';
}

/**
 * Jeu de jours fériés par canton : source réelle Odoo si disponible pour l'année (dédupliquée,
 * classée par canton), sinon calcul par formule (getVaudHolidayDates — Vaud uniquement, pas de
 * variante Genève en secours). Voir docs/JOURS_FERIES_ODOO.md pour le détail de cette décision.
 */
export function buildHolidaysByCanton(
    odooEntries: HolidayEntry[] | null, annee: number, now: Date = new Date()
): Record<Canton, HolidaySet> {
    const resolve = (canton: Canton): HolidaySet => {
        if (odooEntries) {
            const entries = holidayEntriesForCanton(odooEntries, canton);
            const relevant = entries.map(e => e.date);
            const weekdaysOnly = relevant.filter(h => !isWeekend(h));
            return {
                toDate: weekdaysOnly.filter(h => h <= now),
                fullYear: weekdaysOnly,
                rawFullYear: relevant,
                entries,
                source: 'odoo',
            };
        }
        const fullYear = getVaudHolidayDates(annee, false);
        return {
            toDate: getVaudHolidayDates(annee),
            fullYear,
            rawFullYear: fullYear,
            entries: getVaudHolidayEntries(annee, false),
            source: 'formule',
        };
    };
    return { VD: resolve('VD'), GE: resolve('GE') };
}

export function computeMonthlyTheo(
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

/** Période de contrat : du `start` au `end` inclus (`end` null = toujours actif). */
export interface ContractPeriod { start: Date; end: Date | null; hoursPerDay: number; }

/**
 * Segment du théorique : intersection d'une période de contrat avec un mois. Un mois est coupé en
 * plusieurs segments si le contrat change en cours de mois (ex. 90% jusqu'au 15 février, puis 80%).
 */
export interface TheoSegment {
    /** Mois, index 0-11. */
    month: number;
    from: Date;
    to: Date;
    /** Jours du lundi au vendredi entre `from` et `to`. */
    workingDays: number;
    /** Jours fériés ouvrés tombant entre `from` et `to` (déduits). */
    holidays: Date[];
    hoursPerDay: number;
    /** (workingDays − holidays) × hoursPerDay, non arrondi. */
    hours: number;
}

/**
 * Heures théoriques par segment : (jours ouvrés lun–ven − jours fériés ouvrés) × hours_per_day,
 * pour chaque période de contrat qui chevauche chaque mois. Les fériés ne sont déduits que s'ils
 * tombent dans la fenêtre de contrat du segment (pas avant l'embauche, pas après le départ).
 * toDate=true coupe au jour courant (mois futurs : aucun segment ; mois en cours : jusqu'à
 * aujourd'hui) ; toDate=false = année complète.
 * Exemple : contrat A (90%, jusqu'au 15 fév) + contrat B (80%, dès le 16 fév) → 2 segments en
 * février : (jours ouvrés du 1 au 15 − fériés) × hpd_A et (jours ouvrés du 16 au 28 − fériés) × hpd_B.
 * Source unique du théorique pour le dashboard ET l'export Excel, pour qu'ils ne divergent jamais.
 */
export function computeTheoSegments(
    periods: ContractPeriod[],
    year: number,
    holidayDates: Date[],
    toDate: boolean = true
): TheoSegment[] {
    const now = new Date();
    const isCurrentYear = now.getFullYear() === year;
    const segments: TheoSegment[] = [];

    for (let m = 0; m < 12; m++) {
        if (toDate && year > now.getFullYear()) break; // année future → aucun segment
        if (toDate && isCurrentYear && m > now.getMonth()) continue; // mois futur → aucun segment

        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const lastDay = (toDate && isCurrentYear && m === now.getMonth()) ? now.getDate() : daysInMonth;
        const monthStart = new Date(year, m, 1);
        const monthEnd = new Date(year, m, lastDay);

        for (const c of periods) {
            const cEnd = c.end ?? monthEnd; // contrat encore actif → pas de borne de fin
            const from = c.start > monthStart ? c.start : monthStart;
            const to = cEnd < monthEnd ? cEnd : monthEnd;
            if (from > to) continue; // cette période ne chevauche pas ce mois

            let workingDays = 0;
            for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
                const dow = d.getDay();
                if (dow !== 0 && dow !== 6) workingDays++;
            }
            const holidays = holidayDates.filter(h => h >= from && h <= to);
            segments.push({
                month: m,
                from: new Date(from),
                to: new Date(to),
                workingDays,
                holidays,
                hoursPerDay: c.hoursPerDay,
                hours: (workingDays - holidays.length) * c.hoursPerDay,
            });
        }
    }
    return segments;
}

/** Théorique par mois (12 valeurs) = Σ des segments du mois, arrondi à 2 décimales. */
export function monthlyTheoFromSegments(segments: TheoSegment[]): number[] {
    const totals = Array<number>(12).fill(0);
    for (const s of segments) totals[s.month] += s.hours;
    return totals.map(t => Math.round(t * 100) / 100);
}

export interface TheoEmployeeFields {
    hours_per_day: string | number | null;
    first_contract_date: string | Date | null;
    departure_date: string | Date | null;
}

/**
 * Périodes servant au théorique d'un employé : ses contrats (hr_contract) s'il en a, sinon une
 * période unique tirée de sa fiche employé (first_contract_date → departure_date, hours_per_day
 * de son calendrier, 8h par défaut) — repli utilisé quand aucun contrat n'est extrait pour lui.
 */
export function theoPeriodsForEmployee(
    contracts: ContractPeriod[] | undefined,
    emp: TheoEmployeeFields,
    year: number
): { periods: ContractPeriod[]; source: 'contrat' | 'fiche_employe' } {
    if (contracts && contracts.length > 0) {
        return { periods: contracts, source: 'contrat' };
    }
    const parseDate = (s: string | Date | null): Date | null => {
        if (!s || s === 'False') return null;
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    };
    return {
        periods: [{
            start: parseDate(emp.first_contract_date) ?? new Date(year, 0, 1),
            end: parseDate(emp.departure_date),
            hoursPerDay: parseFloat(String(emp.hours_per_day ?? '')) || 8,
        }],
        source: 'fiche_employe',
    };
}

/**
 * Canton de travail par employé (Vaud/Genève), pour choisir le bon jeu de jours fériés.
 * Requête défensive : si work_location_name n'est pas encore extrait (avant le prochain run de
 * stage1_hr), tout le monde retombe sur Vaud.
 */
export async function loadCantonByEmployee(): Promise<Record<number, Canton>> {
    const map: Record<number, Canton> = {};
    try {
        const res = await pool.query(
            `SELECT id, work_location_name FROM staging.hr_employee WHERE work_location_name IS NOT NULL`
        );
        res.rows.forEach(r => {
            map[r.id] = cantonFromWorkLocation(r.work_location_name);
        });
    } catch (_) {
        // Colonne pas encore extraite — repli Vaud
    }
    return map;
}

/**
 * Historique COMPLET des contrats par employé (pas seulement le plus récent) — sert au théorique
 * mensuel en tenant compte d'un changement de taux d'activité en cours de mois (demande
 * utilisateur du 2026-09-16). 'open' et 'close' inclus (un contrat clos reste un historique
 * réel) ; 'draft'/'cancel' exclus (jamais entrés en vigueur).
 */
export async function loadContractsByEmployee(): Promise<Record<number, ContractPeriod[]>> {
    const map: Record<number, ContractPeriod[]> = {};
    try {
        const res = await pool.query(
            `SELECT c.employee_id, c.date_start, c.date_end,
                    COALESCE(rc.hours_per_day, 8) AS hours_per_day
             FROM staging.hr_contract c
             LEFT JOIN staging.resource_calendar rc ON c.resource_calendar_id = rc.id
             WHERE c.state IN ('open', 'close') AND c.date_start IS NOT NULL
             ORDER BY c.employee_id, c.date_start::date ASC`
        );
        res.rows.forEach(r => {
            const empId = r.employee_id;
            if (!map[empId]) map[empId] = [];
            map[empId].push({
                start: new Date(r.date_start),
                end: r.date_end ? new Date(r.date_end) : null,
                hoursPerDay: parseFloat(r.hours_per_day) || 8,
            });
        });
    } catch (_) {
        // staging.hr_contract pas encore extrait — repli sur la fiche employé (theoPeriodsForEmployee)
    }
    return map;
}
