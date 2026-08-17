import { Router } from "express";
import {
    getOrganigram,
    getEmployeeAncestors,
    getEmployeeDescendants,
    getEmployeeTree,
} from "../controllers/organigram.controller";

const router = Router();

router.get("/", getOrganigram);
router.get("/employees/:id/ancestors", getEmployeeAncestors);
router.get("/employees/:id/descendants", getEmployeeDescendants);
router.get("/employees/:id/tree", getEmployeeTree);

export default router;
