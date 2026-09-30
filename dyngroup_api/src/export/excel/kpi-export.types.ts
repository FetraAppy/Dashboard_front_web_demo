// Contrat commun à tous les exports Excel de KPI : chaque KPI produit un KpiExport, et
// workbook-builder.ts le transforme en classeur (.xlsx), toujours avec la même structure.

/** Fiche descriptive du KPI — première feuille, section "Informations". */
export interface KpiDefinition {
    id: string;
    titre: string;
    /** Onglet du dashboard où se trouve le KPI (ex. "Suivi Mensuel & Détails"). */
    onglet: string;
    description: string;
    metier: string;
    formule: string;
    cible?: string;
    sourceOdoo: string;
    tables: string[];
    commentaires?: string[];
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
     * qui recalcule la valeur depuis une feuille de données, voir columnRange(). Si `value` est
     * aussi renseignée, elle sert de résultat affiché avant recalcul.
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

/** Feuille de données brutes (ex. une ligne par timesheet ayant servi au calcul). */
export interface DataSheet {
    /** Nom de l'onglet Excel — 31 caractères max, sans []:*?/\ (nettoyé automatiquement). */
    name: string;
    /** Rappelée dans la feuille "Informations", pour expliquer le contenu de l'onglet. */
    description?: string;
    columns: DataColumn[];
    rows: Record<string, unknown>[];
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
