/**
 * A minimal `.xlsx` writer: text and number cells in one or more sheets.
 * Zipping is synchronous because the CSP does not allow the blob workers that
 * spreadsheet libraries use.
 */
import { strToU8, zipSync } from "fflate";

export interface SheetInput {
  name: string;
  /** Header row first, if any. */
  rows: (string | number)[][];
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE = "http://schemas.openxmlformats.org/package/2006";
const CONTENT = "application/vnd.openxmlformats-officedocument.spreadsheetml";

/** Escapes text for XML and drops the control characters XML 1.0 forbids. */
export function escapeXml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

/** `0` → `A`, `26` → `AA`. */
export function columnName(index: number): string {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

/** Excel limits names to 31 characters, bans `[]:*?/\` and needs them unique. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, index) => {
    const base =
      raw
        .replace(/[[\]:*?/\\]/g, " ")
        .trim()
        .slice(0, 31) || `Sheet${index + 1}`;
    let name = base;
    for (let copy = 2; used.has(name.toLowerCase()); copy++) {
      name = `${base.slice(0, 31 - String(copy).length - 1)} ${copy}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** Plain decimals become numbers; codes with leading zeros stay text. */
const NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

function cell(value: string | number, reference: string): string {
  if (typeof value === "number" ? Number.isFinite(value) : NUMBER.test(value)) {
    return `<c r="${reference}"><v>${Number(value)}</v></c>`;
  }
  // Inline strings are never evaluated, so "=..." stays text.
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function worksheet(rows: SheetInput["rows"]): string {
  const body = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row.map((value, c) => cell(value, `${columnName(c)}${r + 1}`)).join("")}</row>`,
    )
    .join("");
  return `${XML}<worksheet xmlns="${MAIN}"><sheetData>${body}</sheetData></worksheet>`;
}

export function buildXlsx(sheets: SheetInput[]): Uint8Array {
  if (sheets.length === 0) throw new Error("A spreadsheet needs at least one sheet.");
  const names = sheetNames(sheets.map((sheet) => sheet.name));
  const files: Record<string, string> = {
    "[Content_Types].xml": `${XML}<Types xmlns="${PACKAGE}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CONTENT}.sheet.main+xml"/>${names
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CONTENT}.worksheet+xml"/>`,
      )
      .join("")}</Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${XML}<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><sheets>${names
      .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML}<Relationships xmlns="${PACKAGE}/relationships">${names
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("")}</Relationships>`,
  };
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = worksheet(sheet.rows);
  });
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
  );
}
