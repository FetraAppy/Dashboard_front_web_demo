import { pool } from "../../../db/pool";
import { DataSheet, FormulaCell, KpiExport } from "../../excel/kpi-export.types";
import { cellRef, columnRange } from "../../excel/workbook-builder";
import { EmployeeScope, MOIS, OperationnelExportFilters } from "../export-filters";

// Export de la carte OBJECTIF "Objectif facturation" (Indicateurs Clés).
//   Objectif facturation = Σ objectif CHF saisi par mois dans l'onglet "Objectif" de la fiche
//   employé (x_suivi_annuel_employe.x_studio_objectif_chf), lignes actives uniquement, plusieurs
//   lignes du même mois additionnées (operationnel.controller.ts, requête 13 ; kpiObjFact).
//   Les mois futurs comptent : un objectif déjà saisi pour un mois à venir est inclus.
// Chaîne de calcul, par formules Excel :
//   Objectifs (lignes Odoo) → Par collaborateur → Objectif facturation.
// Les textes du classeur sont destinés au client : pas de noms de champs Odoo.

const CHF = "#,##0.00";
const HEURES = "0.00";
const DATE = "dd.mm.yyyy";

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");
const frDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const formule = (formula: string, result: number | string): FormulaCell => ({ formula, result });

/**
 * Lignes de l'onglet "Objectif" de la fiche employé, une par enregistrement Odoo. L'objectif
 * heures et le tarif horaire sont donnés à titre d'information (l'objectif CHF ne les recalcule
 * pas) : sans ces colonnes (pas encore extraites), on relit sans elles.
 */
async function loadObjectifs(ids: number[], debut: string, fin: string) {
    const sql = (heures: string, tarif: string) =>
        `SELECT x_studio_employ AS employee_id, TO_CHAR(x_studio_mois_objectif::date, 'YYYY-MM-DD') AS date,
                ${heures} AS heures, ${tarif} AS tarif, x_studio_objectif_chf AS objectif
         FROM staging.x_suivi_annuel_employe
         WHERE x_active = true AND x_studio_employ = ANY($1::int[])
           AND x_studio_mois_objectif::date BETWEEN $2::date AND $3::date
         ORDER BY x_studio_mois_objectif::date, x_studio_employ`;
    try {
        return (await pool.query(
            sql("x_studio_objectif", "NULLIF(TRIM(x_studio_tarif_horaire::text), '')::numeric"), [ids, debut, fin]
        )).rows;
    } catch (e: any) {
        console.warn("[export objectif-facturation] objectif heures / tarif non disponibles :", e.message);
    }
    try {
        return (await pool.query(sql("NULL::numeric", "NULL::numeric"), [ids, debut, fin])).rows;
    } catch (e: any) {
        // Comme le dashboard : objectif CHF pas encore extrait → objectif 0.
        console.warn("[export objectif-facturation] objectif CHF non disponible :", e.message);
        return [];
    }
}

export async function exportObjectifFacturation(
    filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    const collabParId = new Map(scope.employees.map(e => [e.id, e]));
    const cle = (employeeId: number, mois: number) => `${employeeId}|${mois}`;

    const lignesObjectif = await loadObjectifs(scope.employeeIds, scope.dateFrom, scope.dateTo);

    // --- Feuille "Objectifs" : lignes Odoo brutes de la période ------------------------------
    const objectifParCollabMois = new Map<string, number>();
    const collabsAvecObjectif = new Set<number>();
    const objectifs: DataSheet = {
        name: "Objectifs",
        description: "Lignes de l'onglet « Objectif » de la fiche employé Odoo sur la période (plusieurs lignes du même mois sont additionnées)",
        columns: [
            { header: "Mois objectif", key: "date", width: 14, numFmt: DATE },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Objectif heures", key: "heures", width: 15, numFmt: HEURES },
            { header: "Tarif horaire", key: "tarif", width: 13, numFmt: CHF },
            { header: "Objectif CHF", key: "objectif", width: 14, numFmt: CHF },
        ],
        rows: [],
    };
    lignesObjectif.forEach(l => {
        const collab = collabParId.get(l.employee_id);
        if (!collab) return;
        const [an, mois, jour] = l.date.split("-").map(Number);
        const objectif = parseFloat(l.objectif) || 0;
        const k = cle(collab.id, mois);
        objectifParCollabMois.set(k, (objectifParCollabMois.get(k) ?? 0) + objectif);
        if (objectif > 0) collabsAvecObjectif.add(collab.id);
        const heures = parseFloat(l.heures);
        const tarif = parseFloat(l.tarif);
        objectifs.rows.push({
            date: new Date(Date.UTC(an, mois - 1, jour)),
            mois,
            collab: collab.name,
            societe: collab.company ?? "",
            heures: isNaN(heures) ? null : heures,
            tarif: isNaN(tarif) ? null : tarif,
            objectif,
        });
    });

    // --- Feuille "Par collaborateur" : objectif CHF, un mois du filtre par ligne ---------------
    const parCollab: DataSheet = {
        name: "Par collaborateur",
        description: "Objectif CHF par collaborateur et par mois (somme des lignes Objectifs du mois)",
        columns: [
            { header: "Collaborateur", key: "collab", width: 28 },
            { header: "Société", key: "societe", width: 24 },
            { header: "Mois", key: "mois", width: 7 },
            { header: "Nom du mois", key: "mois_nom", width: 12 },
            { header: "Objectif CHF", key: "objectif", width: 14, numFmt: CHF },
        ],
        rows: [],
    };
    const objectifParMois = new Map<number, number>();
    [...scope.employees].sort((a, b) => a.name.localeCompare(b.name)).forEach(collab => {
        scope.months.forEach(mois => {
            const ligne = parCollab.rows.length;
            const colonne = (key: string) => cellRef(parCollab, key, ligne);
            const objectif = objectifParCollabMois.get(cle(collab.id, mois)) ?? 0;
            objectifParMois.set(mois, (objectifParMois.get(mois) ?? 0) + objectif);
            parCollab.rows.push({
                collab: collab.name,
                societe: collab.company ?? "",
                mois,
                mois_nom: MOIS[mois - 1],
                objectif: formule(
                    `SUMIFS(${columnRange(objectifs, "objectif")},${columnRange(objectifs, "collab")},${colonne("collab")},${columnRange(objectifs, "mois")},${colonne("mois")})`,
                    objectif
                ),
            });
        });
    });

    // --- Feuille "Objectif facturation" : ce que montre la carte (ligne Total) ----------------
    const resultat: DataSheet = {
        name: "Objectif facturation",
        description: "Objectif facturation par mois du filtre + Total (valeur de la carte)",
        columns: [
            { header: "N° mois", key: "mois", width: 9 },
            { header: "Mois", key: "mois_nom", width: 16 },
            { header: "Objectif facturation", key: "objectif", width: 20, numFmt: CHF },
        ],
        rows: [],
        lastRowIsTotal: true,
    };
    let totalObjectif = 0;
    scope.months.forEach(mois => {
        const ligne = resultat.rows.length;
        const objectif = round2(objectifParMois.get(mois) ?? 0);
        totalObjectif += objectif;
        resultat.rows.push({
            mois,
            mois_nom: MOIS[mois - 1],
            objectif: formule(
                `SUMIFS(${columnRange(parCollab, "objectif")},${columnRange(parCollab, "mois")},${cellRef(resultat, "mois", ligne)})`,
                objectif
            ),
        });
    });
    const ligneTotal = resultat.rows.length;
    resultat.rows.push({
        mois: null,
        mois_nom: "Total",
        objectif: formule(
            `SUM(${cellRef(resultat, "objectif", 0)}:${cellRef(resultat, "objectif", ligneTotal - 1)})`,
            round2(totalObjectif)
        ),
    });

    // --- Fiche et chemin de calcul ------------------------------------------------------------
    const nbCollab = scope.employees.length;
    const nbAvecObjectif = collabsAvecObjectif.size;
    const perimetre = `${nbCollab} collaborateur${nbCollab > 1 ? "s" : ""}, du ${frDate(new Date(scope.dateFrom))} au ${frDate(new Date(scope.dateTo))}`;

    return {
        definition: {
            id: "objectif-facturation",
            titre: "Objectif facturation",
            onglet: "Indicateurs Clés",
            description: "Montant CHF que les collaborateurs doivent facturer sur la période",
            metier: "Cible financière fixée dans la fiche employé",
            formule: "Σ objectif CHF par collaborateur et par mois",
            sourceOdoo: "Fiche employé, onglet « Objectif » (lignes actives)",
            tables: ["staging.x_suivi_annuel_employe", "staging.hr_employee", "staging.res_company", "kpi.operationnel_suivi_mensuel"],
            colonnes: [
                {
                    nom: "Objectif facturation",
                    description: "Montant CHF que le collaborateur doit facturer sur le mois",
                    metier: "Cible fixée dans la fiche employé",
                    formule: "Σ objectif CHF du mois",
                    source: "Fiche employé, onglet « Objectif »",
                    commentaire: "Plusieurs lignes pour le même mois sont additionnées ; un objectif saisi pour un mois futur est compté",
                },
            ],
        },
        derivation: [
            {
                label: "Objectif facturation (CHF)", formula: cellRef(resultat, "objectif", ligneTotal, true), value: round2(totalObjectif), numFmt: CHF,
                children: [
                    { label: "Périmètre", detail: perimetre },
                    { label: "Source", detail: `${objectifs.rows.length} lignes de l'onglet « Objectif » de la période (Objectifs)` },
                    { label: "Collaborateurs", detail: `${nbAvecObjectif} collaborateur${nbAvecObjectif > 1 ? "s" : ""} sur ${nbCollab} ont un objectif saisi` },
                    { label: "Calcul", detail: "Σ par collaborateur et mois (Par collaborateur) → Σ par mois → Σ des mois" },
                ],
            },
        ],
        sheets: [resultat, parCollab, objectifs],
    };
}
