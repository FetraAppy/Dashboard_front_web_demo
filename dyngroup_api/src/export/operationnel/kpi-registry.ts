import { KpiExport } from "../excel/kpi-export.types";
import { EmployeeScope, OperationnelExportFilters } from "./export-filters";
import { exportCaRealise } from "./kpis/ca-realise";
import { exportHeuresNonFacturables } from "./kpis/heures-non-facturables";
import { exportHeuresTheoriquesRealisees } from "./kpis/heures-theoriques-realisees";
import { exportObjectifFacturation } from "./kpis/objectif-facturation";
import { exportObjectifProductivite } from "./kpis/objectif-productivite";
import { exportProductiviteMensuelle } from "./kpis/productivite-mensuelle";
import { exportSuiviHeureVariableVacances } from "./kpis/suivi-heure-variable-vacances";
import { exportSuiviMensuelDetaille } from "./kpis/suivi-mensuel-detaille";
import { exportSuiviObjectifMensuel } from "./kpis/suivi-objectif-mensuel";

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
    "heures-theoriques-realisees": exportHeuresTheoriquesRealisees,
    "suivi-objectif-mensuel": exportSuiviObjectifMensuel,
    "ca-realise": exportCaRealise,
    "objectif-facturation": exportObjectifFacturation,
    "objectif-productivite": exportObjectifProductivite,
    "productivite-mensuelle": exportProductiviteMensuelle,
    "heures-non-facturables": exportHeuresNonFacturables,
    "suivi-heure-variable-vacances": exportSuiviHeureVariableVacances,
};
