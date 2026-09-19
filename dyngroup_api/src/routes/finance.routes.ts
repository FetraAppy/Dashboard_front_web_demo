import { Router } from "express";
import { getFinanceDashboard, getFinanceCompanies } from "../controllers/finance.controller";

const router = Router();

router.get("/dashboard", getFinanceDashboard);
router.get("/companies", getFinanceCompanies);

export default router;
