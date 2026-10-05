import { pool } from "../../../db/pool";
import { DataSheet, FormulaCell, KpiExport } from "../../excel/kpi-export.types";
import { cellRef, columnRange } from "../../excel/workbook-builder";
import { EmployeeScope, OperationnelExportFilters } from "../export-filters";

// Export du graphique "Heures non facturables cumulées" (onglet Indicateurs Clés).
//   Périmètre = heures NON productives (Productivité ≠ Oui), hors jours fériés fictifs d'Odoo
//   Catégorie = type de congé (si la ligne vient d'un congé), sinon tâche du projet
//               "CLIENT DYN SA - INTERNE", sinon "Administratif" ; partie avant "(" du nom
//   Valeur    = Σ heures par catégorie sur les collaborateurs et mois du filtre ; seules les
//               catégories > 0 h sont affichées, triées par volume décroissant
// (operationnel.controller.ts, requête 8 ; graphique chNonFact du dashboard).
// Chaîne de calcul, par formules Excel :
//   Timesheets → Par collaborateur → Heures non facturables.
// Les textes du classeur sont destinés au client : pas de noms de champs Odoo.

const PROJET_INTERNE = "CLIENT DYN SA - INTERNE";
const ADMINISTRATIF = "Administratif";

const HEURES = "0.00";
const DATE = "dd.mm.yyyy";

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");
const frDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const formule = (formula: string, result: number | string): FormulaCell => ({ formula, result });

export async function exportHeuresNonFacturables(
    filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    const collabParId = new Map(scope.employees.map(e => [e.id, e]));

    // --- Requête (mêmes conditions et même catégorisation que le dashboard) -------------------
    // Le projet qui décide de la catégorie est celui de la TÂCHE (pt.project_id), comme dans le
    // dashboard. Catégorie vide (nom Odoo commençant par "(") → ignorée, comme le dashboard.
    const lignes = (await pool.query(
        `SELECT TO_CHAR(aal.date::date, 'YYYY-MM-DD') AS date, aal.employee_id, aal.name AS libelle,
                aal.unit_amount AS heures, pp.name AS projet, pt.name AS tache, hlt.name AS type_conge,
                COALESCE(
                  TRIM(SPLIT_PART(hlt.name, '(', 1)),
                  CASE WHEN pp.name = $4 THEN TRIM(SPLIT_PART(pt.name, '(', 1)) END,
                  $5
                ) AS categorie,
                CASE WHEN hlt.name IS NOT NULL THEN 'conge'
                     WHEN pp.name = $4 AND pt.name IS NOT NULL THEN 'tache'
                     ELSE 'repli' END AS origine
         FROM staging.account_analytic_line aal
         LEFT JOIN staging.project_task pt ON pt.id = aal.task_id
         LEFT JOIN staging.project_project pp ON pp.id = pt.project_id
         LEFT JOIN staging.hr_leave hl ON hl.id = aal.holiday_id
         LEFT JOIN staging.hr_leave_type hlt ON hlt.id = hl.holiday_status_id
         WHERE aal.employee_id = ANY($1::int[])
           AND (aal.productivity = false OR aal.productivity IS NULL)
           AND aal.date IS NOT NULL
           AND aal.date::date BETWEEN $2::date AND $3::date
           AND NOT (aal.name LIKE 'Congé (%' AND aal.amount = 0)
         ORDER BY aal.date::date, aal.employee_id, aal.id`,
        [scope.employeeIds, scope.dateFrom, scope.dateTo, PROJET_INTERNE, ADMINISTRATIF]
    )).rows;

    // --- Feuille "Timesheets" : lignes non productives de la période ---------------------------
    const ORIGINES: Record<string, string> = {
        conge: "Type de congé",
        tache: "Tâche interne",
        repli: "Administratif (par défaut)",
    };
    const heuresParCollabCategorie = new Map<string, Map<string, number>>();
    const timesheets: DataSheet = {
        name: "Timesheets",
        description: "Lignes de feuille de temps non productives de la période (hors « Congé (…) » à 0 CHF), avec leur catégorie",
        columns: [
            { header: "Date", key: "date", width: 12, numFmt: DATE },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Projet de la tâche", key: "projet", width: 30 },
            { header: "Tâche", key: "tache", width: 34 },
            { header: "Type de congé", key: "type_conge", width: 24 },
            { header: "Libellé", key: "libelle", width: 50 },
            { header: "Heures", key: "heures", width: 9, numFmt: HEURES },
            { header: "Catégorie", key: "categorie", width: 24 },
            { header: "Catégorie déterminée par", key: "origine", width: 24 },
        ],
        rows: [],
    };
    lignes.forEach(l => {
        const collab = collabParId.get(l.employee_id);
        if (!collab) return;
        const [an, mois, jour] = l.date.split("-").map(Number);
        const heures = parseFloat(l.heures) || 0;
        const categorie: string = l.categorie ?? "";
        if (categorie) {
            const parCategorie = heuresParCollabCategorie.get(collab.name) ?? new Map<string, number>();
            parCategorie.set(categorie, (parCategorie.get(categorie) ?? 0) + heures);
            heuresParCollabCategorie.set(collab.name, parCategorie);
        }
        timesheets.rows.push({
            date: new Date(Date.UTC(an, mois - 1, jour)),
            mois,
            collab: collab.name,
            societe: collab.company ?? "",
            projet: l.projet ?? "",
            tache: l.tache ?? "",
            type_conge: l.type_conge ?? "",
            libelle: l.libelle ?? "",
            heures,
            categorie,
            origine: ORIGINES[l.origine] ?? "",
        });
    });

    // --- Feuille "Par collaborateur" : heures par collaborateur et catégorie -------------------
    const parCollab: DataSheet = {
        name: "Par collaborateur",
        description: "Heures non facturables par collaborateur et par catégorie sur la période, sommées depuis Timesheets",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Catégorie", key: "categorie", width: 24 },
            { header: "Heures", key: "heures", width: 10, numFmt: HEURES },
        ],
        rows: [],
    };
    const heuresParCategorie = new Map<string, number>();
    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(collab => {
        const parCategorie = heuresParCollabCategorie.get(collab.name);
        if (!parCategorie) return;
        [...parCategorie.entries()]
            .filter(([, heures]) => heures !== 0)
            .sort((a, b) => b[1] - a[1])
            .forEach(([categorie, heures]) => {
                const ligne = parCollab.rows.length;
                heuresParCategorie.set(categorie, (heuresParCategorie.get(categorie) ?? 0) + heures);
                parCollab.rows.push({
                    collab: collab.name,
                    societe: collab.company ?? "",
                    categorie,
                    heures: formule(
                        `SUMIFS(${columnRange(timesheets, "heures")},${columnRange(timesheets, "collab")},${cellRef(parCollab, "collab", ligne)},${columnRange(timesheets, "categorie")},${cellRef(parCollab, "categorie", ligne)})`,
                        heures
                    ),
                });
            });
    });

    // --- Feuille "Heures non facturables" : les barres du graphique (ligne Total) --------------
    const resultat: DataSheet = {
        name: "Heures non facturables",
        description: "Données du graphique : heures cumulées par catégorie (> 0 h, par volume décroissant) + Total",
        columns: [
            { header: "Catégorie", key: "categorie", width: 28 },
            { header: "Heures", key: "heures", width: 12, numFmt: HEURES },
            { header: "Part du total (%)", key: "part", width: 17, numFmt: "0.00" },
        ],
        rows: [],
        lastRowIsTotal: true,
    };
    const categories = [...heuresParCategorie.entries()]
        .filter(([, heures]) => heures > 0)
        .sort((a, b) => b[1] - a[1]);
    const total = categories.reduce((s, [, heures]) => s + heures, 0);
    const ligneTotal = categories.length;
    const celluleTotal = cellRef(resultat, "heures", ligneTotal);
    categories.forEach(([categorie, heures]) => {
        const ligne = resultat.rows.length;
        resultat.rows.push({
            categorie,
            heures: formule(
                `SUMIFS(${columnRange(parCollab, "heures")},${columnRange(parCollab, "categorie")},${cellRef(resultat, "categorie", ligne)})`,
                round2(heures)
            ),
            part: formule(`IF(${celluleTotal}>0,${cellRef(resultat, "heures", ligne)}/${celluleTotal}*100,0)`, total > 0 ? (heures / total) * 100 : 0),
        });
    });
    resultat.rows.push({
        categorie: "Total",
        heures: formule(
            ligneTotal > 0 ? `SUM(${cellRef(resultat, "heures", 0)}:${cellRef(resultat, "heures", ligneTotal - 1)})` : "0",
            round2(total)
        ),
        part: ligneTotal > 0 ? 100 : 0,
    });

    // --- Fiche et chemin de calcul ------------------------------------------------------------
    const nbCollab = scope.employees.length;
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""}, du ${frDate(new Date(scope.dateFrom))} au ${frDate(new Date(scope.dateTo))}`;
    const nbParOrigine = (origine: string) => timesheets.rows.filter(r => r.origine === ORIGINES[origine]).length;
    const exclusion = "Hors lignes « Congé (…) » à 0 CHF (jours fériés générés par Odoo, pas du travail)";
    const regleCategorie = `Type de congé si la ligne vient d'un congé ; sinon tâche du projet « ${PROJET_INTERNE} » ; sinon « ${ADMINISTRATIF} ». Seule la partie du nom avant « ( » est gardée`;

    return {
        definition: {
            id: "heures-non-facturables",
            titre: "Heures non facturables cumulées",
            onglet: "Indicateurs Clés",
            description: "Répartition par catégorie des heures non productives de la période",
            metier: "Où part le temps qui n'est pas facturé",
            formule: "Σ heures non productives par catégorie",
            sourceOdoo: "Feuilles de temps (case « Productivité » non cochée), types de congé, tâches du projet interne",
            tables: [
                "staging.account_analytic_line", "staging.project_task", "staging.project_project",
                "staging.hr_leave", "staging.hr_leave_type", "staging.hr_employee", "staging.res_company",
                "kpi.operationnel_suivi_mensuel",
            ],
            colonnes: [
                {
                    nom: "Catégorie",
                    description: "Nature du temps non facturable",
                    metier: "Congés, tâches internes, administratif",
                    formule: regleCategorie,
                    source: "Types de congé + tâches du projet interne",
                    commentaire: `« ${ADMINISTRATIF} » inclut aussi du travail client pas encore marqué « Productivité » dans Odoo`,
                },
                {
                    nom: "Heures",
                    description: "Heures non productives cumulées sur la période",
                    metier: "Volume de temps non facturé",
                    formule: "Σ heures de timesheet avec Productivité ≠ Oui",
                    source: "Timesheets",
                    commentaire: `${exclusion}. Seules les catégories > 0 h sont affichées`,
                },
            ],
        },
        derivation: [
            {
                label: "Heures non facturables (total)", formula: cellRef(resultat, "heures", ligneTotal, true), value: round2(total), numFmt: HEURES,
                children: [
                    { label: "Périmètre", detail: perimetre },
                    { label: "Source", detail: `${timesheets.rows.length} lignes de timesheet non productives (Timesheets)` },
                    { label: "Exclusion", detail: exclusion },
                    {
                        label: "Catégorie", detail: regleCategorie,
                        children: [
                            { label: "Type de congé", value: nbParOrigine("conge"), detail: "lignes classées d'après leur type de congé" },
                            { label: "Tâche interne", value: nbParOrigine("tache"), detail: `lignes classées d'après leur tâche du projet « ${PROJET_INTERNE} »` },
                            { label: ADMINISTRATIF, value: nbParOrigine("repli"), detail: "lignes sans congé ni tâche interne" },
                        ],
                    },
                    { label: "Agrégation", detail: `Σ par collaborateur et catégorie (Par collaborateur) → Σ par catégorie → ${categories.length} catégories > 0 h (Heures non facturables)` },
                ],
            },
        ],
        sheets: [resultat, parCollab, timesheets],
    };
}
