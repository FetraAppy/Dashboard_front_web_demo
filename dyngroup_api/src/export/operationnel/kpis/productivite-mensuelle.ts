import { pool } from "../../../db/pool";
import { DataSheet, FormulaCell, KpiExport } from "../../excel/kpi-export.types";
import { cellRef, columnRange } from "../../excel/workbook-builder";
import { EmployeeScope, MOIS, OperationnelExportFilters } from "../export-filters";

// Export de la carte EFFICACITÉ "Productivité mensuelle" (Indicateurs Clés).
//   Productivité mensuelle = H. productives ÷ H. réalisées × 100   (kpiProductivity du dashboard)
//   H. réalisées  = Σ heures de timesheet, hors jours fériés fictifs   (operationnel.controller.ts, requête 10)
//   H. productives = même périmètre, Productivité = Oui                (operationnel.controller.ts, requête 11)
// Sur la période affichée, c'est le rapport des totaux (pas une moyenne des taux mensuels).
// Chaîne de calcul, par formules Excel :
//   Timesheets → Par collaborateur → Productivité mensuelle.
// Les textes du classeur sont destinés au client : pas de noms de champs Odoo.

// Seuils du dashboard (OBJECTIF_PRODUCTIVITE_PCT et SEUIL_PROCHE_OBJECTIF_PCT dans
// operationnel-dashboard.component.ts, statutProductivite) : à garder identiques.
const CIBLE_PCT = 75;
const SEUIL_PROCHE_PCT = 69.1;

/** Même exclusion que "H. réalisées"/"H. Productivité" du dashboard : jours fériés fictifs Odoo. */
const EXCLUSION_FERIES_FICTIFS = "NOT (aal.name LIKE 'Congé (%' AND aal.amount = 0)";

const HEURES = "0.00";
const PCT = "0.00";
const DATE = "dd.mm.yyyy";

const pad = (n: number) => String(n).padStart(2, "0");
const frDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const formule = (formula: string, result: number | string): FormulaCell => ({ formula, result });

const tauxDe = (prod: number, real: number) => (real > 0 ? (prod / real) * 100 : null);

/** Statut de la carte : même règle que statutProductivite du dashboard. */
const statutDe = (pct: number | null) =>
    pct !== null && pct >= CIBLE_PCT ? "Objectif atteint"
    : pct !== null && pct >= SEUIL_PROCHE_PCT ? "Proche objectif"
    : "Sous objectif";

export async function exportProductiviteMensuelle(
    filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    const collabParId = new Map(scope.employees.map(e => [e.id, e]));
    const cle = (employeeId: number, mois: number) => `${employeeId}|${mois}`;

    // --- Requête (mêmes conditions que le dashboard) ------------------------------------------
    const lignes = (await pool.query(
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
    )).rows;

    // --- Feuille "Timesheets" : lignes comptées dans H. réalisées -----------------------------
    const realParCollabMois = new Map<string, number>();
    const prodParCollabMois = new Map<string, number>();
    const timesheets: DataSheet = {
        name: "Timesheets",
        description: "Lignes de feuille de temps comptées dans H. réalisées (hors « Congé (…) » à 0 CHF) ; Productivité = Oui donne H. productives",
        columns: [
            { header: "Date", key: "date", width: 12, numFmt: DATE },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Projet", key: "projet", width: 34 },
            { header: "Tâche", key: "tache", width: 34 },
            { header: "Libellé", key: "libelle", width: 50 },
            { header: "Heures", key: "heures", width: 9, numFmt: HEURES },
            { header: "Productivité", key: "productivite", width: 13 },
        ],
        rows: [],
    };
    lignes.forEach(l => {
        const collab = collabParId.get(l.employee_id);
        if (!collab) return;
        const [an, mois, jour] = l.date.split("-").map(Number);
        const heures = parseFloat(l.heures) || 0;
        const productive = l.productivity === true;
        const k = cle(collab.id, mois);
        realParCollabMois.set(k, (realParCollabMois.get(k) ?? 0) + heures);
        if (productive) prodParCollabMois.set(k, (prodParCollabMois.get(k) ?? 0) + heures);
        timesheets.rows.push({
            date: new Date(Date.UTC(an, mois - 1, jour)),
            mois,
            collab: collab.name,
            societe: collab.company ?? "",
            projet: l.projet ?? "",
            tache: l.tache ?? "",
            libelle: l.libelle ?? "",
            heures,
            productivite: productive ? "Oui" : "Non",
        });
    });

    // --- Feuille "Par collaborateur" : heures et taux, un mois du filtre par ligne -------------
    const parCollab: DataSheet = {
        name: "Par collaborateur",
        description: "H. réalisées, H. productives et productivité par collaborateur et par mois, sommées depuis Timesheets",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Nom du mois", key: "mois_nom", width: 12 },
            { header: "H. réalisées", key: "real", width: 13, numFmt: HEURES },
            { header: "H. productives", key: "prod", width: 14, numFmt: HEURES },
            { header: "Productivité (%)", key: "taux", width: 16, numFmt: PCT },
        ],
        rows: [],
    };
    const realParMois = new Map<number, number>();
    const prodParMois = new Map<number, number>();
    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(collab => {
        scope.months.forEach(mois => {
            const ligne = parCollab.rows.length;
            const colonne = (key: string) => cellRef(parCollab, key, ligne);
            const parCollabMois = `${columnRange(timesheets, "collab")},${colonne("collab")},${columnRange(timesheets, "mois")},${colonne("mois")}`;
            const real = realParCollabMois.get(cle(collab.id, mois)) ?? 0;
            const prod = prodParCollabMois.get(cle(collab.id, mois)) ?? 0;
            realParMois.set(mois, (realParMois.get(mois) ?? 0) + real);
            prodParMois.set(mois, (prodParMois.get(mois) ?? 0) + prod);
            parCollab.rows.push({
                collab: collab.name,
                mois,
                mois_nom: MOIS[mois - 1],
                real: formule(`SUMIFS(${columnRange(timesheets, "heures")},${parCollabMois})`, real),
                prod: formule(
                    `SUMIFS(${columnRange(timesheets, "heures")},${parCollabMois},${columnRange(timesheets, "productivite")},"Oui")`,
                    prod
                ),
                taux: formule(
                    `IF(${colonne("real")}>0,${colonne("prod")}/${colonne("real")}*100,"—")`,
                    tauxDe(prod, real) ?? "—"
                ),
            });
        });
    });

    // --- Feuille "Productivité mensuelle" : ce que montre la carte (ligne Total) ---------------
    const resultat: DataSheet = {
        name: "Productivité mensuelle",
        description: "Productivité par mois du filtre + Total (valeur de la carte : rapport des totaux), avec le statut",
        columns: [
            { header: "N° mois", key: "mois", width: 9 },
            { header: "Mois", key: "mois_nom", width: 16 },
            { header: "H. réalisées", key: "real", width: 13, numFmt: HEURES },
            { header: "H. productives", key: "prod", width: 14, numFmt: HEURES },
            { header: "Productivité (%)", key: "taux", width: 16, numFmt: PCT },
            { header: "Statut", key: "statut", width: 18 },
        ],
        rows: [],
        lastRowIsTotal: true,
    };
    // Statut d'une ligne de cette feuille : mêmes seuils que la carte ; « — » (aucune heure) → sous objectif.
    const statutFormule = (ligne: number) => {
        const taux = cellRef(resultat, "taux", ligne);
        return `IF(ISNUMBER(${taux}),IF(${taux}>=${CIBLE_PCT},"Objectif atteint",IF(${taux}>=${SEUIL_PROCHE_PCT},"Proche objectif","Sous objectif")),"Sous objectif")`;
    };
    const tauxFormule = (ligne: number) =>
        `IF(${cellRef(resultat, "real", ligne)}>0,${cellRef(resultat, "prod", ligne)}/${cellRef(resultat, "real", ligne)}*100,"—")`;

    let totalReal = 0;
    let totalProd = 0;
    scope.months.forEach(mois => {
        const ligne = resultat.rows.length;
        const real = realParMois.get(mois) ?? 0;
        const prod = prodParMois.get(mois) ?? 0;
        totalReal += real;
        totalProd += prod;
        const sommeDuMois = (key: string) =>
            `SUMIFS(${columnRange(parCollab, key)},${columnRange(parCollab, "mois")},${cellRef(resultat, "mois", ligne)})`;
        resultat.rows.push({
            mois,
            mois_nom: MOIS[mois - 1],
            real: formule(sommeDuMois("real"), real),
            prod: formule(sommeDuMois("prod"), prod),
            taux: formule(tauxFormule(ligne), tauxDe(prod, real) ?? "—"),
            statut: formule(statutFormule(ligne), statutDe(tauxDe(prod, real))),
        });
    });
    const ligneTotal = resultat.rows.length;
    const sommeColonne = (key: string) => `SUM(${cellRef(resultat, key, 0)}:${cellRef(resultat, key, ligneTotal - 1)})`;
    const tauxTotal = tauxDe(totalProd, totalReal);
    resultat.rows.push({
        mois: null,
        mois_nom: "Total",
        real: formule(sommeColonne("real"), totalReal),
        prod: formule(sommeColonne("prod"), totalProd),
        // Comme la carte : rapport des totaux, pas moyenne des taux mensuels.
        taux: formule(tauxFormule(ligneTotal), tauxTotal ?? "—"),
        statut: formule(statutFormule(ligneTotal), statutDe(tauxTotal)),
    });

    // --- Fiche et chemin de calcul ------------------------------------------------------------
    const total = (key: string) => cellRef(resultat, key, ligneTotal, true);
    const nbCollab = scope.employees.length;
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""}, du ${frDate(new Date(scope.dateFrom))} au ${frDate(new Date(scope.dateTo))}`;
    const nbProductives = timesheets.rows.filter(r => r.productivite === "Oui").length;
    const exclusion = "Hors lignes « Congé (…) » à 0 CHF (jours fériés générés par Odoo, pas du travail)";
    const seuils = `≥ ${CIBLE_PCT}% : objectif atteint (vert) · ≥ ${SEUIL_PROCHE_PCT}% : proche objectif (orange) · sinon sous objectif (rouge)`;

    return {
        definition: {
            id: "productivite-mensuelle",
            titre: "Productivité mensuelle",
            onglet: "Indicateurs Clés",
            description: "Part des heures réalisées qui sont productives",
            metier: "Efficacité réelle du travail",
            formule: "H. productives ÷ H. réalisées × 100",
            cible: seuils,
            sourceOdoo: "Feuilles de temps, case « Productivité »",
            tables: [
                "staging.account_analytic_line", "staging.project_project", "staging.project_task",
                "staging.hr_employee", "staging.res_company", "kpi.operationnel_suivi_mensuel",
            ],
            colonnes: [
                {
                    nom: "H. réalisées",
                    description: "Heures saisies en feuille de temps",
                    metier: "Présence / activité réelle",
                    formule: "Σ heures de timesheet",
                    source: "Timesheets",
                    commentaire: exclusion,
                },
                {
                    nom: "H. productives",
                    description: "Heures marquées « productives »",
                    metier: "Volume de travail à valeur ajoutée",
                    formule: "Σ heures de timesheet avec Productivité = Oui",
                    source: "Timesheets",
                    commentaire: exclusion,
                },
                {
                    nom: "Productivité",
                    description: "% du réalisé qui est productif",
                    metier: "Efficacité réelle du travail",
                    formule: "H. productives ÷ H. réalisées × 100",
                    source: "Calculé",
                    commentaire: `Total : rapport des totaux, pas moyenne des mois. ${seuils}. « — » si aucune heure réalisée`,
                },
            ],
        },
        derivation: [
            {
                label: "Productivité mensuelle (%)", formula: total("taux"), value: tauxTotal ?? "—", numFmt: PCT,
                children: [
                    { label: "Calcul", detail: "H. productives ÷ H. réalisées × 100 sur la période (rapport des totaux)" },
                    {
                        label: "H. productives", formula: total("prod"), value: totalProd, numFmt: HEURES,
                        children: [
                            { label: "Source", detail: `${nbProductives} lignes avec Productivité = Oui (Timesheets)` },
                            { label: "Agrégation", detail: "Σ par collaborateur et mois (Par collaborateur) → Σ par mois → Σ des mois" },
                        ],
                    },
                    {
                        label: "H. réalisées", formula: total("real"), value: totalReal, numFmt: HEURES,
                        children: [
                            { label: "Périmètre", detail: perimetre },
                            { label: "Source", detail: `${timesheets.rows.length} lignes de timesheet (Timesheets)` },
                            { label: "Exclusion", detail: exclusion },
                            { label: "Agrégation", detail: "Σ par collaborateur et mois (Par collaborateur) → Σ par mois → Σ des mois" },
                        ],
                    },
                    { label: "Statut", formula: total("statut"), value: statutDe(tauxTotal), detail: seuils },
                ],
            },
        ],
        sheets: [resultat, parCollab, timesheets],
    };
}
