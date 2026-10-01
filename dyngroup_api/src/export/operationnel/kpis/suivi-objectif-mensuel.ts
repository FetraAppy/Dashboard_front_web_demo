import { pool } from "../../../db/pool";
import { DataSheet, FormulaCell, KpiExport } from "../../excel/kpi-export.types";
import { cellRef, columnRange } from "../../excel/workbook-builder";
import { EmployeeScope, MOIS, OperationnelExportFilters } from "../export-filters";

// Export du graphique "Suivi de l'objectif mensuel" (onglet Indicateurs Clés).
//   CA réalisé  = heures productives × tarif horaire du mois   (operationnel.controller.ts)
//   Objectif    = x_suivi_annuel_employe.x_studio_objectif_chf
//   Écart       = CA réalisé − Objectif ; Cumul = somme des écarts depuis janvier
// Chaîne de calcul, par formules Excel :
//   Timesheets (heures productives + tarif horaire du mois) + Objectifs → Par collaborateur
//     → Suivi objectif mensuel.
// Toute l'année est lue (pas seulement le mois filtré) car le cumul part toujours de janvier ;
// la feuille de suivi n'affiche ensuite que les mois du filtre.
// Les textes du classeur sont destinés au client : pas de noms de champs Odoo.

const CHF = "#,##0.00";
const HEURES = "0.00";
const DATE = "dd.mm.yyyy";
const TARIF_PAR_DEFAUT = 180;

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");
const frDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const formule = (formula: string, result: number | string): FormulaCell => ({ formula, result });

/** Requête dont la colonne peut ne pas être extraite d'Odoo : comme le dashboard, on continue sans. */
async function queryOrEmpty(sql: string, params: unknown[]) {
    try {
        return (await pool.query(sql, params)).rows;
    } catch (e: any) {
        console.warn("[export suivi-objectif-mensuel] requête ignorée :", e.message);
        return [];
    }
}

/**
 * Toutes les lignes de feuille de temps de l'année : le dashboard en tire les heures productives
 * (hors jours fériés fictifs) ET le tarif horaire du mois (moyenne sur toutes les lignes avec un
 * tarif, productives ou non). Sans la colonne tarif (pas encore extraite), on relit sans elle.
 */
async function loadTimesheets(ids: number[], debut: string, fin: string) {
    const sql = (tarif: string) =>
        `SELECT TO_CHAR(aal.date::date, 'YYYY-MM-DD') AS date, aal.employee_id, aal.name AS libelle,
                aal.unit_amount AS heures, aal.productivity, ${tarif} AS tarif,
                (aal.name LIKE 'Congé (%' AND aal.amount = 0) AS ferie_fictif,
                pp.name AS projet, pt.name AS tache
         FROM staging.account_analytic_line aal
         LEFT JOIN staging.project_project pp ON pp.id = aal.project_id
         LEFT JOIN staging.project_task pt ON pt.id = aal.task_id
         WHERE aal.employee_id = ANY($1::int[])
           AND aal.date::date BETWEEN $2::date AND $3::date
         ORDER BY aal.date::date, aal.employee_id, aal.id`;
    try {
        return (await pool.query(sql("aal.x_studio_tarif_horaire"), [ids, debut, fin])).rows;
    } catch (e: any) {
        console.warn("[export suivi-objectif-mensuel] tarif horaire non disponible :", e.message);
        return (await pool.query(sql("NULL::numeric"), [ids, debut, fin])).rows;
    }
}

export async function exportSuiviObjectifMensuel(
    filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    const { annee } = filters;
    const ids = scope.employeeIds;
    const debutAnnee = `${annee}-01-01`;
    const finAnnee = `${annee}-12-31`;
    const douzeMois = Array.from({ length: 12 }, (_, i) => i + 1);
    const collabParId = new Map(scope.employees.map(e => [e.id, e]));
    const cle = (employeeId: number, mois: number) => `${employeeId}|${mois}`;

    // --- Requêtes (mêmes conditions que le dashboard) ---------------------------------------
    const [lignes, prixFiche, prixVente, synthese, lignesObjectif] = await Promise.all([
        loadTimesheets(ids, debutAnnee, finAnnee),
        // Tarif de référence de l'employé, utilisé par le dashboard seulement si aucune ligne du
        // mois n'a de tarif : fiche employé, sinon prix de vente moyen, sinon synthèse, sinon 180.
        queryOrEmpty(
            `SELECT id AS employee_id, xx_hourly_price AS tarif
             FROM staging.hr_employee WHERE id = ANY($1::int[]) AND xx_hourly_price > 0`,
            [ids]
        ),
        queryOrEmpty(
            `SELECT aal.employee_id,
                    ROUND(SUM(aal.unit_amount * sol.price_unit) / NULLIF(SUM(aal.unit_amount), 0), 2) AS tarif
             FROM staging.account_analytic_line aal
             JOIN staging.sale_order_line sol ON aal.so_line = sol.id
             WHERE aal.employee_id = ANY($1::int[]) AND aal.date::date BETWEEN $2::date AND $3::date
               AND aal.unit_amount > 0
             GROUP BY aal.employee_id`,
            [ids, debutAnnee, finAnnee]
        ),
        queryOrEmpty(`SELECT tarif_horaire_chf AS tarif FROM kpi.operationnel_synthese_annuelle WHERE annee = $1 LIMIT 1`, [annee]),
        // Objectifs saisis dans l'onglet "Objectif" de la fiche employé.
        queryOrEmpty(
            `SELECT x_studio_employ AS employee_id, TO_CHAR(x_studio_mois_objectif::date, 'YYYY-MM-DD') AS date,
                    x_studio_objectif_chf AS objectif
             FROM staging.x_suivi_annuel_employe
             WHERE x_active = true AND x_studio_employ = ANY($1::int[])
               AND x_studio_mois_objectif::date BETWEEN $2::date AND $3::date
             ORDER BY x_studio_mois_objectif::date, x_studio_employ`,
            [ids, debutAnnee, finAnnee]
        ),
    ]);

    const tarifSynthese = parseFloat(synthese[0]?.tarif) || 0;
    const tarifReference = (employeeId: number) =>
        parseFloat(prixFiche.find(r => r.employee_id === employeeId)?.tarif)
        || parseFloat(prixVente.find(r => r.employee_id === employeeId)?.tarif)
        || tarifSynthese
        || TARIF_PAR_DEFAUT;

    // --- Feuille "Timesheets" : toutes les lignes de l'année ---------------------------------
    const heuresParCollabMois = new Map<string, number>();
    const tarifsParCollabMois = new Map<string, number[]>();
    const timesheets: DataSheet = {
        name: "Timesheets",
        description: "Lignes de feuille de temps de l'année : les heures productives donnent le CA, les tarifs horaires donnent le tarif du mois",
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
            { header: "Comptée dans les heures", key: "comptee", width: 22 },
            { header: "Tarif horaire", key: "tarif", width: 13, numFmt: CHF },
        ],
        rows: [],
    };
    lignes.forEach(l => {
        const collab = collabParId.get(l.employee_id);
        if (!collab) return;
        const [an, mois, jour] = l.date.split("-").map(Number);
        const heures = parseFloat(l.heures) || 0;
        const productive = l.productivity === true;
        const comptee = !l.ferie_fictif;
        const tarif = parseFloat(l.tarif) || 0;
        const k = cle(collab.id, mois);
        if (productive && comptee) heuresParCollabMois.set(k, (heuresParCollabMois.get(k) ?? 0) + heures);
        if (tarif > 0) tarifsParCollabMois.set(k, [...(tarifsParCollabMois.get(k) ?? []), tarif]);
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
            // Les « Congé (…) » à 0 CHF sont des jours fériés générés par Odoo, pas du travail.
            comptee: comptee ? "Oui" : "Non",
            tarif: tarif || null,
        });
    });

    // --- Feuille "Objectifs" --------------------------------------------------------------
    const objectifParCollabMois = new Map<string, number>();
    const objectifs: DataSheet = {
        name: "Objectifs",
        description: "Objectif CHF saisi par collaborateur et par mois (fiche employé Odoo, onglet « Objectif »)",
        columns: [
            { header: "Mois objectif", key: "date", width: 14, numFmt: DATE },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Objectif CHF", key: "objectif", width: 14, numFmt: CHF },
        ],
        rows: [],
    };
    lignesObjectif.forEach(l => {
        const collab = collabParId.get(l.employee_id);
        if (!collab) return;
        const [an, mois, jour] = l.date.split("-").map(Number);
        const objectif = parseFloat(l.objectif) || 0;
        objectifParCollabMois.set(cle(collab.id, mois), (objectifParCollabMois.get(cle(collab.id, mois)) ?? 0) + objectif);
        objectifs.rows.push({
            date: new Date(Date.UTC(an, mois - 1, jour)),
            mois,
            collab: collab.name,
            societe: collab.company ?? "",
            objectif,
        });
    });

    // --- Feuille "Par collaborateur" : CA réalisé et objectif, 12 mois par collaborateur ----
    const parCollab: DataSheet = {
        name: "Par collaborateur",
        description: "CA réalisé (heures productives × tarif horaire du mois) et objectif, par collaborateur et par mois",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Nom du mois", key: "mois_nom", width: 12 },
            { header: "H. productives", key: "heures", width: 14, numFmt: HEURES },
            { header: "Tarif horaire du mois", key: "tarif", width: 20, numFmt: CHF },
            { header: "CA réalisé", key: "ca", width: 14, numFmt: CHF },
            { header: "Objectif CHF", key: "objectif", width: 14, numFmt: CHF },
        ],
        rows: [],
    };
    const caParMois = douzeMois.map(() => 0);
    const objectifParMois = douzeMois.map(() => 0);
    let moisAuTarifFiche = 0;

    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(collab => {
        const reference = tarifReference(collab.id);
        douzeMois.forEach(mois => {
            const ligne = parCollab.rows.length;
            const colonne = (key: string) => cellRef(parCollab, key, ligne);
            const parCollabMois = `${columnRange(timesheets, "collab")},${colonne("collab")},${columnRange(timesheets, "mois")},${colonne("mois")}`;
            const avecTarif = `${columnRange(timesheets, "tarif")},">0"`;

            const heures = heuresParCollabMois.get(cle(collab.id, mois)) ?? 0;
            const tarifs = tarifsParCollabMois.get(cle(collab.id, mois)) ?? [];
            const tarifMois = tarifs.length ? tarifs.reduce((s, t) => s + t, 0) / tarifs.length : 0;
            const tarif = tarifMois || reference;
            if (!tarifMois && heures > 0) moisAuTarifFiche++;
            const ca = round2(heures * tarif);
            const objectif = objectifParCollabMois.get(cle(collab.id, mois)) ?? 0;
            caParMois[mois - 1] += ca;
            objectifParMois[mois - 1] += objectif;

            parCollab.rows.push({
                collab: collab.name,
                mois,
                mois_nom: MOIS[mois - 1],
                heures: formule(
                    `SUMIFS(${columnRange(timesheets, "heures")},${parCollabMois},${columnRange(timesheets, "productivite")},"Oui",${columnRange(timesheets, "comptee")},"Oui")`,
                    heures
                ),
                // Moyenne des tarifs du mois ; si aucune ligne n'a de tarif, tarif de la fiche employé.
                tarif: formule(
                    `IF(COUNTIFS(${parCollabMois},${avecTarif})>0,AVERAGEIFS(${columnRange(timesheets, "tarif")},${parCollabMois},${avecTarif}),${reference})`,
                    tarif
                ),
                ca: formule(`ROUND(${colonne("heures")}*${colonne("tarif")},2)`, ca),
                objectif: formule(
                    `SUMIFS(${columnRange(objectifs, "objectif")},${columnRange(objectifs, "collab")},${colonne("collab")},${columnRange(objectifs, "mois")},${colonne("mois")})`,
                    objectif
                ),
            });
        });
    });

    // Cumul depuis janvier : un mois sans objectif compte pour 0, il n'est jamais sauté.
    let cumulCourant = 0;
    const cumulParMois = douzeMois.map(i => (cumulCourant += caParMois[i - 1] - objectifParMois[i - 1]));

    // --- Feuille "Suivi objectif mensuel" : ce que montre le graphique -------------------------
    const suivi: DataSheet = {
        name: "Suivi objectif mensuel",
        description: "Données du graphique : écart mensuel et écart cumulé depuis janvier, une ligne par mois du filtre + Total",
        columns: [
            { header: "N° mois", key: "mois", width: 9 },
            { header: "Mois", key: "mois_nom", width: 16 },
            { header: "CA réalisé", key: "ca", width: 15, numFmt: CHF },
            { header: "CA objectif", key: "objectif", width: 15, numFmt: CHF },
            { header: "Écart mensuel", key: "ecart", width: 15, numFmt: CHF },
            { header: "Écart cumulé", key: "cumul", width: 15, numFmt: CHF },
        ],
        rows: [],
        lastRowIsTotal: true,
    };
    // Somme d'une colonne de "Par collaborateur" pour le mois de la ligne (ou jusqu'à ce mois si comparaison "<=").
    const sommeDuMois = (key: string, ligne: number, comparaison = "") =>
        `SUMIFS(${columnRange(parCollab, key)},${columnRange(parCollab, "mois")},${comparaison ? `"${comparaison}"&` : ""}${cellRef(suivi, "mois", ligne)})`;

    let totalCa = 0;
    let totalObjectif = 0;
    scope.months.forEach(mois => {
        const ligne = suivi.rows.length;
        const ca = round2(caParMois[mois - 1]);
        const objectif = round2(objectifParMois[mois - 1]);
        totalCa += ca;
        totalObjectif += objectif;
        suivi.rows.push({
            mois,
            mois_nom: MOIS[mois - 1],
            ca: formule(sommeDuMois("ca", ligne), ca),
            objectif: formule(sommeDuMois("objectif", ligne), objectif),
            // Sans objectif saisi, pas d'écart mensuel (pas de barre dans le graphique).
            ecart: formule(
                `IF(${cellRef(suivi, "objectif", ligne)}>0,${cellRef(suivi, "ca", ligne)}-${cellRef(suivi, "objectif", ligne)},"—")`,
                objectif > 0 ? round2(ca - objectif) : "—"
            ),
            cumul: formule(`${sommeDuMois("ca", ligne, "<=")}-${sommeDuMois("objectif", ligne, "<=")}`, round2(cumulParMois[mois - 1])),
        });
    });

    const ligneTotal = suivi.rows.length;
    const derniereLigne = ligneTotal - 1;
    const sommeColonne = (key: string) => `SUM(${cellRef(suivi, key, 0)}:${cellRef(suivi, key, derniereLigne)})`;
    const cumulFinal = round2(cumulParMois[scope.months[derniereLigne] - 1]);
    suivi.rows.push({
        mois: null,
        mois_nom: "Total",
        ca: formule(sommeColonne("ca"), round2(totalCa)),
        objectif: formule(sommeColonne("objectif"), round2(totalObjectif)),
        // Comme la carte RÉALISÉ du dashboard : Σ CA − Σ objectif, sans exception de mois.
        ecart: formule(`${cellRef(suivi, "ca", ligneTotal)}-${cellRef(suivi, "objectif", ligneTotal)}`, round2(totalCa - totalObjectif)),
        cumul: formule(cellRef(suivi, "cumul", derniereLigne), cumulFinal),
    });

    // --- Fiche et chemin de calcul ------------------------------------------------------------
    const total = (key: string) => cellRef(suivi, key, ligneTotal, true);
    const nbCollab = scope.employees.length;
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""}, du ${frDate(new Date(debutAnnee))} au ${frDate(new Date(finAnnee))} (le cumul part de janvier)`;
    const nbProductives = timesheets.rows.filter(r => r.productivite === "Oui" && r.comptee === "Oui").length;
    const nbAvecTarif = timesheets.rows.filter(r => r.tarif).length;
    const detailTarif = moisAuTarifFiche
        ? `Moyenne des tarifs horaires des timesheets du collaborateur sur le mois (${nbAvecTarif} lignes avec un tarif) ; ${moisAuTarifFiche} mois sans tarif saisi → tarif de la fiche employé`
        : `Moyenne des tarifs horaires des timesheets du collaborateur sur le mois (${nbAvecTarif} lignes avec un tarif)`;

    return {
        definition: {
            id: "suivi-objectif-mensuel",
            titre: "Suivi de l'objectif mensuel",
            onglet: "Indicateurs Clés",
            description: "Écart CA mensuel + cumulé depuis janvier",
            metier: "Trajectoire commerciale dans l'année",
            tables: [
                "staging.account_analytic_line", "staging.project_project", "staging.project_task",
                "staging.x_suivi_annuel_employe", "staging.hr_employee", "staging.sale_order_line",
                "staging.res_company", "kpi.operationnel_suivi_mensuel", "kpi.operationnel_synthese_annuelle",
            ],
            colonnes: [
                {
                    nom: "CA réalisé",
                    description: "CA généré par les heures productives",
                    metier: "CA généré réel",
                    formule: "Σ (h. productives × tarif horaire du mois)",
                    source: "Timesheets",
                    commentaire: "Tarif horaire du mois = moyenne des tarifs des timesheets du mois ; si aucun tarif n'est saisi ce mois-là : tarif de la fiche employé",
                },
                {
                    nom: "CA objectif",
                    description: "Montant CHF à facturer sur le mois",
                    metier: "Cible fixée dans la fiche employé",
                    formule: "Σ objectif CHF du mois",
                    source: "Fiche employé, onglet « Objectif »",
                    commentaire: "Un objectif saisi pour un mois futur est compté",
                },
                {
                    nom: "Écart mensuel",
                    description: "Avance (+) ou retard (−) du mois",
                    metier: "Atteinte de l'objectif mensuel",
                    formule: "CA réalisé − CA objectif",
                    source: "Calculé",
                    commentaire: "Pas de barre si aucun objectif saisi · vert ≥ 0, rouge < 0",
                },
                {
                    nom: "Écart cumulé",
                    description: "Écart accumulé depuis janvier",
                    metier: "Trajectoire commerciale dans l'année",
                    formule: "Σ (CA réalisé − CA objectif) depuis janvier",
                    source: "Calculé",
                    commentaire: "Ne saute aucun mois ; part de janvier même pour un seul mois filtré",
                },
            ],
        },
        derivation: [
            {
                label: "CA réalisé (CHF)", formula: total("ca"), value: round2(totalCa), numFmt: CHF,
                children: [
                    { label: "Périmètre", detail: perimetre },
                    { label: "Heures", detail: `${nbProductives} lignes productives (Timesheets)` },
                    { label: "Exclusion", detail: "Lignes « Congé (…) » à 0 CHF : jours fériés générés par Odoo, pas comptés dans les heures" },
                    { label: "Tarif horaire", detail: detailTarif },
                    { label: "Calcul", detail: "H. productives × tarif horaire, arrondi au centime, par collaborateur et mois (Par collaborateur) → Σ par mois → Σ des mois" },
                ],
            },
            {
                label: "CA objectif (CHF)", formula: total("objectif"), value: round2(totalObjectif), numFmt: CHF,
                children: [
                    { label: "Source", detail: `${objectifs.rows.length} objectifs de l'année (Objectifs)` },
                    { label: "Calcul", detail: "Σ par collaborateur et mois (Par collaborateur) → Σ par mois → Σ des mois" },
                ],
            },
            {
                label: "Écart total (CHF)", formula: total("ecart"), value: round2(totalCa - totalObjectif), numFmt: CHF,
                children: [
                    { label: "Calcul", detail: "Σ CA réalisé − Σ CA objectif (comme la carte RÉALISÉ du dashboard)" },
                ],
            },
            {
                label: "Écart cumulé (CHF)", formula: total("cumul"), value: cumulFinal, numFmt: CHF,
                children: [
                    { label: "Calcul", detail: "Σ (CA réalisé − CA objectif) de janvier au dernier mois affiché" },
                ],
            },
        ],
        sheets: [suivi, parCollab, timesheets, objectifs],
    };
}
