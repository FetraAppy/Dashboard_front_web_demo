import { pool } from "../../../db/pool";
import { DataSheet, FormulaCell, KpiExport } from "../../excel/kpi-export.types";
import { cellRef, columnRange } from "../../excel/workbook-builder";
import { EmployeeScope, MOIS, OperationnelExportFilters } from "../export-filters";

// Export du graphique "Suivi de l'objectif mensuel" (onglet Indicateurs Clés).
//   CA réalisé  = heures productives × tarif horaire du mois   (operationnel.controller.ts)
//   Tarif       = x_suivi_annuel_employe.x_studio_tarif_horaire (onglet "Objectif"), vide = 0
//   Objectif    = x_suivi_annuel_employe.x_studio_objectif_chf
//   Écart       = CA réalisé − Objectif ; Cumul = somme des écarts depuis janvier
// Chaîne de calcul, par formules Excel :
//   Timesheets (heures productives) + Objectifs (tarif horaire et objectif du mois)
//     → Par collaborateur → Suivi objectif mensuel.
// Toute l'année est lue (pas seulement le mois filtré) car le cumul part toujours de janvier ;
// la feuille de suivi n'affiche ensuite que les mois du filtre.
// Les textes du classeur sont destinés au client : pas de noms de champs Odoo.

const CHF = "#,##0.00";
const HEURES = "0.00";
const DATE = "dd.mm.yyyy";

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
 * Lignes de l'onglet "Objectif" de la fiche employé, avec le tarif horaire du mois (vide → 0,
 * casté via texte comme dans le dashboard). Sans la colonne tarif (pas encore extraite), on relit
 * sans elle : tous les tarifs valent alors 0, comme dans le dashboard.
 */
async function loadObjectifs(ids: number[], debut: string, fin: string) {
    const sql = (tarif: string) =>
        `SELECT x_studio_employ AS employee_id, TO_CHAR(x_studio_mois_objectif::date, 'YYYY-MM-DD') AS date,
                x_studio_objectif AS heures, ${tarif} AS tarif, x_studio_objectif_chf AS objectif
         FROM staging.x_suivi_annuel_employe
         WHERE x_active = true AND x_studio_employ = ANY($1::int[])
           AND x_studio_mois_objectif::date BETWEEN $2::date AND $3::date
         ORDER BY x_studio_mois_objectif::date, x_studio_employ`;
    try {
        return (await pool.query(
            sql("COALESCE(NULLIF(TRIM(x_studio_tarif_horaire::text), '')::numeric, 0)"), [ids, debut, fin]
        )).rows;
    } catch (e: any) {
        console.warn("[export suivi-objectif-mensuel] tarif horaire non disponible :", e.message);
        return queryOrEmpty(sql("0"), [ids, debut, fin]);
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
    const [lignes, lignesObjectif] = await Promise.all([
        // Heures productives, ligne par ligne, hors jours fériés fictifs d'Odoo.
        pool.query(
            `SELECT TO_CHAR(aal.date::date, 'YYYY-MM-DD') AS date, aal.employee_id, aal.name AS libelle,
                    aal.unit_amount AS heures, pp.name AS projet, pt.name AS tache
             FROM staging.account_analytic_line aal
             LEFT JOIN staging.project_project pp ON pp.id = aal.project_id
             LEFT JOIN staging.project_task pt ON pt.id = aal.task_id
             WHERE aal.employee_id = ANY($1::int[])
               AND aal.date::date BETWEEN $2::date AND $3::date
               AND NOT (aal.name LIKE 'Congé (%' AND aal.amount = 0)
               AND aal.productivity = true
             ORDER BY aal.date::date, aal.employee_id, aal.id`,
            [ids, debutAnnee, finAnnee]
        ).then(r => r.rows),
        loadObjectifs(ids, debutAnnee, finAnnee),
    ]);

    // --- Feuille "Timesheets" : heures productives de l'année ---------------------------------
    const heuresParCollabMois = new Map<string, number>();
    const timesheets: DataSheet = {
        name: "Timesheets",
        description: "Lignes de feuille de temps productives de l'année (hors « Congé (…) » à 0 CHF), qui donnent les heures du CA réalisé",
        columns: [
            { header: "Date", key: "date", width: 12, numFmt: DATE },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Projet", key: "projet", width: 34 },
            { header: "Tâche", key: "tache", width: 34 },
            { header: "Libellé", key: "libelle", width: 50 },
            { header: "Heures", key: "heures", width: 9, numFmt: HEURES },
        ],
        rows: [],
    };
    lignes.forEach(l => {
        const collab = collabParId.get(l.employee_id);
        if (!collab) return;
        const [an, mois, jour] = l.date.split("-").map(Number);
        const heures = parseFloat(l.heures) || 0;
        const k = cle(collab.id, mois);
        heuresParCollabMois.set(k, (heuresParCollabMois.get(k) ?? 0) + heures);
        timesheets.rows.push({
            date: new Date(Date.UTC(an, mois - 1, jour)),
            mois,
            collab: collab.name,
            societe: collab.company ?? "",
            projet: l.projet ?? "",
            tache: l.tache ?? "",
            libelle: l.libelle ?? "",
            heures,
        });
    });

    // --- Feuille "Objectifs" : tarif horaire et objectif CHF du mois -------------------------
    const objectifParCollabMois = new Map<string, number>();
    const tarifParCollabMois = new Map<string, number>();
    const objectifs: DataSheet = {
        name: "Objectifs",
        description: "Onglet « Objectif » de la fiche employé : tarif horaire, objectif heures et objectif CHF de chaque mois",
        columns: [
            { header: "Mois objectif", key: "date", width: 14, numFmt: DATE },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Tarif horaire", key: "tarif", width: 13, numFmt: CHF },
            { header: "Objectif heures", key: "heures", width: 15, numFmt: HEURES },
            { header: "Objectif CHF", key: "objectif", width: 14, numFmt: CHF },
        ],
        rows: [],
    };
    lignesObjectif.forEach(l => {
        const collab = collabParId.get(l.employee_id);
        if (!collab) return;
        const [an, mois, jour] = l.date.split("-").map(Number);
        const k = cle(collab.id, mois);
        const objectif = parseFloat(l.objectif) || 0;
        // Vide ou 0 → 0 ; plusieurs lignes pour le même mois → le plus élevé (comme le dashboard).
        const tarif = parseFloat(l.tarif) || 0;
        objectifParCollabMois.set(k, (objectifParCollabMois.get(k) ?? 0) + objectif);
        tarifParCollabMois.set(k, Math.max(tarifParCollabMois.get(k) ?? 0, tarif));
        objectifs.rows.push({
            date: new Date(Date.UTC(an, mois - 1, jour)),
            mois,
            collab: collab.name,
            societe: collab.company ?? "",
            tarif,
            heures: parseFloat(l.heures) || 0,
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
    let moisAvecTarif = 0;
    let moisHeuresSansTarif = 0;

    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(collab => {
        douzeMois.forEach(mois => {
            const ligne = parCollab.rows.length;
            const colonne = (key: string) => cellRef(parCollab, key, ligne);
            const filtre = (feuille: DataSheet) =>
                `${columnRange(feuille, "collab")},${colonne("collab")},${columnRange(feuille, "mois")},${colonne("mois")}`;

            const heures = heuresParCollabMois.get(cle(collab.id, mois)) ?? 0;
            const tarif = tarifParCollabMois.get(cle(collab.id, mois)) ?? 0;
            if (tarif > 0) moisAvecTarif++;
            else if (heures > 0) moisHeuresSansTarif++;
            const ca = round2(heures * tarif);
            const objectif = objectifParCollabMois.get(cle(collab.id, mois)) ?? 0;
            caParMois[mois - 1] += ca;
            objectifParMois[mois - 1] += objectif;

            parCollab.rows.push({
                collab: collab.name,
                mois,
                mois_nom: MOIS[mois - 1],
                heures: formule(`SUMIFS(${columnRange(timesheets, "heures")},${filtre(timesheets)})`, heures),
                // Tarif saisi pour ce mois (feuille Objectifs) ; aucun tarif → 0, donc CA réalisé 0.
                tarif: formule(`MAXIFS(${columnRange(objectifs, "tarif")},${filtre(objectifs)})`, tarif),
                ca: formule(`ROUND(${colonne("heures")}*${colonne("tarif")},2)`, ca),
                objectif: formule(`SUMIFS(${columnRange(objectifs, "objectif")},${filtre(objectifs)})`, objectif),
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
    const detailTarif = `Saisi pour chaque mois dans la fiche employé, onglet « Objectif » (${moisAvecTarif} mois-collaborateur avec un tarif)`
        + (moisHeuresSansTarif ? ` ; ${moisHeuresSansTarif} mois avec des heures productives mais sans tarif → CA réalisé 0` : "");

    return {
        definition: {
            id: "suivi-objectif-mensuel",
            titre: "Suivi de l'objectif mensuel",
            onglet: "Indicateurs Clés",
            description: "Écart CA mensuel + cumulé depuis janvier",
            metier: "Trajectoire commerciale dans l'année",
            tables: [
                "staging.account_analytic_line", "staging.project_project", "staging.project_task",
                "staging.x_suivi_annuel_employe", "staging.hr_employee", "staging.res_company",
                "kpi.operationnel_suivi_mensuel",
            ],
            colonnes: [
                {
                    nom: "CA réalisé",
                    description: "CA généré par les heures productives",
                    metier: "CA généré réel",
                    formule: "Σ (h. productives × tarif horaire du mois)",
                    source: "Timesheets + fiche employé, onglet « Objectif »",
                    commentaire: "Tarif horaire saisi par mois dans l'onglet « Objectif » ; vide ou 0 → CA réalisé 0 pour ce mois",
                },
                {
                    nom: "CA objectif",
                    description: "Montant CHF à facturer sur le mois",
                    metier: "Cible fixée dans la fiche employé",
                    formule: "Σ objectif CHF du mois (= tarif horaire × objectif heures)",
                    source: "Fiche employé, onglet « Objectif »",
                    commentaire: "Calculé automatiquement dans Odoo ; un objectif saisi pour un mois futur est compté",
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
                    { label: "Heures", detail: `${timesheets.rows.length} lignes productives (Timesheets)` },
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
