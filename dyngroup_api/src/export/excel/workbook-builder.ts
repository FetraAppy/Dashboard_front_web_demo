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

// --- Style (inspiré du Google Sheet "documentation dashboard operationnel") ----------------------
// Hiérarchie visuelle : titre du classeur > bandeau de section > en-tête de tableau > libellé > valeur.

const FONT_NAME = "Arial";
const COLORS = {
    primary: "FF1F4E79",   // bandeaux de section, en-têtes des feuilles de données, titre
    header: "FFD9E1F2",    // en-têtes de tableau de la feuille Informations
    label: "FFF2F2F2",     // libellés (colonne A), étapes racines de l'arbre
    total: "FFDDEBF7",     // ligne Total des feuilles de données
    border: "FFBFBFBF",
    subtitle: "FF595959",
    white: "FFFFFFFF",
};

const font = (extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT_NAME, size: 10, ...extra });
const solid = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const THIN: Partial<ExcelJS.Border> = { style: "thin", color: { argb: COLORS.border } };
const BOX: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };

// Feuille Informations : 6 colonnes (= le tableau "Colonnes" : Colonne | Description | Métier |
// Formule | Source Odoo | Commentaires). Les valeurs longues sont fusionnées sur B:F (lignes
// "libellé : valeur") ou C:F (détail de l'arbre), pour tenir sur une ou deux lignes.
const INFO_WIDTHS = [28, 38, 30, 44, 28, 34];
const INFO_COLS = INFO_WIDTHS.length;
const LINE_HEIGHT = 13;

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

/**
 * Excel n'ajuste pas la hauteur d'une ligne dont le texte est dans une cellule fusionnée : on
 * l'estime d'après la longueur du texte et la largeur (en caractères) de la zone fusionnée.
 */
function estimatedHeight(text: string, widthChars: number): number {
    const lines = text.split("\n").reduce((n, p) => n + Math.max(1, Math.ceil(p.length / widthChars)), 0);
    return Math.max(16, lines * LINE_HEIGHT + 4);
}

const sumWidths = (from: number, to: number) => INFO_WIDTHS.slice(from - 1, to).reduce((s, w) => s + w, 0);

/** Applique un style à toutes les cellules d'une ligne, de la colonne `from` à `to` (1-based). */
function styleCells(row: ExcelJS.Row, from: number, to: number, style: (cell: ExcelJS.Cell) => void) {
    for (let c = from; c <= to; c++) style(row.getCell(c));
}

/** Titre du classeur (A1) + sous-titre : nom du KPI et onglet du dashboard. */
function addSheetTitle(ws: ExcelJS.Worksheet, title: string, subtitle: string) {
    const titleCell = ws.getCell(1, 1);
    titleCell.value = title;
    titleCell.font = font({ size: 16, bold: true, color: { argb: COLORS.primary } });
    ws.getRow(1).height = 26;

    const subCell = ws.getCell(2, 1);
    subCell.value = subtitle;
    subCell.font = font({ size: 11, italic: true, color: { argb: COLORS.subtitle } });
}

/** Bandeau de section (ex. "Filtres appliqués") : fond foncé, texte blanc, sur toute la largeur. */
function addSectionTitle(ws: ExcelJS.Worksheet, rowNumber: number, title: string) {
    const row = ws.getRow(rowNumber);
    row.getCell(1).value = title;
    ws.mergeCells(rowNumber, 1, rowNumber, INFO_COLS);
    styleCells(row, 1, INFO_COLS, cell => {
        cell.fill = solid(COLORS.primary);
        cell.font = font({ size: 11, bold: true, color: { argb: COLORS.white } });
        cell.alignment = { vertical: "middle" };
    });
    row.height = 20;
}

/** En-tête de tableau : gras, centré, fond clair, encadré. `spans` = nb de colonnes par en-tête. */
function addHeaderRow(ws: ExcelJS.Worksheet, rowNumber: number, headers: string[], spans: number[] = []) {
    const row = ws.getRow(rowNumber);
    let col = 1;
    headers.forEach((h, i) => {
        const span = spans[i] ?? 1;
        row.getCell(col).value = h;
        if (span > 1) ws.mergeCells(rowNumber, col, rowNumber, col + span - 1);
        col += span;
    });
    styleCells(row, 1, col - 1, cell => {
        cell.fill = solid(COLORS.header);
        cell.font = font({ bold: true, color: { argb: COLORS.primary } });
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.border = BOX;
    });
    row.height = 18;
}

/** Ligne "libellé : valeur" : libellé en gras sur fond gris (A), valeur fusionnée sur B:F. */
function addInfoLine(ws: ExcelJS.Worksheet, rowNumber: number, label: string, value: string) {
    const row = ws.getRow(rowNumber);
    const labelCell = row.getCell(1);
    labelCell.value = label;
    labelCell.font = font({ bold: true });
    labelCell.fill = solid(COLORS.label);
    labelCell.alignment = { vertical: "top", wrapText: true };
    labelCell.border = BOX;

    row.getCell(2).value = value;
    ws.mergeCells(rowNumber, 2, rowNumber, INFO_COLS);
    styleCells(row, 2, INFO_COLS, cell => {
        cell.font = font();
        cell.alignment = { vertical: "top", wrapText: true };
        cell.border = BOX;
    });
    row.height = estimatedHeight(value, sumWidths(2, INFO_COLS));
}

/** Arbre du chemin de calcul : 1 ligne par étape, indentée et regroupée selon sa profondeur. */
function addDerivationTree(ws: ExcelJS.Worksheet, startRow: number, nodes: DerivationNode[]): number {
    let rowNumber = startRow;
    const visit = (node: DerivationNode, depth: number) => {
        const row = ws.getRow(rowNumber);
        const isRoot = depth === 0;

        const labelCell = row.getCell(1);
        labelCell.value = isRoot ? node.label : `└ ${node.label}`;
        labelCell.alignment = { indent: Math.min(depth * 2, 15), vertical: "top", wrapText: true };

        const valueCell = row.getCell(2);
        valueCell.value = node.formula
            ? toCellValue({ formula: node.formula, result: node.value })
            : (node.value ?? null);
        valueCell.alignment = { horizontal: "right", vertical: "top" };
        if (node.numFmt) valueCell.numFmt = node.numFmt;

        row.getCell(3).value = node.detail ?? null;
        ws.mergeCells(rowNumber, 3, rowNumber, INFO_COLS);
        row.getCell(3).alignment = { vertical: "top", wrapText: true };

        styleCells(row, 1, INFO_COLS, cell => {
            cell.font = font({ bold: isRoot });
            cell.border = BOX;
            if (isRoot) cell.fill = solid(COLORS.label);
        });
        if (node.detail) row.height = estimatedHeight(node.detail, sumWidths(3, INFO_COLS));
        row.outlineLevel = Math.min(depth, MAX_OUTLINE_LEVEL);
        rowNumber++;
        (node.children || []).forEach(child => visit(child, depth + 1));
    };
    nodes.forEach(node => visit(node, 0));
    return rowNumber;
}

function addInfoSheet(wb: ExcelJS.Workbook, exp: KpiExport, filtres: FiltreAffiche[]) {
    const ws = wb.addWorksheet(INFO_SHEET_NAME, {
        properties: { tabColor: { argb: COLORS.primary } },
        views: [{ showGridLines: false }],
    });
    INFO_WIDTHS.forEach((w, i) => {
        ws.getColumn(i + 1).width = w;
        ws.getColumn(i + 1).font = font();
    });
    // Parent au-dessus de ses enfants (lecture en arbre), pas en dessous comme par défaut.
    ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };

    const d = exp.definition;
    addSheetTitle(ws, "Informations", `${d.titre} — onglet ${d.onglet}`);

    let r = 4;
    addSectionTitle(ws, r++, "Filtres appliqués");
    filtres.forEach(f => addInfoLine(ws, r++, f.label, f.value));

    r++;
    addSectionTitle(ws, r++, "Indicateur");
    if (d.description) addInfoLine(ws, r++, "Description", d.description);
    if (d.metier) addInfoLine(ws, r++, "Métier", d.metier);
    if (d.formule) addInfoLine(ws, r++, "Formule", d.formule);
    if (d.cible) addInfoLine(ws, r++, "Cible", d.cible);
    if (d.sourceOdoo) addInfoLine(ws, r++, "Source Odoo", d.sourceOdoo);
    addInfoLine(ws, r++, "Tables BDD", d.tables.join(", "));

    if (d.colonnes?.length) {
        r++;
        addSectionTitle(ws, r++, "Colonnes");
        addHeaderRow(ws, r++, ["Colonne", "Description", "Métier", "Formule", "Source Odoo", "Commentaires"]);
        d.colonnes.forEach(c => {
            const row = ws.getRow(r++);
            [c.nom, c.description, c.metier, c.formule, c.source, c.commentaire ?? ""].forEach((v, i) => {
                const cell = row.getCell(i + 1);
                cell.value = v;
                cell.font = font({ bold: i === 0 });
                cell.alignment = { vertical: "top", wrapText: true };
                cell.border = BOX;
                if (i === 0) cell.fill = solid(COLORS.label);
            });
        });
    }

    r++;
    addSectionTitle(ws, r++, "Données");
    addHeaderRow(ws, r++, ["Étape", "Valeur", "Détail"], [1, 1, INFO_COLS - 2]);
    addDerivationTree(ws, r, exp.derivation);
}

function addDataSheet(wb: ExcelJS.Workbook, sheet: DataSheet) {
    const ws = wb.addWorksheet(sanitizeSheetName(sheet.name));
    ws.columns = sheet.columns.map(c => ({
        header: c.header,
        key: c.key,
        width: c.width ?? Math.max(c.header.length + 4, 12),
        style: { font: font(), ...(c.numFmt ? { numFmt: c.numFmt } : {}) },
    }));
    sheet.rows.forEach(row => {
        const values: Record<string, ExcelJS.CellValue> = {};
        sheet.columns.forEach(c => { values[c.key] = toCellValue(row[c.key]); });
        ws.addRow(values);
    });

    const header = ws.getRow(1);
    styleCells(header, 1, sheet.columns.length, cell => {
        cell.fill = solid(COLORS.primary);
        cell.font = font({ bold: true, color: { argb: COLORS.white } });
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.border = BOX;
    });
    header.height = 30;
    if (sheet.description) header.getCell(1).note = sheet.description;

    if (sheet.lastRowIsTotal && sheet.rows.length) {
        const total = ws.getRow(sheet.rows.length + 1);
        styleCells(total, 1, sheet.columns.length, cell => {
            cell.fill = solid(COLORS.total);
            cell.font = font({ bold: true });
            cell.border = { ...BOX, top: { style: "medium", color: { argb: COLORS.primary } } };
        });
    }

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
