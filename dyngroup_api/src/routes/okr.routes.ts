import { Router } from "express";
import {
    getFinanceOkr,
    getRhOkr,
    getCommercialOkr,
    getOpsOkr,
    getOkrDimensions,
} from "../controllers/okr.controller";

const router = Router();

router.get("/finance", getFinanceOkr);
router.get("/rh", getRhOkr);
router.get("/commercial", getCommercialOkr);
router.get("/ops", getOpsOkr);
router.get("/dimensions", getOkrDimensions);

export default router;
