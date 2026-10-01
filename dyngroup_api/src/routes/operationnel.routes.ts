import { Router } from "express";
import { getDashboardData } from "../controllers/operationnel.controller";
import { exportOperationnelKpi } from "../controllers/operationnel-export.controller";

const router = Router();

router.get("/dashboard", getDashboardData);
router.get("/export/:kpiId", exportOperationnelKpi);

export default router;
