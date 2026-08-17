import { Request, Response } from "express";
import { pool } from "../db/pool";

/**
 * Helper — construit la réponse structurée pour un ensemble de KR IDs.
 * Retourne :
 *   kr_id_map : { KR15: [{ period_key, actual_value, target_value, variance_pct, status }] }
 *   latest    : { KR15: { period_key, actual_value, target_value, variance_pct, status, kr_description, target_label } }
 */
async function buildOkrResponse(
    krIds: string[],
    annee: number
): Promise<{ kr_id_map: Record<string, any[]>; latest: Record<string, any> }> {
    const placeholders = krIds.map((_, i) => `$${i + 1}`).join(", ");
    const yearIdx = krIds.length + 1;

    const res = await pool.query(
        `SELECT kr_id, period_key, period_month, actual_value, target_value,
                variance_pct, status, kr_description, target_label, owner, department
         FROM kpi.okr_monthly
         WHERE kr_id IN (${placeholders})
           AND period_year = $${yearIdx}
           AND (dimension_key = '' OR dimension_key IS NULL)
         ORDER BY kr_id, period_month`,
        [...krIds, annee]
    );

    const kr_id_map: Record<string, any[]> = {};
    const latest: Record<string, any> = {};

    for (const id of krIds) {
        kr_id_map[id] = [];
    }

    res.rows.forEach((row) => {
        const entry = {
            period_key: row.period_key,
            period_month: row.period_month,
            actual_value: row.actual_value !== null ? parseFloat(row.actual_value) : null,
            target_value: row.target_value !== null ? parseFloat(row.target_value) : null,
            variance_pct: row.variance_pct !== null ? parseFloat(row.variance_pct) : null,
            status: row.status,
            kr_description: row.kr_description,
            target_label: row.target_label,
        };
        if (!kr_id_map[row.kr_id]) {
            kr_id_map[row.kr_id] = [];
        }
        kr_id_map[row.kr_id].push(entry);

        // Keep the most recent entry as "latest"
        if (
            !latest[row.kr_id] ||
            row.period_month > latest[row.kr_id].period_month
        ) {
            latest[row.kr_id] = { ...entry, owner: row.owner, department: row.department };
        }
    });

    return { kr_id_map, latest };
}

// ---------------------------------------------------------------------------
// GET /api/okr/finance?annee=2026
// KR couverts par le DAG : KR11, KR14, KR15, KR20, KR21, KR24, KR12
// KR partiels : KR13
// ---------------------------------------------------------------------------
export async function getFinanceOkr(req: Request, res: Response) {
    try {
        const annee = parseInt(req.query.annee as string) || 2026;
        const krIds = ["KR11", "KR14", "KR15", "KR20", "KR21", "KR24", "KR12"];
        const data = await buildOkrResponse(krIds, annee);
        res.json({ annee, ...data });
    } catch (err: any) {
        console.error("[okr/finance]", err);
        res.status(500).json({ error: "Erreur lors de la récupération des OKR Finance" });
    }
}

// ---------------------------------------------------------------------------
// GET /api/okr/rh?annee=2026
// KR couverts : KR01, KR06, KR02
// KR partiels : KR03 (externe)
// ---------------------------------------------------------------------------
export async function getRhOkr(req: Request, res: Response) {
    try {
        const annee = parseInt(req.query.annee as string) || 2026;
        const krIds = ["KR01", "KR06", "KR02"];
        const data = await buildOkrResponse(krIds, annee);
        res.json({ annee, ...data });
    } catch (err: any) {
        console.error("[okr/rh]", err);
        res.status(500).json({ error: "Erreur lors de la récupération des OKR RH" });
    }
}

// ---------------------------------------------------------------------------
// GET /api/okr/commercial?annee=2026
// KR couverts : KR07, KR09, KR16, KR17, KR08, KR23
// KR partiels : KR04 (hybrid), KR05 (externe)
// ---------------------------------------------------------------------------
export async function getCommercialOkr(req: Request, res: Response) {
  try {
    const annee = parseInt(req.query.annee as string) || 2026;
    const krIds = ["KR07", "KR09", "KR16", "KR17", "KR08", "KR23"];
        const data = await buildOkrResponse(krIds, annee);
        res.json({ annee, ...data });
    } catch (err: any) {
        console.error("[okr/commercial]", err);
        res.status(500).json({ error: "Erreur lors de la récupération des OKR Commercial" });
    }
}

// ---------------------------------------------------------------------------
// GET /api/okr/ops?annee=2026
// KR couverts : KR10, KR18, KR22, KR25, KR26, KR27, KR19
// ---------------------------------------------------------------------------
export async function getOpsOkr(req: Request, res: Response) {
    try {
        const annee = parseInt(req.query.annee as string) || 2026;
        const krIds = ["KR10", "KR18", "KR22", "KR25", "KR26", "KR27", "KR19"];
        const data = await buildOkrResponse(krIds, annee);
        res.json({ annee, ...data });
    } catch (err: any) {
        console.error("[okr/ops]", err);
        res.status(500).json({ error: "Erreur lors de la récupération des OKR Ops" });
    }
}

// ---------------------------------------------------------------------------
// GET /api/okr/dimensions?annee=2026
// Détails par dimension (client, département, tranche, détail RH…) pour les
// charts détaillés des onglets. Exclut la dimension 'status' (placeholders).
// Retourne : { dimensions: { KR08: { detail: { total: [ {period_key, period_month, actual_value} ] } } } }
// ---------------------------------------------------------------------------
export async function getOkrDimensions(req: Request, res: Response) {
    try {
        const annee = parseInt(req.query.annee as string) || 2026;
        const resDb = await pool.query(
            `SELECT kr_id, period_key, period_month, dimension_key, dimension_value, actual_value
             FROM kpi.okr_monthly
             WHERE period_year = $1
               AND dimension_key IS NOT NULL
               AND dimension_key <> ''
               AND dimension_key <> 'status'
             ORDER BY kr_id, dimension_key, dimension_value, period_month`,
            [annee]
        );
        const dimensions: Record<string, Record<string, Record<string, any[]>>> = {};
        resDb.rows.forEach((row) => {
            if (!dimensions[row.kr_id]) dimensions[row.kr_id] = {};
            if (!dimensions[row.kr_id][row.dimension_key]) dimensions[row.kr_id][row.dimension_key] = {};
            const dimVal = row.dimension_value ?? "";
            if (!dimensions[row.kr_id][row.dimension_key][dimVal]) {
                dimensions[row.kr_id][row.dimension_key][dimVal] = [];
            }
            dimensions[row.kr_id][row.dimension_key][dimVal].push({
                period_key: row.period_key,
                period_month: row.period_month,
                actual_value: row.actual_value !== null ? parseFloat(row.actual_value) : null,
            });
        });
        res.json({ annee, dimensions });
    } catch (err: any) {
        console.error("[okr/dimensions]", err);
        res.status(500).json({ error: "Erreur lors de la récupération des dimensions OKR" });
    }
}
