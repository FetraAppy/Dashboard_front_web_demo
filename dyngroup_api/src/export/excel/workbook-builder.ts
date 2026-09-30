import ExcelJS from "exceljs";
import { Response } from "express";
import { DataSheet, DerivationNode, FiltreAffiche, KpiExport } from "./kpi-export.types";

const INFO_SHEET_NAME = "Informations";

// Limite de taille de réponse des fonctions serverless Vercel (4.5 MB), où tourne l'API en
// prod — au-delà, Vercel renvoie une erreur générique incompréhensible pour l'utilisateur.
const MAX_EXPORT_BYTES = 4.3 * 1024 * 1024;

// Excel limite l'imbrication des groupes de lignes à 7 niveaux.
const MAX_OUTLINE_LEVEL = 7;

const COLOR_SECTION_FILL = "FFE0E7FF";
const COLOR_HEADER_FILL = "FFF1F5F9";
const COLOR_BORDER = "FF94A3B8";

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

/**
 * Référence absolue vers les données d'une colonne d'une feuille de données, utilisable dans
 * une formule de DerivationNode — ex. `SUM(${columnRange(timesheets, 'heures')})`. Les données
 * commencent ligne 2 (ligne 1 = en-têtes), voir addDataSheet().
 */
export function columnRange(sheet: DataSheet, key: string): string {
    const index = sheet.columns.findIndex(c => c.key === key);
    if (index === -1) {
        throw new Error(`Colonne "${key}" absente de la feuille "${sheet.name}"`);
    }
    const letter = columnLetter(index + 1);
    const lastRow = Math.max(2, sheet.rows.length + 1);
    const quoted = sanitizeSheetName(sheet.name).replace(/'/g, "''");
    return `'${quoted}'!$${letter}$2:$${letter}$${lastRow}`;
}

function styleSectionTitle(cell: ExcelJS.Cell, size: number) {
    cell.font = { bold: true, size };
}

function addSectionHeader(ws: ExcelJS.Worksheet, rowNumber: number, title: string) {
    const row = ws.getRow(rowNumber);
    row.getCell(1).value = title;
    for (let col = 1; col <= 3; col++) {
        const cell = row.getCell(col);
        cell.font = { bold: true, size: 12 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_SECTION_FILL } };
    }
}

/** Ligne "libellé : valeur" de la section Informations — valeur fusionnée sur B:C. */
function addInfoLine(ws: ExcelJS.Worksheet, rowNumber: number, label: string, value: string) {
    const row = ws.getRow(rowNumber);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { vertical: "top" };
    row.getCell(2).value = value;
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    ws.mergeCells(rowNumber, 2, rowNumber, 3);
}

function nodeCellValue(node: DerivationNode): ExcelJS.CellValue {
    if (node.formula) {
        const result = typeof node.value === "number" || typeof node.value === "string" ? node.value : undefined;
        return { formula: node.formula, result } as ExcelJS.CellFormulaValue;
    }
    return node.value ?? null;
}

/** Arbre du chemin de calcul : 1 ligne par étape, indentée et regroupée selon sa profondeur. */
function addDerivationTree(ws: ExcelJS.Worksheet, startRow: number, nodes: DerivationNode[]): number {
    let rowNumber = startRow;
    const visit = (node: DerivationNode, depth: number) => {
        const row = ws.getRow(rowNumber);
        const labelCell = row.getCell(1);
        labelCell.value = depth === 0 ? node.label : `└ ${node.label}`;
        labelCell.alignment = { indent: depth * 2, vertical: "top" };
        if (depth === 0) labelCell.font = { bold: true };

        const valueCell = row.getCell(2);
        valueCell.value = nodeCellValue(node);
        valueCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
        if (node.numFmt) valueCell.numFmt = node.numFmt;
        if (depth === 0) valueCell.font = { bold: true };

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
    ws.getColumn(1).width = 42;
    ws.getColumn(2).width = 38;
    ws.getColumn(3).width = 70;
    // Parent au-dessus de ses enfants (lecture en arbre), pas en dessous comme par défaut.
    ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };

    const d = exp.definition;
    ws.getCell("A1").value = "Informations";
    styleSectionTitle(ws.getCell("A1"), 16);

    let r = 3;
    addSectionHeader(ws, r++, "Filtres appliqués");
    filtres.forEach(f => addInfoLine(ws, r++, f.label, f.value));

    r++;
    addSectionHeader(ws, r++, "Indicateur");
    addInfoLine(ws, r++, "Titre", d.titre);
    addInfoLine(ws, r++, "Onglet du dashboard", d.onglet);
    addInfoLine(ws, r++, "Description", d.description);
    addInfoLine(ws, r++, "Métier", d.metier);
    addInfoLine(ws, r++, "Formule", d.formule);
    if (d.cible) addInfoLine(ws, r++, "Cible", d.cible);
    addInfoLine(ws, r++, "Source Odoo", d.sourceOdoo);
    addInfoLine(ws, r++, "Tables BDD", d.tables.join(", "));
    if (d.commentaires?.length) addInfoLine(ws, r++, "Commentaires", d.commentaires.join("\n"));
    if (exp.sheets.length) {
        const liste = exp.sheets
            .map(s => `• ${sanitizeSheetName(s.name)}${s.description ? ` — ${s.description}` : ""}`)
            .join("\n");
        addInfoLine(ws, r++, "Feuilles de données", liste);
    }

    r++;
    ws.getCell(r, 1).value = "Données";
    styleSectionTitle(ws.getCell(r, 1), 16);
    r += 2;

    const header = ws.getRow(r++);
    ["Étape", "Valeur", "Détail"].forEach((title, i) => {
        const cell = header.getCell(i + 1);
        cell.value = title;
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_HEADER_FILL } };
        cell.border = { bottom: { style: "thin", color: { argb: COLOR_BORDER } } };
    });
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
    ws.addRows(sheet.rows);

    const header = ws.getRow(1);
    header.eachCell(cell => {
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_HEADER_FILL } };
        cell.border = { bottom: { style: "thin", color: { argb: COLOR_BORDER } } };
    });
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

/** Envoie le classeur en téléchargement ; 413 explicite si trop volumineux pour Vercel. */
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
