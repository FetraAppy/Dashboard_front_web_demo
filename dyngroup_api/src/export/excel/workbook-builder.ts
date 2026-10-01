import ExcelJS from "exceljs";
import { Response } from "express";
import { DataSheet, DataValue, DerivationNode, FiltreAffiche, KpiExport } from "./kpi-export.types";

const INFO_SHEET_NAME = "Informations";

// Taille maximale d'un export, réglable par la variable d'environnement EXPORT_MAX_MB (10 Mo par
// défaut). Sur Vercel (démo), la plateforme refuse de toute façon les réponses de plus de 4.5 Mo,
// quelle que soit cette valeur.
const MAX_EXPORT_BYTES = (parseFloat(process.env.EXPORT_MAX_MB || "") || 10) * 1024 * 1024;

// Excel limite l'imbrication des groupes de lignes à 7 niveaux.
const MAX_OUTLINE_LEVEL = 7;

const BOLD = { bold: true };

/** Nom d'onglet valide pour Excel : sans []:*?/\ et 31 caractères max. */
export function sanitizeSheetName(name: string): string {
    const cleaned = name.replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim();
    return (cleaned || "Données").slice(0, 31);
}

/** Lettre(s) de colonne Excel à partir d'un index 1-based (1 → A, 27 → AA). */
export function columnLetter(index: number): string {
    let letters = "";
    let n = index;
    while (n > 0) {
        const rem = (n - 1) % 26;
        letters = String.fromCharCode(65 + rem) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return letters;
}

function columnLetterOf(sheet: DataSheet, key: string): string {
    const index = sheet.columns.findIndex(c => c.key === key);
    if (index === -1) {
        throw new Error(`Colonne "${key}" absente de la feuille "${sheet.name}"`);
    }
    return columnLetter(index + 1);
}

function quotedSheetName(sheet: DataSheet): string {
    return `'${sanitizeSheetName(sheet.name).replace(/'/g, "''")}'`;
}

/**
 * Référence absolue vers toutes les données d'une colonne d'une feuille de données, pour une
 * formule — ex. `SUM(${columnRange(timesheets, 'heures')})`. Les données commencent ligne 2
 * (ligne 1 = en-têtes).
 */
export function columnRange(sheet: DataSheet, key: string): string {
    const letter = columnLetterOf(sheet, key);
    const lastRow = Math.max(2, sheet.rows.length + 1);
    return `${quotedSheetName(sheet)}!$${letter}$2:$${letter}$${lastRow}`;
}

/**
 * Référence vers une cellule d'une feuille de données : `rowIndex` = index dans `sheet.rows`
 * (0 = 1re ligne de données). `external` = préfixée du nom de la feuille, pour une formule écrite
 * dans une AUTRE feuille ; sinon référence locale, pour une formule de la même feuille.
 */
export function cellRef(sheet: DataSheet, key: string, rowIndex: number, external = false): string {
    const ref = `${columnLetterOf(sheet, key)}${rowIndex + 2}`;
    return external ? `${quotedSheetName(sheet)}!${ref}` : ref;
}

function toCellValue(value: DataValue): ExcelJS.CellValue {
    if (value && typeof value === "object" && !(value instanceof Date) && "formula" in value) {
        return { formula: value.formula, result: value.result } as ExcelJS.CellFormulaValue;
    }
    return (value ?? null) as ExcelJS.CellValue;
}

/** Ligne "libellé : valeur" (libellé en gras en colonne A, valeur en colonne B). */
function addInfoLine(ws: ExcelJS.Worksheet, rowNumber: number, label: string, value: string) {
    const row = ws.getRow(rowNumber);
    row.getCell(1).value = label;
    row.getCell(1).font = BOLD;
    row.getCell(1).alignment = { vertical: "top" };
    row.getCell(2).value = value;
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
}

function addTitle(ws: ExcelJS.Worksheet, rowNumber: number, title: string) {
    const cell = ws.getCell(rowNumber, 1);
    cell.value = title;
    cell.font = BOLD;
}

function addHeaderRow(ws: ExcelJS.Worksheet, rowNumber: number, headers: string[]) {
    const row = ws.getRow(rowNumber);
    headers.forEach((h, i) => {
        row.getCell(i + 1).value = h;
        row.getCell(i + 1).font = BOLD;
    });
}

/** Arbre du chemin de calcul : 1 ligne par étape, indentée et regroupée selon sa profondeur. */
function addDerivationTree(ws: ExcelJS.Worksheet, startRow: number, nodes: DerivationNode[]): number {
    let rowNumber = startRow;
    const visit = (node: DerivationNode, depth: number) => {
        const row = ws.getRow(rowNumber);
        const labelCell = row.getCell(1);
        labelCell.value = depth === 0 ? node.label : `└ ${node.label}`;
        labelCell.alignment = { indent: Math.min(depth * 2, 15), vertical: "top" };
        if (depth === 0) labelCell.font = BOLD;

        const valueCell = row.getCell(2);
        valueCell.value = node.formula
            ? toCellValue({ formula: node.formula, result: node.value })
            : (node.value ?? null);
        valueCell.alignment = { horizontal: "left", vertical: "top" };
        if (node.numFmt) valueCell.numFmt = node.numFmt;
        if (depth === 0) valueCell.font = BOLD;

        if (node.detail) {
            row.getCell(3).value = node.detail;
            row.getCell(3).alignment = { wrapText: true, vertical: "top" };
        }
        row.outlineLevel = Math.min(depth, MAX_OUTLINE_LEVEL);
        rowNumber++;
        (node.children || []).forEach(child => visit(child, depth + 1));
    };
    nodes.forEach(node => visit(node, 0));
    return rowNumber;
}

function addInfoSheet(wb: ExcelJS.Workbook, exp: KpiExport, filtres: FiltreAffiche[]) {
    const ws = wb.addWorksheet(INFO_SHEET_NAME);
    [32, 45, 45, 55, 30, 45].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    // Parent au-dessus de ses enfants (lecture en arbre), pas en dessous comme par défaut.
    ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };

    const d = exp.definition;
    addTitle(ws, 1, "Informations");

    let r = 3;
    addTitle(ws, r++, "Filtres appliqués");
    filtres.forEach(f => addInfoLine(ws, r++, f.label, f.value));

    r++;
    addTitle(ws, r++, "Indicateur");
    addInfoLine(ws, r++, "Titre", d.titre);
    addInfoLine(ws, r++, "Onglet du dashboard", d.onglet);
    if (d.description) addInfoLine(ws, r++, "Description", d.description);
    if (d.metier) addInfoLine(ws, r++, "Métier", d.metier);
    if (d.formule) addInfoLine(ws, r++, "Formule", d.formule);
    if (d.cible) addInfoLine(ws, r++, "Cible", d.cible);
    if (d.sourceOdoo) addInfoLine(ws, r++, "Source Odoo", d.sourceOdoo);
    addInfoLine(ws, r++, "Tables BDD", d.tables.join(", "));
    if (d.commentaires?.length) addInfoLine(ws, r++, "Commentaires", d.commentaires.join("\n"));
    if (exp.sheets.length) {
        const liste = exp.sheets
            .map(s => `${sanitizeSheetName(s.name)}${s.description ? ` : ${s.description}` : ""}`)
            .join("\n");
        addInfoLine(ws, r++, "Feuilles de données", liste);
    }

    if (d.colonnes?.length) {
        r++;
        addTitle(ws, r++, "Colonnes");
        addHeaderRow(ws, r++, ["Colonne", "Description", "Métier", "Formule", "Source Odoo", "Commentaires"]);
        d.colonnes.forEach(c => {
            const row = ws.getRow(r++);
            [c.nom, c.description, c.metier, c.formule, c.source, c.commentaire ?? ""].forEach((v, i) => {
                row.getCell(i + 1).value = v;
                row.getCell(i + 1).alignment = { wrapText: true, vertical: "top" };
            });
            row.getCell(1).font = BOLD;
        });
    }

    r++;
    addTitle(ws, r++, "Données");
    addHeaderRow(ws, r++, ["Étape", "Valeur", "Détail"]);
    addDerivationTree(ws, r, exp.derivation);
}

function addDataSheet(wb: ExcelJS.Workbook, sheet: DataSheet) {
    const ws = wb.addWorksheet(sanitizeSheetName(sheet.name));
    ws.columns = sheet.columns.map(c => ({
        header: c.header,
        key: c.key,
        width: c.width ?? Math.max(c.header.length + 4, 12),
        style: c.numFmt ? { numFmt: c.numFmt } : {},
    }));
    sheet.rows.forEach(row => {
        const values: Record<string, ExcelJS.CellValue> = {};
        sheet.columns.forEach(c => { values[c.key] = toCellValue(row[c.key]); });
        ws.addRow(values);
    });
    ws.getRow(1).font = BOLD;
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (sheet.columns.length) {
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
    }
}

/** Classeur standard d'un export KPI : feuille "Informations" puis une feuille par jeu de données. */
export function buildKpiWorkbook(exp: KpiExport, filtres: FiltreAffiche[]): ExcelJS.Workbook {
    const names = exp.sheets.map(s => sanitizeSheetName(s.name));
    const duplicate = names.find((n, i) => names.indexOf(n) !== i || n === INFO_SHEET_NAME);
    if (duplicate) {
        throw new Error(`Nom de feuille en double ou réservé : "${duplicate}"`);
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = "DYN Group — Dashboard";
    wb.created = new Date();
    // Recalcule les formules à l'ouverture, pour que les valeurs affichées reflètent toujours
    // les feuilles de données (même si quelqu'un les modifie ensuite).
    wb.calcProperties.fullCalcOnLoad = true;

    addInfoSheet(wb, exp, filtres);
    exp.sheets.forEach(sheet => addDataSheet(wb, sheet));
    return wb;
}

/** Envoie le classeur en téléchargement ; 413 explicite s'il dépasse la taille maximale. */
export async function sendWorkbook(res: Response, wb: ExcelJS.Workbook, filename: string) {
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    if (buffer.length > MAX_EXPORT_BYTES) {
        res.status(413).json({
            error: "Export trop volumineux — réduisez la période ou filtrez sur un collaborateur/une société.",
        });
        return;
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    // Sans ça, le frontend (autre domaine) ne peut pas lire le nom de fichier à cause de CORS.
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
}
