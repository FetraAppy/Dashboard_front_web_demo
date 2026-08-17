import { Router } from "express";
import { getDashboardSynthese, getDashboardEngagement, getDashboardGoogleReviews } from "../controllers/dashboard.controller";

const router = Router();

router.get("/synthese", getDashboardSynthese);
router.get("/engagement", getDashboardEngagement);
router.get("/google-reviews", getDashboardGoogleReviews);

export default router;
