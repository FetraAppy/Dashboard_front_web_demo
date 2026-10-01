// Contrat commun à tous les exports Excel de KPI : chaque KPI produit un KpiExport, et
// workbook-builder.ts le transforme en classeur (.xlsx), toujours avec la même structure.

/** Fiche d'une colonne, pour un KPI présenté sous forme de tableau (ex. Tableau de suivi mensuel). */
export interface KpiColonne {
    nom: string;
    description: string;
    metier: string;
    formule: string;
    source: string;
    commentaire?: string;
}

/**
 * Fiche descriptive du KPI — première feuille, section "Indicateur". Un KPI à valeur unique
 * remplit description/metier/formule/sourceOdoo ; un KPI tableau décrit plutôt chaque colonne
 * dans `colonnes` (les deux peuvent coexister).
 */
export interface KpiDefinition {
    id: string;
    titre: string;
    /** Onglet du dashboard où se trouve le KPI (ex. "Suivi Mensuel & Détails"). */
    onglet: string;
    description?: string;
    metier?: string;
    formule?: string;
    cible?: string;
    sourceOdoo?: string;
    tables: string[];
    /**
     * N'est plus affiché dans le classeur (retiré de la feuille Informations le 2026-10-01, demande
     * utilisateur) — conservé uniquement pour que les exporteurs existants compilent encore.
     */
    commentaires?: string[];
    colonnes?: KpiColonne[];
}

/**
 * Étape du chemin de calcul, affichée en arbre (indentation + regroupement Excel dépliable).
 * La racine porte la valeur du KPI ; ses enfants décrivent comment on l'a obtenue.
 * Ex. { label: 'H. Productivité', value: 1029.75, children: [
 *       { label: 'Source', detail: 'Feuilles de temps', children: [
 *         { label: 'Filtre', detail: 'Productivité = Oui' } ] } ] }
 */
export interface DerivationNode {
    label: string;
    detail?: string;
    value?: number | string;
    /**
     * Formule Excel (syntaxe anglaise, séparateur virgule — Excel la traduit à l'affichage)
     * qui recalcule la valeur depuis une feuille de données, voir columnRange()/cellRef(). Si
     * `value` est aussi renseignée, elle sert de résultat affiché avant recalcul.
     */
    formula?: string;
    numFmt?: string;
    children?: DerivationNode[];
}

export interface DataColumn {
    header: string;
    key: string;
    width?: number;
    numFmt?: string;
}

/** Valeur calculée par formule dans une feuille de données (ex. H. théoriques d'un segment). */
export interface FormulaCell {
    formula: string;
    /** Valeur calculée côté API, affichée avant recalcul par Excel. */
    result?: number | string;
}

export type DataValue = string | number | boolean | Date | null | undefined | FormulaCell;

/** Feuille de données (ex. une ligne par timesheet ayant servi au calcul). */
export interface DataSheet {
    /** Nom de l'onglet Excel — 31 caractères max, sans []:*?/\ (nettoyé automatiquement). */
    name: string;
    /** Affichée en note (au survol) sur la 1re cellule d'en-tête de l'onglet. */
    description?: string;
    columns: DataColumn[];
    rows: Record<string, DataValue>[];
    /** La dernière ligne est une ligne Total : mise en évidence (gras, fond, bordure). */
    lastRowIsTotal?: boolean;
}

export interface KpiExport {
    definition: KpiDefinition;
    derivation: DerivationNode[];
    sheets: DataSheet[];
}

/** Filtres actifs du dashboard, rappelés en tête de la feuille "Informations". */
export interface FiltreAffiche {
    label: string;
    value: string;
}
