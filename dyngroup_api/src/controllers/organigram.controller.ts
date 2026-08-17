import { Request, Response } from "express";
import { pool } from "../db/pool";

/**
 * GET /api/organigram
 * Retourne l'organigramme complet :
 *   - departments : liste des départements
 *   - employees   : liste des employés
 *   - closure     : tous les couples (ancestor_id, descendant_id, depth)
 *   - roots       : les managers de plus haut niveau (sans manager)
 */
export async function getOrganigram(req: Request, res: Response) {
    try {
        const [deptRes, empRes, closureRes] = await Promise.all([
            pool.query(`
                SELECT department_id, department_name, parent_department_id,
                       parent_department_name, manager_employee_id, manager_name
                FROM kpi.dim_department
                ORDER BY department_id
            `),
            pool.query(`
                SELECT employee_id, employee_name, department_id, department_name,
                       manager_employee_id, manager_name,
                       active, departure_date
                FROM kpi.organigram
                ORDER BY employee_id
            `),
            pool.query(`
                SELECT ancestor_employee_id, descendant_employee_id, depth
                FROM kpi.dim_employee_closure
                ORDER BY ancestor_employee_id, depth
            `),
        ]);

        const roots = empRes.rows.filter((e) => e.manager_employee_id === null);

        res.json({
            departments: deptRes.rows,
            employees: empRes.rows,
            closure: closureRes.rows,
            roots: roots.map((e) => e.employee_id),
        });
    } catch (err: any) {
        console.error("[organigram]", err);
        res.status(500).json({ error: "Erreur lors de la récupération de l'organigramme" });
    }
}

function parseEmployeeId(req: Request, res: Response): number | null {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
        res.status(400).json({ error: "ID employé invalide" });
        return null;
    }
    return id;
}

/**
 * GET /api/organigram/employees/:id/ancestors
 * Tous les N+1, N+2, ... au-dessus d'un employé.
 */
export async function getEmployeeAncestors(req: Request, res: Response) {
    try {
        const employeeId = parseEmployeeId(req, res);
        if (employeeId === null) return;

        const ancRes = await pool.query(`
            SELECT e.employee_id, e.employee_name, e.department_name,
                   e.manager_employee_id, e.departure_date,
                   e.active, c.depth
            FROM kpi.dim_employee_closure c
            JOIN kpi.organigram e ON e.employee_id = c.ancestor_employee_id
            WHERE c.descendant_employee_id = $1 AND c.depth > 0
            ORDER BY c.depth
        `, [employeeId]);

        res.json({ employee_id: employeeId, ancestors: ancRes.rows });
    } catch (err: any) {
        console.error("[organigram/ancestors]", err);
        res.status(500).json({ error: "Erreur lors de la récupération des ancêtres" });
    }
}

/**
 * GET /api/organigram/employees/:id/descendants
 * Tous les subordonnés directs et indirects en dessous d'un employé.
 */
export async function getEmployeeDescendants(req: Request, res: Response) {
    try {
        const employeeId = parseEmployeeId(req, res);
        if (employeeId === null) return;

        const descRes = await pool.query(`
            SELECT e.employee_id, e.employee_name, e.department_name,
                   e.manager_employee_id, e.departure_date,
                   e.active, c.depth
            FROM kpi.dim_employee_closure c
            JOIN kpi.organigram e ON e.employee_id = c.descendant_employee_id
            WHERE c.ancestor_employee_id = $1 AND c.depth > 0
            ORDER BY c.depth
        `, [employeeId]);

        res.json({ employee_id: employeeId, descendants: descRes.rows });
    } catch (err: any) {
        console.error("[organigram/descendants]", err);
        res.status(500).json({ error: "Erreur lors de la récupération des descendants" });
    }
}

/**
 * GET /api/organigram/employees/:id/tree
 * Ancêtres + descendants pour un employé.
 */
export async function getEmployeeTree(req: Request, res: Response) {
    try {
        const employeeId = parseEmployeeId(req, res);
        if (employeeId === null) return;

        const [empRes, ancRes, descRes] = await Promise.all([
            pool.query(`SELECT * FROM kpi.organigram WHERE employee_id = $1`, [employeeId]),
            pool.query(`
                SELECT e.employee_id, e.employee_name, e.department_name,
                       e.manager_employee_id, c.depth
                FROM kpi.dim_employee_closure c
                JOIN kpi.organigram e ON e.employee_id = c.ancestor_employee_id
                WHERE c.descendant_employee_id = $1 AND c.depth > 0
                ORDER BY c.depth
            `, [employeeId]),
            pool.query(`
                SELECT e.employee_id, e.employee_name, e.department_name,
                       e.manager_employee_id, c.depth
                FROM kpi.dim_employee_closure c
                JOIN kpi.organigram e ON e.employee_id = c.descendant_employee_id
                WHERE c.ancestor_employee_id = $1 AND c.depth > 0
                ORDER BY c.depth
            `, [employeeId]),
        ]);

        if (empRes.rows.length === 0) {
            res.status(404).json({ error: "Employé non trouvé" });
            return;
        }

        res.json({
            employee: empRes.rows[0],
            ancestors: ancRes.rows,
            descendants: descRes.rows,
        });
    } catch (err: any) {
        console.error("[organigram/tree]", err);
        res.status(500).json({ error: "Erreur lors de la récupération de l'arbre" });
    }
}
