import { Request } from "express";
import { pool } from "../../db/pool";
import { FiltreAffiche } from "../excel/kpi-export.types";

// Filtres du dashboard Opérationnel, transmis par le frontend au moment du clic sur "Exporter" :
// l'export doit refléter exactement la vue affichée (même collaborateur, sociétés, année, mois).

export const MOIS = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export interface OperationnelExportFilters {
    annee: number;
    /** 1-12, ou null = "Tous les mois" (année complète janvier-décembre). */
    mois: number | null;
    /** Nom exact du collaborateur (comme dans le dashboard), ou null = tous. */
    collab: string | null;
    /** Noms de sociétés cochées ; vide = toutes les sociétés. */
    companies: string[];
}

export interface ScopeEmployee {
    id: number;
    name: string;
    company: string | null;
}

/** Périmètre résolu : les employés et la période à couvrir, pour les requêtes de chaque KPI. */
export interface EmployeeScope {
    employees: ScopeEmployee[];
    employeeIds: number[];
    /** Bornes incluses, format YYYY-MM-DD. */
    dateFrom: string;
    dateTo: string;
    /** Mois couverts (1-12). */
    months: number[];
}

/** Filtre invalide envoyé par le client → réponse 400 (voir le contrôleur d'export). */
export class ExportFilterError extends Error {}

function asList(value: unknown): string[] {
    if (value === undefined || value === null || value === "") return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw.map(v => String(v).trim()).filter(Boolean);
}

export function parseOperationnelFilters(query: Request["query"]): OperationnelExportFilters {
    const annee = parseInt(String(query.annee ?? ""), 10);
    if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) {
        throw new ExportFilterError("Paramètre 'annee' invalide");
    }

    let mois: number | null = null;
    const moisRaw = String(query.mois ?? "all");
    if (moisRaw !== "all") {
        mois = parseInt(moisRaw, 10);
        if (!Number.isInteger(mois) || mois < 1 || mois > 12) {
            throw new ExportFilterError("Paramètre 'mois' invalide (attendu : all ou 1-12)");
        }
    }

    const collabRaw = String(query.collab ?? "all").trim();
    const collab = collabRaw && collabRaw !== "all" ? collabRaw : null;

    return { annee, mois, collab, companies: asList(query.companies) };
}

/**
 * Même univers d'employés que le dashboard (employés présents dans kpi.operationnel_suivi_mensuel
 * pour l'année, société via staging.res_company), puis mêmes filtres société + collaborateur.
 */
export async function resolveEmployeeScope(f: OperationnelExportFilters): Promise<EmployeeScope> {
    const res = await pool.query(
        `SELECT DISTINCT emp.id, emp.name, rc.name AS company
         FROM kpi.operationnel_suivi_mensuel osm
         JOIN staging.hr_employee emp ON osm.employee_id = emp.id
         LEFT JOIN staging.res_company rc ON rc.id = emp.company_id
         WHERE osm.annee = $1
         ORDER BY emp.name`,
        [f.annee]
    );
    let employees: ScopeEmployee[] = res.rows.map(r => ({ id: r.id, name: r.name, company: r.company ?? null }));

    if (f.companies.length) {
        employees = employees.filter(e => e.company !== null && f.companies.includes(e.company));
    }
    if (f.collab) {
        employees = employees.filter(e => e.name === f.collab);
        if (!employees.length) {
            throw new ExportFilterError(`Collaborateur introuvable pour ce périmètre : ${f.collab}`);
        }
    }

    const months = f.mois ? [f.mois] : Array.from({ length: 12 }, (_, i) => i + 1);
    const first = months[0];
    const last = months[months.length - 1];
    const lastDay = new Date(f.annee, last, 0).getDate();
    const pad = (n: number) => String(n).padStart(2, "0");

    return {
        employees,
        employeeIds: employees.map(e => e.id),
        dateFrom: `${f.annee}-${pad(first)}-01`,
        dateTo: `${f.annee}-${pad(last)}-${pad(lastDay)}`,
        months,
    };
}

/** "2026-01-31" → "31.01.2026" (format des dates du classeur). */
const frDay = (iso: string) => iso.split("-").reverse().join(".");

/** Bloc "Filtres appliqués" de la feuille Informations. */
export function describeFilters(f: OperationnelExportFilters, scope: EmployeeScope): FiltreAffiche[] {
    const exportedAt = new Date().toLocaleString("fr-CH", { timeZone: "Europe/Zurich" });
    return [
        { label: "Collaborateur", value: f.collab ?? `Tous les collaborateurs (${scope.employees.length})` },
        { label: "Société(s)", value: f.companies.length ? f.companies.join(", ") : "Toutes les sociétés" },
        { label: "Année", value: String(f.annee) },
        { label: "Mois", value: f.mois ? MOIS[f.mois - 1] : "Tous les mois (janvier-décembre)" },
        { label: "Période couverte", value: `du ${frDay(scope.dateFrom)} au ${frDay(scope.dateTo)}` },
        { label: "Exporté le", value: exportedAt },
    ];
}

/** Partie du nom de fichier décrivant les filtres, ex. "2026_AGACHII-Igor_tous-mois". */
export function filtersSlug(f: OperationnelExportFilters): string {
    const slug = (s: string) =>
        s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const parts = [
        String(f.annee),
        f.collab ? slug(f.collab) : "tous-collaborateurs",
        f.mois ? slug(MOIS[f.mois - 1]) : "tous-mois",
    ];
    if (f.companies.length) parts.push(slug(f.companies.join("-")));
    return parts.join("_");
}
