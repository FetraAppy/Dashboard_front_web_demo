import { pool } from "../../../db/pool";
import { DataSheet, FormulaCell, KpiExport } from "../../excel/kpi-export.types";
import { cellRef, columnRange } from "../../excel/workbook-builder";
import { EmployeeScope, MOIS, OperationnelExportFilters } from "../export-filters";

// Export de la carte "Objectif de productivité" : carte CIBLE (Indicateurs Clés) et carte du même nom
// (Suivi Mensuel & Détails), qui affichent la même valeur.
//   Objectif de productivité = CA réalisé ÷ Objectif facturation × 100   (kpiObjectifProductivite)
//   CA réalisé = heures productives × tarif horaire du mois              (operationnel.controller.ts)
//   Tarif      = x_suivi_annuel_employe.x_studio_tarif_horaire (onglet "Objectif"), vide = 0
// Chaîne de calcul, par formules Excel :
//   Timesheets (heures productives) + Objectifs (tarif horaire et objectif du mois)
//     → Par collaborateur → Objectif de productivité.
// Les textes du classeur sont destinés au client : pas de noms de champs Odoo.

// Seuils du dashboard (OBJECTIF_PRODUCTIVITE_PCT et SEUIL_PROCHE_OBJECTIF_PCT dans
// operationnel-dashboard.component.ts) : à garder identiques.
const CIBLE_PCT = 75;
const SEUIL_PROCHE_PCT = 69.1;

const CHF = "#,##0.00";
const HEURES = "0.00";
const DATE = "dd.mm.yyyy";

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
        console.warn("[export objectif-productivite] tarif horaire non disponible :", e.message);
        return queryOrEmpty(sql("0"), [ids, debut, fin]);
    }
}

export async function exportObjectifProductivite(
    filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    const ids = scope.employeeIds;
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
            [ids, scope.dateFrom, scope.dateTo]
        ).then(r => r.rows),
        loadObjectifs(ids, scope.dateFrom, scope.dateTo),
    ]);

    // --- Feuille "Timesheets" : heures productives de la période ------------------------------
    const heuresParCollabMois = new Map<string, number>();
    const timesheets: DataSheet = {
        name: "Timesheets",
        description: "Lignes de feuille de temps productives de la période (hors « Congé (…) » à 0 CHF), qui donnent les heures du CA réalisé",
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
    // Une ligne par collaborateur et par mois (pas une ligne brute par enregistrement Odoo) :
    // s'il existe plusieurs lignes "Objectif" pour le même mois (saisie en double dans Odoo), le
    // tarif retient le plus élevé et l'objectif CHF la somme — mêmes règles que le dashboard
    // (operationnel.controller.ts) et l'ETL. Agréger ici, plutôt que dans la formule Excel, évite
    // toute fonction récente mal supportée (MAXIFS) : au plus une ligne par collaborateur+mois
    // dans cette feuille, donc un simple SUMIFS suffit partout ensuite.
    const objectifParCollabMois = new Map<string, number>();
    const tarifParCollabMois = new Map<string, number>();
    const collabsAvecObjectif = new Set<number>();
    const aggregats = new Map<string, { date: Date; collab: string; societe: string; tarif: number; heures: number; objectif: number }>();
    lignesObjectif.forEach((l: any) => {
        const collab = collabParId.get(l.employee_id);
        if (!collab) return;
        const [an, mois, jour] = l.date.split("-").map(Number);
        const k = cle(collab.id, mois);
        const objectif = parseFloat(l.objectif) || 0;
        const tarif = parseFloat(l.tarif) || 0; // vide ou 0 → 0
        const heures = parseFloat(l.heures) || 0;
        objectifParCollabMois.set(k, (objectifParCollabMois.get(k) ?? 0) + objectif);
        tarifParCollabMois.set(k, Math.max(tarifParCollabMois.get(k) ?? 0, tarif));
        if (objectif > 0) collabsAvecObjectif.add(collab.id);
        const acc = aggregats.get(k);
        if (acc) {
            acc.tarif = Math.max(acc.tarif, tarif);
            acc.heures += heures;
            acc.objectif += objectif;
        } else {
            aggregats.set(k, { date: new Date(Date.UTC(an, mois - 1, jour)), collab: collab.name, societe: collab.company ?? "", tarif, heures, objectif });
        }
    });
    const objectifs: DataSheet = {
        name: "Objectifs",
        description: "Onglet « Objectif » de la fiche employé : tarif horaire, objectif heures et objectif CHF de chaque mois (agrégés si plusieurs lignes Odoo pour le même mois)",
        columns: [
            { header: "Mois objectif", key: "date", width: 14, numFmt: DATE },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Tarif horaire", key: "tarif", width: 13, numFmt: CHF },
            { header: "Objectif heures", key: "heures", width: 15, numFmt: HEURES },
            { header: "Objectif CHF", key: "objectif", width: 14, numFmt: CHF },
        ],
        rows: [...aggregats.entries()]
            .sort(([, a], [, b]) => a.date.getTime() - b.date.getTime() || a.collab.localeCompare(b.collab))
            .map(([k, v]) => ({ mois: Number(k.split("|")[1]), ...v })),
    };

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
    let moisAvecTarif = 0;
    let moisHeuresSansTarif = 0;

    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(collab => {
        scope.months.forEach(mois => {
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
            totalCa += ca;
            totalObjectif += objectif;

            parCollab.rows.push({
                collab: collab.name,
                mois,
                mois_nom: MOIS[mois - 1],
                heures: formule(`SUMIFS(${columnRange(timesheets, "heures")},${filtre(timesheets)})`, heures),
                // Tarif saisi pour ce mois (feuille Objectifs, au plus une ligne par mois) ; aucun
                // tarif → 0, donc CA réalisé 0.
                tarif: formule(`SUMIFS(${columnRange(objectifs, "tarif")},${filtre(objectifs)})`, tarif),
                ca: formule(`ROUND(${colonne("heures")}*${colonne("tarif")},2)`, ca),
                objectif: formule(`SUMIFS(${columnRange(objectifs, "objectif")},${filtre(objectifs)})`, objectif),
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
    const detailTarif = `Saisi pour chaque mois dans la fiche employé, onglet « Objectif » (${moisAvecTarif} mois-collaborateur avec un tarif)`
        + (moisHeuresSansTarif ? ` ; ${moisHeuresSansTarif} mois avec des heures productives mais sans tarif → CA réalisé 0` : "");
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
                "staging.x_suivi_annuel_employe", "staging.hr_employee", "staging.res_company",
                "kpi.operationnel_suivi_mensuel",
            ],
            colonnes: [
                {
                    nom: "CA réalisé",
                    description: "CA effectivement généré par le travail facturable",
                    metier: "CA généré réel",
                    formule: "Σ (h. productives × tarif horaire du mois)",
                    source: "Timesheets + fiche employé, onglet « Objectif »",
                    commentaire: "Tarif horaire saisi par mois dans l'onglet « Objectif » ; vide ou 0 → CA réalisé 0 pour ce mois",
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
                            { label: "Heures", detail: `${timesheets.rows.length} lignes productives (Timesheets)` },
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
