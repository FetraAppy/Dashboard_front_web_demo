import { pool } from "../../../db/pool";
import { DataSheet, FormulaCell, KpiExport } from "../../excel/kpi-export.types";
import { cellRef, columnRange } from "../../excel/workbook-builder";
import { EmployeeScope, MOIS, OperationnelExportFilters } from "../export-filters";

// Export de la carte "Objectif de productivité" : carte CIBLE (Indicateurs Clés) et carte du même nom
// (Suivi Mensuel & Détails), qui affichent la même valeur.
//   Objectif de productivité = CA réalisé ÷ Objectif facturation × 100   (kpiObjectifProductivite)
//   CA réalisé = heures productives × tarif horaire du mois              (operationnel.controller.ts)
// Chaîne de calcul, par formules Excel :
//   Timesheets (heures productives + tarif horaire du mois) + Objectifs → Par collaborateur
//     → Objectif de productivité.
// Les textes du classeur sont destinés au client : pas de noms de champs Odoo.

// Seuils du dashboard (OBJECTIF_PRODUCTIVITE_PCT et SEUIL_PROCHE_OBJECTIF_PCT dans
// operationnel-dashboard.component.ts) : à garder identiques.
const CIBLE_PCT = 75;
const SEUIL_PROCHE_PCT = 69.1;

const CHF = "#,##0.00";
const HEURES = "0.00";
const DATE = "dd.mm.yyyy";
const TARIF_PAR_DEFAUT = 180;

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");
const frDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const formule = (formula: string, result: number | string): FormulaCell => ({ formula, result });

/** Statut de la carte : même règle que statutObjectifProductivite du dashboard (sans objectif : « Sous objectif »). */
const statutDe = (pct: number | null) =>
    pct !== null && pct >= CIBLE_PCT ? "Objectif atteint"
    : pct !== null && pct >= SEUIL_PROCHE_PCT ? "Proche objectif"
    : "Sous objectif";

/** Requête dont la colonne peut ne pas être extraite d'Odoo : comme le dashboard, on continue sans. */
async function queryOrEmpty(sql: string, params: unknown[]) {
    try {
        return (await pool.query(sql, params)).rows;
    } catch (e: any) {
        console.warn("[export objectif-productivite] requête ignorée :", e.message);
        return [];
    }
}

/**
 * Toutes les lignes de feuille de temps de la période : le dashboard en tire les heures productives
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
        console.warn("[export objectif-productivite] tarif horaire non disponible :", e.message);
        return (await pool.query(sql("NULL::numeric"), [ids, debut, fin])).rows;
    }
}

export async function exportObjectifProductivite(
    filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    const { annee } = filters;
    const ids = scope.employeeIds;
    const collabParId = new Map(scope.employees.map(e => [e.id, e]));
    const cle = (employeeId: number, mois: number) => `${employeeId}|${mois}`;

    // --- Requêtes (mêmes conditions que le dashboard) ---------------------------------------
    const [lignes, prixFiche, prixVente, synthese, lignesObjectif] = await Promise.all([
        loadTimesheets(ids, scope.dateFrom, scope.dateTo),
        // Tarif de référence de l'employé, utilisé par le dashboard seulement si aucune ligne du
        // mois n'a de tarif : fiche employé, sinon prix de vente moyen, sinon synthèse, sinon 180.
        queryOrEmpty(
            `SELECT id AS employee_id, xx_hourly_price AS tarif
             FROM staging.hr_employee WHERE id = ANY($1::int[]) AND xx_hourly_price > 0`,
            [ids]
        ),
        // Le prix de vente moyen se calcule sur l'année entière, même si un seul mois est filtré.
        queryOrEmpty(
            `SELECT aal.employee_id,
                    ROUND(SUM(aal.unit_amount * sol.price_unit) / NULLIF(SUM(aal.unit_amount), 0), 2) AS tarif
             FROM staging.account_analytic_line aal
             JOIN staging.sale_order_line sol ON aal.so_line = sol.id
             WHERE aal.employee_id = ANY($1::int[]) AND aal.date::date BETWEEN $2::date AND $3::date
               AND aal.unit_amount > 0
             GROUP BY aal.employee_id`,
            [ids, `${annee}-01-01`, `${annee}-12-31`]
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
            [ids, scope.dateFrom, scope.dateTo]
        ),
    ]);

    const tarifSynthese = parseFloat(synthese[0]?.tarif) || 0;
    const tarifReference = (employeeId: number) =>
        parseFloat(prixFiche.find(r => r.employee_id === employeeId)?.tarif)
        || parseFloat(prixVente.find(r => r.employee_id === employeeId)?.tarif)
        || tarifSynthese
        || TARIF_PAR_DEFAUT;

    // --- Feuille "Timesheets" : toutes les lignes de la période ------------------------------
    const heuresParCollabMois = new Map<string, number>();
    const tarifsParCollabMois = new Map<string, number[]>();
    const timesheets: DataSheet = {
        name: "Timesheets",
        description: "Lignes de feuille de temps de la période : les heures productives donnent le CA, les tarifs horaires donnent le tarif du mois",
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
    const collabsAvecObjectif = new Set<number>();
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
        if (objectif > 0) collabsAvecObjectif.add(collab.id);
        objectifs.rows.push({
            date: new Date(Date.UTC(an, mois - 1, jour)),
            mois,
            collab: collab.name,
            societe: collab.company ?? "",
            objectif,
        });
    });

    // --- Feuille "Par collaborateur" : CA réalisé et objectif, un mois du filtre par ligne -----
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
    let totalCa = 0;
    let totalObjectif = 0;
    let moisAuTarifFiche = 0;

    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(collab => {
        const reference = tarifReference(collab.id);
        scope.months.forEach(mois => {
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
            totalCa += ca;
            totalObjectif += objectif;

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

    // --- Feuille "Objectif de productivité" : les valeurs de la carte, sur une ligne ----------
    const pct = totalObjectif > 0 ? (totalCa / totalObjectif) * 100 : null;
    const resultat: DataSheet = {
        name: "Objectif de productivité",
        description: "Valeurs de la carte : CA réalisé, objectif facturation, pourcentage atteint, cible et statut",
        columns: [
            { header: "CA réalisé", key: "ca", width: 16, numFmt: CHF },
            { header: "Objectif facturation", key: "objectif", width: 20, numFmt: CHF },
            { header: "Objectif de productivité (%)", key: "pct", width: 27, numFmt: "0.00" },
            { header: "Cible (%)", key: "cible", width: 10, numFmt: "0.00" },
            { header: "Seuil proche objectif (%)", key: "seuil", width: 24, numFmt: "0.00" },
            { header: "Statut", key: "statut", width: 18 },
        ],
        rows: [],
    };
    const c = (key: string) => cellRef(resultat, key, 0);
    resultat.rows.push({
        ca: formule(`SUM(${columnRange(parCollab, "ca")})`, round2(totalCa)),
        objectif: formule(`SUM(${columnRange(parCollab, "objectif")})`, round2(totalObjectif)),
        // Sans objectif saisi, la carte CIBLE affiche « — ».
        pct: formule(`IF(${c("objectif")}>0,${c("ca")}/${c("objectif")}*100,"—")`, pct ?? "—"),
        cible: CIBLE_PCT,
        seuil: SEUIL_PROCHE_PCT,
        statut: formule(
            `IF(ISNUMBER(${c("pct")}),IF(${c("pct")}>=${c("cible")},"Objectif atteint",IF(${c("pct")}>=${c("seuil")},"Proche objectif","Sous objectif")),"Sous objectif")`,
            statutDe(pct)
        ),
    });

    // --- Fiche et chemin de calcul ------------------------------------------------------------
    const total = (key: string) => cellRef(resultat, key, 0, true);
    const nbCollab = scope.employees.length;
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""}, du ${frDate(new Date(scope.dateFrom))} au ${frDate(new Date(scope.dateTo))}`;
    const nbProductives = timesheets.rows.filter(r => r.productivite === "Oui" && r.comptee === "Oui").length;
    const nbAvecTarif = timesheets.rows.filter(r => r.tarif).length;
    const detailTarif = moisAuTarifFiche
        ? `Moyenne des tarifs horaires des timesheets du collaborateur sur le mois (${nbAvecTarif} lignes avec un tarif) ; ${moisAuTarifFiche} mois sans tarif saisi → tarif de la fiche employé`
        : `Moyenne des tarifs horaires des timesheets du collaborateur sur le mois (${nbAvecTarif} lignes avec un tarif)`;
    const nbAvecObjectif = collabsAvecObjectif.size;

    return {
        definition: {
            id: "objectif-productivite",
            titre: "Objectif de productivité",
            onglet: "Indicateurs Clés (carte CIBLE) et Suivi Mensuel & Détails",
            description: "Le CA réalisé atteint-il l'objectif financier fixé",
            metier: "Pilotage financier",
            cible: `≥ ${CIBLE_PCT}% atteint (vert) · ≥ ${SEUIL_PROCHE_PCT}% proche (orange) · sinon rouge`,
            tables: [
                "staging.account_analytic_line", "staging.project_project", "staging.project_task",
                "staging.x_suivi_annuel_employe", "staging.hr_employee", "staging.sale_order_line",
                "staging.res_company", "kpi.operationnel_suivi_mensuel", "kpi.operationnel_synthese_annuelle",
            ],
            colonnes: [
                {
                    nom: "CA réalisé",
                    description: "CA effectivement généré par le travail facturable",
                    metier: "CA généré réel",
                    formule: "Σ (h. productives × tarif horaire du mois)",
                    source: "Timesheets : heures avec Productivité = Oui ; tarif horaire = moyenne des tarifs des timesheets du mois",
                    commentaire: "Si aucun tarif n'est saisi ce mois-là : tarif de la fiche employé",
                },
                {
                    nom: "Objectif facturation",
                    description: "Montant CHF que le collaborateur doit facturer sur la période",
                    metier: "Cible fixée dans la fiche employé",
                    formule: "Σ objectif CHF par mois",
                    source: "Fiche employé, onglet « Objectif »",
                },
                {
                    nom: "Objectif de productivité",
                    description: "Part de l'objectif financier atteinte par le CA réalisé",
                    metier: "Pilotage financier",
                    formule: "CA réalisé / Objectif facturation × 100",
                    source: "Fiche employé, onglet « Objectif » ; CA réalisé calculé",
                    commentaire: `≥ ${CIBLE_PCT}% atteint (vert), ≥ ${SEUIL_PROCHE_PCT}% proche (orange), sinon rouge. « — » si aucun objectif n'est saisi`,
                },
            ],
        },
        derivation: [
            {
                label: "Objectif de productivité (%)", formula: total("pct"), value: pct ?? "—", numFmt: "0.00",
                children: [
                    { label: "Calcul", detail: "CA réalisé ÷ Objectif facturation × 100 ; « — » si aucun objectif n'est saisi" },
                    {
                        label: "CA réalisé", formula: total("ca"), value: round2(totalCa), numFmt: CHF,
                        children: [
                            { label: "Périmètre", detail: perimetre },
                            { label: "Heures", detail: `${nbProductives} lignes productives (Timesheets)` },
                            { label: "Exclusion", detail: "Lignes « Congé (…) » à 0 CHF : jours fériés générés par Odoo, pas comptés dans les heures" },
                            { label: "Tarif horaire", detail: detailTarif },
                            { label: "Calcul", detail: "H. productives × tarif horaire, arrondi au centime, par collaborateur et mois (Par collaborateur) → Σ" },
                        ],
                    },
                    {
                        label: "Objectif facturation", formula: total("objectif"), value: round2(totalObjectif), numFmt: CHF,
                        children: [
                            { label: "Source", detail: `${objectifs.rows.length} objectifs de la période (Objectifs)` },
                            { label: "Collaborateurs", detail: `${nbAvecObjectif} collaborateur${nbAvecObjectif > 1 ? "s" : ""} sur ${nbCollab} ont un objectif saisi : le CA de tous est divisé par les objectifs de ceux-là` },
                        ],
                    },
                    {
                        label: "Statut", formula: total("statut"), value: statutDe(pct),
                        detail: `≥ ${CIBLE_PCT}% : objectif atteint · ≥ ${SEUIL_PROCHE_PCT}% : proche objectif · sinon sous objectif`,
                    },
                ],
            },
        ],
        sheets: [resultat, parCollab, timesheets, objectifs],
    };
}
