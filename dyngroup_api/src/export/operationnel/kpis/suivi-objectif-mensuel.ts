import { pool } from "../../../db/pool";
import { DataSheet, FormulaCell, KpiExport } from "../../excel/kpi-export.types";
import { cellRef, columnRange } from "../../excel/workbook-builder";
import { EmployeeScope, MOIS, OperationnelExportFilters } from "../export-filters";

// Export du graphique "Suivi de l'objectif mensuel" (onglet Indicateurs Clés).
//   CA réalisé  = heures productives × tarif horaire du mois   (operationnel.controller.ts)
//   Objectif    = x_suivi_annuel_employe.x_studio_objectif_chf
//   Écart       = CA réalisé − Objectif ; Cumul = somme des écarts depuis janvier
// Toute l'année est lue (pas seulement le mois filtré) car le cumul part toujours de janvier ;
// la feuille de suivi n'affiche ensuite que les mois du filtre.

const CHF = "#,##0.00";
const HEURES = "0.00";
const TARIF_PAR_DEFAUT = 180;

const round2 = (n: number) => Math.round(n * 100) / 100;
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
    const [lignesProductives, tarifsDuMois, prixFiche, prixVente, synthese, lignesObjectif] = await Promise.all([
        // Heures productives, ligne par ligne, hors jours fériés fictifs d'Odoo.
        pool.query(
            `SELECT TO_CHAR(aal.date::date, 'YYYY-MM-DD') AS date, aal.employee_id, aal.name AS libelle,
                    aal.unit_amount AS heures
             FROM staging.account_analytic_line aal
             WHERE aal.employee_id = ANY($1::int[])
               AND aal.date::date BETWEEN $2::date AND $3::date
               AND NOT (aal.name LIKE 'Congé (%' AND aal.amount = 0)
               AND aal.productivity = true
             ORDER BY aal.date::date, aal.employee_id, aal.id`,
            [ids, debutAnnee, finAnnee]
        ).then(r => r.rows),
        // Tarif du mois : moyenne sur toutes les lignes de l'employé ce mois-là (productives ou non).
        queryOrEmpty(
            `SELECT employee_id, EXTRACT(MONTH FROM date::date)::int AS mois, AVG(x_studio_tarif_horaire) AS tarif
             FROM staging.account_analytic_line
             WHERE employee_id = ANY($1::int[])
               AND date::date BETWEEN $2::date AND $3::date
               AND x_studio_tarif_horaire > 0
             GROUP BY employee_id, mois`,
            [ids, debutAnnee, finAnnee]
        ),
        // Tarifs de repli, dans l'ordre de priorité : fiche employé, prix de vente, synthèse annuelle, 180.
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
    const tarifDeRepli = (employeeId: number) =>
        parseFloat(prixFiche.find(r => r.employee_id === employeeId)?.tarif)
        || parseFloat(prixVente.find(r => r.employee_id === employeeId)?.tarif)
        || tarifSynthese
        || TARIF_PAR_DEFAUT;

    // --- Feuille "Timesheets productives" -------------------------------------------------
    const heuresParCollabMois = new Map<string, number>();
    const timesheets: DataSheet = {
        name: "Timesheets productives",
        description: "Lignes de feuille de temps avec Productivité = Oui (hors « Congé (…) » à 0 CHF), toute l'année",
        columns: [
            { header: "Date", key: "date", width: 12, numFmt: "dd.mm.yyyy" },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Libellé", key: "libelle", width: 50 },
            { header: "Heures", key: "heures", width: 9, numFmt: HEURES },
        ],
        rows: [],
    };
    lignesProductives.forEach(l => {
        const collab = collabParId.get(l.employee_id);
        if (!collab) return;
        const [an, mois, jour] = l.date.split("-").map(Number);
        const heures = parseFloat(l.heures) || 0;
        heuresParCollabMois.set(cle(collab.id, mois), (heuresParCollabMois.get(cle(collab.id, mois)) ?? 0) + heures);
        timesheets.rows.push({
            date: new Date(Date.UTC(an, mois - 1, jour)),
            mois,
            collab: collab.name,
            libelle: l.libelle ?? "",
            heures,
        });
    });

    // --- Feuille "Objectifs" --------------------------------------------------------------
    const objectifParCollabMois = new Map<string, number>();
    const objectifs: DataSheet = {
        name: "Objectifs",
        description: "Objectif CHF saisi par collaborateur et par mois (fiche employé Odoo, onglet « Objectif »)",
        columns: [
            { header: "Mois objectif", key: "date", width: 14, numFmt: "dd.mm.yyyy" },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
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
        objectifs.rows.push({ date: new Date(Date.UTC(an, mois - 1, jour)), mois, collab: collab.name, objectif });
    });

    // --- Feuille "Par collaborateur" : CA réalisé et objectif, 12 mois par collaborateur ----
    const parCollab: DataSheet = {
        name: "Par collaborateur",
        description: "CA réalisé (heures productives × tarif du mois) et objectif, par collaborateur et par mois",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Mois", key: "mois", width: 7 },
            { header: "H. productives", key: "heures", width: 14, numFmt: HEURES },
            { header: "Tarif moyen du mois", key: "tarif_mois", width: 19, numFmt: HEURES },
            { header: "Tarif de repli", key: "tarif_repli", width: 14, numFmt: HEURES },
            { header: "Tarif retenu", key: "tarif", width: 13, numFmt: HEURES },
            { header: "CA réalisé", key: "ca", width: 14, numFmt: CHF },
            { header: "Objectif CHF", key: "objectif", width: 14, numFmt: CHF },
        ],
        rows: [],
    };
    const caParMois = douzeMois.map(() => 0);
    const objectifParMois = douzeMois.map(() => 0);

    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(collab => {
        const tarifRepli = tarifDeRepli(collab.id);
        douzeMois.forEach(mois => {
            const ligne = parCollab.rows.length;
            const colonne = (key: string) => cellRef(parCollab, key, ligne);
            const somme = (feuille: DataSheet, key: string) =>
                `SUMIFS(${columnRange(feuille, key)},${columnRange(feuille, "collab")},${colonne("collab")},${columnRange(feuille, "mois")},${colonne("mois")})`;

            const heures = heuresParCollabMois.get(cle(collab.id, mois)) ?? 0;
            const tarifMois = parseFloat(tarifsDuMois.find(t => t.employee_id === collab.id && t.mois === mois)?.tarif) || 0;
            const tarif = tarifMois || tarifRepli;
            const ca = round2(heures * tarif);
            const objectif = objectifParCollabMois.get(cle(collab.id, mois)) ?? 0;
            caParMois[mois - 1] += ca;
            objectifParMois[mois - 1] += objectif;

            parCollab.rows.push({
                collab: collab.name,
                mois,
                heures: formule(somme(timesheets, "heures"), heures),
                tarif_mois: tarifMois,
                tarif_repli: tarifRepli,
                tarif: formule(`IF(${colonne("tarif_mois")}>0,${colonne("tarif_mois")},${colonne("tarif_repli")})`, tarif),
                ca: formule(`ROUND(${colonne("heures")}*${colonne("tarif")},2)`, ca),
                objectif: formule(somme(objectifs, "objectif"), objectif),
            });
        });
    });

    // Cumul depuis janvier : un mois sans objectif compte pour 0, il n'est jamais sauté.
    let cumulCourant = 0;
    const cumulParMois = douzeMois.map(i => (cumulCourant += caParMois[i - 1] - objectifParMois[i - 1]));

    // --- Feuille "Suivi objectif mensuel" : ce que montre le graphique -------------------------
    const suivi: DataSheet = {
        name: "Suivi objectif mensuel",
        description: "Écart mensuel et écart cumulé depuis janvier, une ligne par mois du filtre + Total",
        columns: [
            { header: "N° mois", key: "mois", width: 9 },
            { header: "Mois", key: "mois_nom", width: 16 },
            { header: "CA réalisé", key: "ca", width: 15, numFmt: CHF },
            { header: "CA objectif", key: "objectif", width: 15, numFmt: CHF },
            { header: "Écart mensuel", key: "ecart", width: 15, numFmt: CHF },
            { header: "Écart cumulé", key: "cumul", width: 15, numFmt: CHF },
        ],
        rows: [],
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
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""} · année ${annee}`;

    return {
        definition: {
            id: "suivi-objectif-mensuel",
            titre: "Suivi de l'objectif mensuel",
            onglet: "Indicateurs Clés",
            description: "Écart CA mensuel + cumulé depuis janvier",
            metier: "Trajectoire commerciale dans l'année",
            formule: "Écart mensuel = CA Réalisé − Objectif CHF ; Cumulé = Σ des écarts depuis janvier (un mois sans objectif compte pour 0)",
            cible: "Barre verte = dépassement de l'objectif, rouge = retard",
            sourceOdoo:
                "CA Réalisé : feuilles de temps (h. productives × tarif horaire du mois) · Objectif CHF : fiche employé, onglet « Objectif »",
            tables: [
                "staging.account_analytic_line", "staging.x_suivi_annuel_employe", "staging.hr_employee",
                "staging.sale_order_line", "staging.res_company", "kpi.operationnel_suivi_mensuel",
                "kpi.operationnel_synthese_annuelle",
            ],
            commentaires: [
                "CA réalisé = Σ heures productives × tarif horaire moyen du mois (x_studio_tarif_horaire de toutes les lignes de l'employé ce mois-là), arrondi à 2 décimales par collaborateur et par mois.",
                "Sans tarif sur le mois : tarif de la fiche employé (xx_hourly_price), puis prix de vente moyen, puis tarif de la synthèse annuelle, puis 180 CHF.",
                "Un mois sans objectif saisi n'a pas d'écart mensuel (pas de barre), mais compte pour 0 dans le cumul.",
                "Un objectif peut être saisi pour un mois futur : il est compté (écart négatif tant que le CA n'est pas réalisé).",
                "Le cumul part toujours de janvier, même si un seul mois est filtré : les feuilles de données couvrent toute l'année.",
            ],
        },
        derivation: [
            {
                label: "Écart cumulé (CHF)", formula: total("cumul"), value: cumulFinal, numFmt: CHF,
                children: [
                    { label: "Formule", detail: "Σ (CA réalisé − CA objectif) de janvier jusqu'au dernier mois affiché" },
                    { label: "Opération", detail: "SUMIFS de la feuille « Par collaborateur » sur les mois ≤ mois de la ligne" },
                ],
            },
            {
                label: "CA réalisé (CHF)", formula: total("ca"), value: round2(totalCa), numFmt: CHF,
                children: [
                    {
                        label: "Source", detail: `Feuilles de temps → ${timesheets.rows.length} lignes (feuille Timesheets productives)`,
                        children: [
                            { label: "Filtre", detail: "Productivité = Oui" },
                            { label: "Filtre", detail: perimetre },
                            { label: "Exclusion", detail: "Lignes « Congé (…) » à 0 CHF (jours fériés fictifs d'Odoo)" },
                        ],
                    },
                    { label: "Tarif", detail: "Moyenne de x_studio_tarif_horaire du mois, sinon tarif de repli (feuille Par collaborateur)" },
                    { label: "Opération", detail: "ROUND(Σ heures productives × tarif retenu, 2) par collaborateur et par mois, puis Σ" },
                ],
            },
            {
                label: "CA objectif (CHF)", formula: total("objectif"), value: round2(totalObjectif), numFmt: CHF,
                children: [
                    {
                        label: "Source", detail: `Fiche employé, onglet « Objectif » → ${objectifs.rows.length} lignes (feuille Objectifs)`,
                        children: [
                            { label: "Filtre", detail: "Objectif actif, daté de l'année" },
                            { label: "Filtre", detail: perimetre },
                        ],
                    },
                    { label: "Opération", detail: "Σ Objectif CHF par collaborateur et par mois, puis Σ" },
                ],
            },
            {
                label: "Écart total (CHF)", formula: total("ecart"), value: round2(totalCa - totalObjectif), numFmt: CHF,
                children: [
                    { label: "Formule", detail: "Σ CA réalisé − Σ CA objectif (comme la carte RÉALISÉ du dashboard)" },
                ],
            },
        ],
        sheets: [suivi, parCollab, timesheets, objectifs],
    };
}
