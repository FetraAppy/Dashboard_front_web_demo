import { Request, Response } from "express";
import { buildKpiWorkbook, sendWorkbook } from "../export/excel/workbook-builder";
import {
    describeFilters,
    ExportFilterError,
    filtersSlug,
    parseOperationnelFilters,
    resolveEmployeeScope,
} from "../export/operationnel/export-filters";
import { OPERATIONNEL_KPI_EXPORTERS } from "../export/operationnel/kpi-registry";

/**
 * GET /api/operationnel/export/:kpiId?annee=2026&mois=all|1-12&collab=<nom>|all&companies=<nom>
 * (companies peut être répété). Génère le .xlsx du KPI demandé avec les filtres actifs du dashboard.
 */
export async function exportOperationnelKpi(req: Request, res: Response) {
    const kpiId = String(req.params.kpiId);
    const exporter = OPERATIONNEL_KPI_EXPORTERS[kpiId];
    if (!exporter) {
        res.status(404).json({ error: `Export inconnu : ${kpiId}` });
        return;
    }

    try {
        const filters = parseOperationnelFilters(req.query);
        const scope = await resolveEmployeeScope(filters);
        const exp = await exporter(filters, scope);
        const workbook = buildKpiWorkbook(exp, describeFilters(filters, scope));
        await sendWorkbook(res, workbook, `${exp.definition.id}_${filtersSlug(filters)}.xlsx`);
    } catch (err: any) {
        if (err instanceof ExportFilterError) {
            res.status(400).json({ error: err.message });
            return;
        }
        console.error(`[operationnel/export/${kpiId}]`, err);
        res.status(500).json({ error: "Erreur lors de la génération de l'export Excel" });
    }
}
