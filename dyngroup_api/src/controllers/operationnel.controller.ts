import { Request, Response } from "express";
import { pool } from "../db/pool";
import {
    buildHolidaysByCanton,
    holidaysToMonthly,
    computeMonthlyTheo,
    resolveOdooHolidayEntries,
    loadCantonByEmployee,
    loadContractsByEmployee,
    theoPeriodsForEmployee,
    computeTheoSegments,
    monthlyTheoFromSegments,
} from "../services/theo-hours";

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

        // Jours fériés par canton (calendrier Odoo, repli formule Vaud) — voir services/theo-hours.ts.
        const holidaysByCanton = buildHolidaysByCanton(odooHolidays, annee, now);
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
        // Chaîne de secours : staging.hr_leave_allocation (live) → table KPI (repli) → défaut
        // 22 jours (176h). staging.hr_leave_allocation d'abord (2026-09-22) : c'est la lecture
        // directe des allocations Odoo, toujours à jour ; kpi.operationnel_solde_vacances est un
        // calcul figé d'un ancien run Airflow, jamais resynchronisé depuis — repéré en désaccord
        // avec Odoo pour BURION Jade (172.8h vs 172.43h réels, une allocation ajoutée après ce
        // calcul). La table KPI ne sert plus que de repli si staging n'est pas encore extraite.
        const empVacMap: Record<number, number> = {};
        const vacSources: (() => Promise<boolean>)[] = [
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
            },
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

        // Canton de travail par employé (Vaud/Genève), pour choisir le bon jeu de jours fériés
        // (holidaysByCanton ci-dessus) — voir services/theo-hours.ts.
        const empCantonMap = await loadCantonByEmployee();

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
        // d'un changement de taux d'activité en cours de mois. Voir services/theo-hours.ts.
        const empContractsMap = await loadContractsByEmployee();

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
            // Périodes de contrat de l'employé (repli sur la fiche employé si aucun contrat
            // extrait), découpées en segments mensuels — même calcul que l'export Excel du
            // "Tableau de suivi mensuel détaillé", voir services/theo-hours.ts.
            const { periods } = theoPeriodsForEmployee(empContractsMap[emp.id], emp, annee);
            const theoOf = (holidayDates: Date[], toDate: boolean) =>
                monthlyTheoFromSegments(computeTheoSegments(periods, annee, holidayDates, toDate));
            // Référence "100%" pour l'ETP (demande utilisateur du 2026-09-16) : même fenêtre de
            // présence (dates de contrat) et même canton que l'employé, mais SANS le taux
            // d'activité — hoursPerDay forcé à 8 sur chaque intervalle. ETP = théorique réel ÷
            // cette référence 100% (ex: 128h / 160h = 0.8 pour un contrat à 80%), pas
            // réalisé/théorique (qui reste le "Taux effort", une mesure différente).
            const periods100 = periods.map(p => ({ ...p, hoursPerDay: 8 }));
            const theo100Of = (holidayDates: Date[], toDate: boolean) =>
                monthlyTheoFromSegments(computeTheoSegments(periods100, annee, holidayDates, toDate));
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
                // Catégories dynamiques (2026-09-30) : plus de liste figée (admin/vacances/rh_it/
                // marketing/formation/maladie) — chaque clé est créée à la volée depuis le nom réel
                // du type de congé Odoo ou de la tâche, voir la requête "Non-facturable categories"
                // plus bas. Une nouvelle catégorie ajoutée dans Odoo (nouveau type de congé, nouvelle
                // tâche sous "CLIENT DYN SA - INTERNE") apparaît automatiquement, sans code à changer.
                non_fact: {} as Record<string, number[]>,
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
            // Catégories 100% DYNAMIQUES (2026-09-30, demande utilisateur) — plus de liste figée
            // (admin/vacances/rh_it/marketing/formation/maladie) : chaque catégorie est le nom réel
            // Odoo, découvert à la volée, pour qu'un nouveau type de congé ou une nouvelle tâche
            // ajoutés dans Odoo apparaissent automatiquement sans modification de code.
            // - Congé : account_analytic_line.holiday_id → hr_leave → hr_leave_type.name (le VRAI
            //   type de congé), pas un motif texte sur le nom de la ligne. Odoo nomme chaque ligne
            //   générée automatiquement "Congé (X/N)" où X = le jour DANS la demande (pas le type
            //   de congé) et N = le nombre total de jours de cette demande — un congé de 10 jours
            //   produit "Congé (1/10)" à "Congé (10/10)". Un ancien filtre LIKE 'Congé (1/%' ne
            //   capturait donc que le 1er jour de chaque congé, et LIKE 'Congé (7/%'/'8/%'/'14/%'
            //   (censé cibler les types de congé maladie 7/8/14) attrapait par collision les jours
            //   7, 8 et 14 de N'IMPORTE QUEL congé multi-jours — vérifié sur AGACHII Igor : 136h de
            //   vacances validées éclatées en 56h "vacances" + 16h "maladie" + 64h "admin" selon la
            //   position du jour dans la demande. holiday_id est fiable quelle que soit la durée.
            // - Tâche : le nom de la tâche Odoo (project_task.name) directement, scopé au projet
            //   "CLIENT DYN SA - INTERNE" (nomenclature stable/curatée par les RH, contrairement au
            //   texte libre saisi par chacun) — plus de regroupement par mot-clé (formation/
            //   marketing/rh-it) en dur.
            // - "Administratif" = repli (heures non productives qui ne sont ni un congé, ni une
            //   tâche de ce projet) — inclut le vrai travail client non encore flagué "Productivité"
            //   dans Odoo (cas non résolu ici, dépend de la saisie Odoo — vérifié sur NETO DA SILVA
            //   Inês).
            pool.query(
                `SELECT
                   aal.employee_id,
                   EXTRACT(MONTH FROM aal.date::date)::int AS mois,
                   -- Ne garde que la partie avant la parenthèse du nom Odoo (ex. "Formation
                   -- (Nouveaux collaborateurs-trices et personnes en formation)" -> "Formation") :
                   -- les tâches de "CLIENT DYN SA - INTERNE" suivent la convention "Libellé
                   -- court (détail long)" — reste dynamique (aucun nom en dur), juste plus lisible
                   -- (2026-09-30, demande utilisateur).
                   COALESCE(
                     TRIM(SPLIT_PART(hlt.name, '(', 1)),
                     CASE WHEN pp.name = 'CLIENT DYN SA - INTERNE' THEN TRIM(SPLIT_PART(pt.name, '(', 1)) END,
                     'Administratif'
                   ) AS category,
                   SUM(aal.unit_amount) AS hours
                 FROM staging.account_analytic_line aal
                 LEFT JOIN staging.project_task pt ON pt.id = aal.task_id
                 LEFT JOIN staging.project_project pp ON pp.id = pt.project_id
                 LEFT JOIN staging.hr_leave hl ON hl.id = aal.holiday_id
                 LEFT JOIN staging.hr_leave_type hlt ON hlt.id = hl.holiday_status_id
                 WHERE (aal.productivity = false OR aal.productivity IS NULL)
                   AND aal.date IS NOT NULL
                   AND EXTRACT(YEAR FROM aal.date::date) = $1
                   -- Même exclusion que "H. réalisées"/"H. Productivité" (requêtes 10/11) : les
                   -- lignes "Congé (N/M)" à amount=0, auto-générées par Odoo pour les jours fériés
                   -- d'entreprise (pas liées à un hr.leave personnel, holiday_id est NULL pour
                   -- elles), ne sont pas de vraies heures — sans cette exclusion elles gonflaient
                   -- "Administratif" au-delà de (H.réalisées - H.Productivité).
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

        // 12. Tarif horaire par employé/mois, saisi dans l'onglet "Objectif" de la fiche employé
        // (x_suivi_annuel_employe.x_studio_tarif_horaire, même ligne que Objectif CHF) — remplace
        // la moyenne des tarifs des timesheets (demande utilisateur du 2026-10-05). Pas de repli :
        // ligne absente, tarif vide ou 0 → tarif 0 → CA réalisé 0 pour ce mois. MAX si plusieurs
        // lignes pour le même mois. Casté via texte : la colonne reste TEXT tant que le full
        // refresh hebdomadaire de stage1_hr ne l'a pas retypée. Défensif : colonne pas encore
        // extraite → tous les tarifs à 0.
        const tarifMoisMap: Record<string, number> = {};
        try {
            const tarifMoisRes = await pool.query(
                `SELECT x_studio_employ AS employee_id,
                        EXTRACT(MONTH FROM x_studio_mois_objectif::date)::int AS mois,
                        MAX(COALESCE(NULLIF(TRIM(x_studio_tarif_horaire::text), '')::numeric, 0)) AS tarif
                 FROM staging.x_suivi_annuel_employe
                 WHERE x_active = true AND x_studio_employ IS NOT NULL
                   AND x_studio_mois_objectif IS NOT NULL
                   AND EXTRACT(YEAR FROM x_studio_mois_objectif::date) = $1
                 GROUP BY x_studio_employ, mois`,
                [annee]
            );
            tarifMoisRes.rows.forEach(r => {
                tarifMoisMap[`${r.employee_id}_${r.mois}`] = parseFloat(r.tarif) || 0;
            });
        } catch (e: any) {
            console.warn('[operationnel] tarif horaire (onglet Objectif) indisponible, CA réalisé à 0 :', e.message);
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
        // toutes les heures réalisées) × tarif horaire du mois saisi dans l'onglet "Objectif"
        // de la fiche employé (requête 12). Sans tarif pour le mois (absent, vide ou 0), le CA
        // réalisé du mois vaut 0 — plus de repli sur un tarif de référence (2026-10-05).
        employees.forEach(emp => {
            const c = collab[emp.name];
            for (let m = 0; m < 12; m++) {
                const tarif = tarifMoisMap[`${emp.id}_${m + 1}`] || 0;
                c.ca_real[m] = Math.round(c.productif[m] * tarif * 100) / 100;
            }
            // Tarif horaire "effectif" de l'employé sur l'année = CA réalisé total ÷ heures
            // productives totales (moyenne des tarifs mensuels pondérée par les heures, un mois
            // sans tarif comptant à 0). 0 si aucune heure productive cette année.
            const totalCaEmp = c.ca_real.reduce((s: number, v: number) => s + v, 0);
            const totalHeuresEmp = c.productif.reduce((s: number, v: number) => s + v, 0);
            c.tarif_effectif = totalHeuresEmp > 0 ? Math.round((totalCaEmp / totalHeuresEmp) * 100) / 100 : 0;
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

        // Process non-facturable categories breakdown, par mois — catégories dynamiques : on crée
        // la clé (tableau de 12 mois) à la première rencontre de cette catégorie pour cet employé.
        nonFactRes.rows.forEach(row => {
            const empName = empNameMap[row.employee_id];
            const mIdx = row.mois - 1;
            if (empName && collab[empName] && mIdx >= 0 && mIdx < 12 && row.category) {
                if (!collab[empName].non_fact[row.category]) {
                    collab[empName].non_fact[row.category] = Array(12).fill(0);
                }
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
        // pondérée par les heures qui génèrent effectivement ce CA) — cohérent avec le CA réalisé
        // affiché (voir tarif_effectif ci-dessus). 0 si personne n'a d'heures productives sur
        // l'année : plus de repli sur un tarif de référence (2026-10-05).
        let totalCaRealAnnuel = 0;
        let totalHeuresRealAnnuel = 0;
        Object.values(collab).forEach((c: any) => {
            totalCaRealAnnuel += c.ca_real.reduce((s: number, v: number) => s + v, 0);
            totalHeuresRealAnnuel += c.productif.reduce((s: number, v: number) => s + v, 0);
        });
        const tarifGlobal = totalHeuresRealAnnuel > 0
            ? Math.round((totalCaRealAnnuel / totalHeuresRealAnnuel) * 100) / 100
            : 0;

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

        // --- KR12 — Rapports livrés (délai moyen de clôture des projets) ---------------------
        // Déplacé du dashboard Finance vers Indicateurs Clés (demande utilisateur du 2026-10-05).
        // Filtré sur l'année sélectionnée ; pas de filtre société ici (project_project n'est pas
        // rattaché aux employés affichés par ce contrôleur, contrairement au reste des données).
        let kr12: { period_key: string; actual_value: number | null; target_value: number; status: string }[] = [];
        try {
            const r = await pool.query(
                `SELECT TO_CHAR(write_date::date, 'YYYY-MM') AS month,
                        ROUND(AVG(write_date::date - COALESCE(date_start::date, create_date::date))::numeric, 2) AS avg_days
                 FROM staging."project_project"
                 WHERE active = FALSE
                   AND write_date IS NOT NULL AND write_date <> '' AND write_date <> 'False'
                   AND EXTRACT(YEAR FROM write_date::date) = $1
                 GROUP BY 1 ORDER BY 1`,
                [annee]
            );
            // Seuils repris de l'ancien KR_CONFIG.KR12 (finance.controller.ts) : cible 10 jours,
            // orange dès +1 jour au-dessus, rouge dès +2 jours au-dessus.
            const TARGET = 10, ORANGE_DELTA = 1, RED_DELTA = 2;
            kr12 = r.rows.map((row: any) => {
                const actual = row.avg_days !== null ? parseFloat(row.avg_days) : null;
                let status = "unknown";
                if (actual !== null) {
                    const diff = actual - TARGET;
                    status = diff >= RED_DELTA ? "red" : diff >= ORANGE_DELTA ? "orange" : "green";
                }
                return { period_key: row.month as string, actual_value: actual, target_value: TARGET, status };
            });
        } catch (e: any) {
            console.warn("[operationnel] KR12 (rapports livrés) indisponible :", e.message);
        }

        res.json({
            collab,
            departments,
            companies,
            kr12,
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