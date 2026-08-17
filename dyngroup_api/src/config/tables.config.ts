export interface TableConfig {
    name: string;
    schema?: string;            // défaut: "public"
    primaryKey?: string | null; // défaut: "id" — mettre `null` si la table n'a pas de clé primaire
}

export const tablesConfig: TableConfig[] = [
    { name: "items" },
    { name: "clients" },
    { name: "commandes", primaryKey: "id_commande" },
    { name: "operationnel_suivi_mensuel", schema: "kpi", primaryKey: null },
    { name: "operationnel_productivite_mensuelle", schema: "kpi", primaryKey: null },
    { name: "operationnel_heures_repartition", schema: "kpi", primaryKey: null },
    { name: "operationnel_synthese_annuelle", schema: "kpi", primaryKey: null },
    { name: "operationnel_budget_employe", schema: "kpi", primaryKey: null },
    { name: "operationnel_solde_vacances", schema: "kpi", primaryKey: null },
    { name: "hr_employee", schema: "staging", primaryKey: "id" },
    { name: "okr_monthly", schema: "kpi", primaryKey: null },
    { name: "okr_reference", schema: "kpi", primaryKey: "kr_id" },
];