import { KpiExport } from "../excel/kpi-export.types";
import { EmployeeScope, OperationnelExportFilters } from "./export-filters";
import { exportSuiviMensuelDetaille } from "./kpis/suivi-mensuel-detaille";

/**
 * Un exporteur par KPI du dashboard Opérationnel, chacun dans son propre fichier sous
 * ./kpis/ : il interroge staging.* sur le périmètre fourni (mêmes filtres que le dashboard) et
 * renvoie la fiche du KPI, son chemin de calcul et ses données brutes ligne par ligne.
 */
export type OperationnelKpiExporter = (
    filters: OperationnelExportFilters,
    scope: EmployeeScope
) => Promise<KpiExport>;

/** Clé = identifiant utilisé dans l'URL : GET /api/operationnel/export/:kpiId */
export const OPERATIONNEL_KPI_EXPORTERS: Record<string, OperationnelKpiExporter> = {
    "suivi-mensuel-detaille": exportSuiviMensuelDetaille,
};
