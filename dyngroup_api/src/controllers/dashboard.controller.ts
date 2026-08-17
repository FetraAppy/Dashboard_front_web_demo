import { Request, Response } from "express";
import { pool } from "../db/pool";

/**
 * GET /api/dashboard/synthese?annee=2026
 * Vue consolidée pour le tableau de bord de synthèse.
 *  - KR15 — CA mensuel : kpi.okr_monthly (kr_id = 'KR15')
 *  - KR11 — Trésorerie mensuelle : kpi.okr_monthly (kr_id = 'KR11')
 *  - KR22 — Taux de facturation mensuel (kpi.okr_monthly)
 *  - Cartes KPI : dernières valeurs non nulles de KR07, KR22, KR16, KR10, KR13, KR18
 * Retourne 12 mois (Jan..Déc) de l'année demandée.
 */
export async function getDashboardSynthese(req: Request, res: Response) {
    try {
        const annee = parseInt(req.query.annee as string) || 2026;

        // KR15 — CA mensuel (HT) depuis kpi.okr_monthly (même source que le finance-tab)
        const caRes = await pool.query(
            `SELECT period_month, actual_value, target_value, status
             FROM kpi.okr_monthly
             WHERE kr_id = 'KR15'
               AND period_year = $1
               AND (dimension_key = '' OR dimension_key IS NULL OR dimension_key != 'status')
             ORDER BY period_month`,
            [annee]
        );
        const caByMonth: Record<number, { value: number | null; target: number | null; status: string }> = {};
        caRes.rows.forEach((r) => {
            caByMonth[r.period_month] = {
                value: r.actual_value !== null ? parseFloat(r.actual_value) : null,
                target: r.target_value !== null ? parseFloat(r.target_value) : null,
                status: r.status,
            };
        });

        // KR11 — Trésorerie mensuelle
        const tresRes = await pool.query(
            `SELECT period_month, actual_value, target_value, status
             FROM kpi.okr_monthly
             WHERE kr_id = 'KR11'
               AND period_year = $1
               AND (dimension_key = '' OR dimension_key IS NULL OR dimension_key != 'status')
             ORDER BY period_month`,
            [annee]
        );
        const tresByMonth: Record<number, { value: number | null; target: number | null; status: string }> = {};
        tresRes.rows.forEach((r) => {
            tresByMonth[r.period_month] = {
                value: r.actual_value !== null ? parseFloat(r.actual_value) : null,
                target: r.target_value !== null ? parseFloat(r.target_value) : null,
                status: r.status,
            };
        });

        const labels = Array.from({ length: 12 }, (_, i) => i + 1);
        const caSeries = labels.map((m) =>
            caByMonth[m] && caByMonth[m].value !== null
                ? caByMonth[m].value! / 1000
                : null
        ); // kCHF
        const caTarget =
            caRes.rows.length > 0 && caRes.rows[0].target_value !== null
                ? parseFloat(caRes.rows[0].target_value) / 1000
                : 540;

        const tresSeries = labels.map((m) =>
            tresByMonth[m] && tresByMonth[m].value !== null
                ? tresByMonth[m].value! / 1000
                : null
        ); // kCHF
        const tresTarget =
            tresRes.rows.length > 0 && tresRes.rows[0].target_value !== null
                ? parseFloat(tresRes.rows[0].target_value) / 1000
                : 500;

        // KR22 — Taux de facturation mensuel (%)
        const billingRes = await pool.query(
            `SELECT period_month, actual_value, target_value, status
             FROM kpi.okr_monthly
             WHERE kr_id = 'KR22'
               AND period_year = $1
               AND (dimension_key = '' OR dimension_key IS NULL OR dimension_key != 'status')
             ORDER BY period_month`,
            [annee]
        );
        const billingByMonth: Record<number, { value: number | null; status: string }> = {};
        billingRes.rows.forEach((r) => {
            billingByMonth[r.period_month] = {
                value: r.actual_value !== null ? parseFloat(r.actual_value) : null,
                status: r.status,
            };
        });
        const billingSeries = labels.map((m) =>
            billingByMonth[m] && billingByMonth[m].value !== null
                ? billingByMonth[m].value!
                : null
        );

        // Cartes KPI — dernière valeur non nulle de chaque KR
        const kpiRes = await pool.query(
            `SELECT DISTINCT ON (kr_id) kr_id, actual_value, target_value, status
             FROM kpi.okr_monthly
             WHERE kr_id = ANY($1::text[])
               AND (dimension_key = '' OR dimension_key IS NULL OR dimension_key != 'status')
               AND actual_value IS NOT NULL
             ORDER BY kr_id, period_year DESC, period_month DESC`,
            [["KR07", "KR22", "KR16", "KR10", "KR13", "KR18"]]
        );
        const kpis: Record<string, { value: number | null; target: number | null; status: string }> = {};
        kpiRes.rows.forEach((r) => {
            kpis[r.kr_id] = {
                value: r.actual_value !== null ? parseFloat(r.actual_value) : null,
                target: r.target_value !== null ? parseFloat(r.target_value) : null,
                status: r.status,
            };
        });

        // Dernier mois disponible dans la série
        const lastCa = caSeries.filter((v) => v !== null).pop() ?? null;
        const lastCaStatus = "unknown";

        const lastTres = tresSeries.filter((v) => v !== null).pop() ?? null;
        const lastTresStatus =
            (Object.values(tresByMonth).filter((t) => t.value !== null).pop() as any)
                ?.status ?? "unknown";

        res.json({
            annee,
            labels,
            kr15: { series: caSeries, target: caTarget, latest: lastCa, status: lastCaStatus },
            kr11: { series: tresSeries, target: tresTarget, latest: lastTres, status: lastTresStatus },
            kr22: { series: billingSeries, latest: billingSeries.filter((v) => v !== null).pop() ?? null },
            kpis,
        });
    } catch (err: any) {
        console.error("[dashboard/synthese]", err);
        res.status(500).json({ error: "Erreur lors de la récupération de la synthèse" });
    }
}

/**
 * GET /api/dashboard/engagement?annee=2026
 * Engagement digital par réseau (KR04) depuis kpi.okr_monthly
 * (dimension_key = 'network').
 * Retourne une série mensuelle (12 mois) par réseau.
 */
export async function getDashboardEngagement(req: Request, res: Response) {
    try {
        const annee = parseInt(req.query.annee as string) || 2026;

        const resDb = await pool.query(
            `SELECT period_month, dimension_value AS network,
                    SUM(actual_value) AS value
             FROM kpi.okr_monthly
             WHERE kr_id = 'KR04'
               AND period_year = $1
               AND dimension_key = 'network'
               AND dimension_value IS NOT NULL
               AND dimension_value <> ''
             GROUP BY period_month, dimension_value
             ORDER BY dimension_value, period_month`,
            [annee]
        );

        const networks: Record<string, (number | null)[]> = {};
        resDb.rows.forEach((r) => {
            const net = (r.network || "unknown").toLowerCase();
            if (!networks[net]) networks[net] = Array(12).fill(null);
            const idx = parseInt(r.period_month, 10) - 1;
            if (idx >= 0 && idx < 12) {
                networks[net][idx] = r.value !== null ? parseFloat(r.value) : null;
            }
        });

        res.json({ annee, networks });
    } catch (err: any) {
        console.error("[dashboard/engagement]", err);
        res.status(500).json({ error: "Erreur lors de la récupération de l'engagement" });
    }
}

/**
 * GET /api/dashboard/google-reviews?annee=2026
 * Avis Google (KR05) depuis kpi.okr_monthly :
 *   - rating  : note moyenne mensuelle (toutes années confondues)
 *   - count   : nombre d'avis mensuels (filtré par année si spécifié)
 */
export async function getDashboardGoogleReviews(req: Request, res: Response) {
    try {
        const annee = parseInt(req.query.annee as string) || 2026;

        const ratingRes = await pool.query(
            `SELECT period_year, period_month, actual_value
             FROM kpi.okr_monthly
             WHERE kr_id = 'KR05'
               AND (dimension_key = '' OR dimension_key IS NULL)
               AND status <> 'pending_external_source'
             ORDER BY period_year DESC, period_month DESC`,
        );
        const countRes = await pool.query(
            `SELECT period_month, actual_value
             FROM kpi.okr_monthly
             WHERE kr_id = 'KR05'
               AND period_year = $1
               AND dimension_key = 'count'
             ORDER BY period_month`,
            [annee]
        );
        const overallRes = await pool.query(
            `SELECT rating::numeric AS overall_rating,
                    COALESCE(NULLIF(review_text, ''), '0')::integer AS total_reviews
             FROM staging."external_google_reviews"
             WHERE review_id = 'overall' AND source = 'overall'
             ORDER BY review_date DESC
             LIMIT 1`,
        );

        const ratingSeries: (number | null)[] = Array(12).fill(null);
        const countSeries: (number | null)[] = Array(12).fill(null);
        ratingRes.rows.forEach((r) => {
            const idx = parseInt(r.period_month, 10) - 1;
            if (idx >= 0 && idx < 12) ratingSeries[idx] = r.actual_value !== null ? parseFloat(r.actual_value) : null;
        });
        countRes.rows.forEach((r) => {
            const idx = parseInt(r.period_month, 10) - 1;
            if (idx >= 0 && idx < 12) countSeries[idx] = r.actual_value !== null ? parseFloat(r.actual_value) : null;
        });

        const overall = overallRes.rows[0];
        const latestRating = overall ? parseFloat(overall.overall_rating) : (ratingRes.rows[0]?.actual_value ?? null);
        const totalReviews = overall ? parseInt(overall.total_reviews, 10) : 0;
        const hasData = ratingSeries.some((v) => v !== null) || overall !== null;

        // Distribution des étoiles (1..5) + liste des avis — avis Google réels,
        // toutes années confondues (pas de filtre année)
        const distRes = await pool.query(
            `SELECT rating::int AS rating, COUNT(*) AS nb
             FROM staging."external_google_reviews"
             WHERE source = 'google'
               AND rating IS NOT NULL
               AND rating >= 1 AND rating <= 5
             GROUP BY 1
             ORDER BY 1`
        );
        const distribution: { rating: number; nb: number }[] = distRes.rows.map((r) => ({
            rating: parseInt(r.rating, 10),
            nb: parseInt(r.nb, 10),
        }));

        const revRes = await pool.query(
            `SELECT rating::int AS rating, author_name, review_text, review_date
             FROM staging."external_google_reviews"
             WHERE source = 'google'
               AND rating IS NOT NULL
               AND rating >= 1 AND rating <= 5
             ORDER BY review_date DESC NULLS LAST
             LIMIT 200`
        );
        const reviews: { rating: number; author: string; text: string; date: string | null }[] =
            revRes.rows.map((r) => ({
                rating: parseInt(r.rating, 10),
                author: r.author_name || '',
                text: r.review_text || '',
                date: r.review_date,
            }));

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.json({
            annee,
            ratingSeries,
            countSeries,
            latestRating: latestRating !== null ? parseFloat(latestRating as string) : null,
            totalReviews,
            hasData,
            distribution,
            reviews,
        });
    } catch (err: any) {
        console.error("[dashboard/google-reviews]", err);
        res.status(500).json({ error: "Erreur lors de la récupération des avis Google" });
    }
}
