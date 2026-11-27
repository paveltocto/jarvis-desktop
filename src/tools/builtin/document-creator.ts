import { buildDocument, type DocumentKind, EXTENSIONS } from "../../documents/build";
import type { SheetInput } from "../../documents/xlsx";
import { InvalidInput } from "../../data/records";
import { oneOf, optionalText, requiredText } from "../args";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

const KINDS: readonly DocumentKind[] = ["word", "excel", "powerpoint", "text"];
const MAX_SHEETS = 10;
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 50;

/** `Title 2026-01-01 1230.docx`, safe as a file name. */
export function documentFileName(title: string, kind: DocumentKind, now: Date): string {
  const safe =
    title
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .trim()
      .slice(0, 60)
      .trim() || "Document";
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `${safe} ${stamp}.${EXTENSIONS[kind]}`;
}

export function parseSheets(value: unknown): SheetInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidInput("sheets is required for excel.");
  }
  if (value.length > MAX_SHEETS) throw new InvalidInput(`At most ${MAX_SHEETS} sheets.`);
  return value.map((raw: unknown) => {
    const sheet = (raw ?? {}) as { name?: unknown; headers?: unknown; rows?: unknown };
    const rows = [
      ...(Array.isArray(sheet.headers) && sheet.headers.length > 0 ? [sheet.headers] : []),
      ...(Array.isArray(sheet.rows) ? (sheet.rows as unknown[]) : []),
    ];
    if (rows.length === 0) throw new InvalidInput("Every sheet needs headers or rows.");
    if (rows.length > MAX_ROWS) throw new InvalidInput(`At most ${MAX_ROWS} rows per sheet.`);
    return {
      name: typeof sheet.name === "string" ? sheet.name : "",
      rows: rows.map((row) => {
        if (!Array.isArray(row) || row.length > MAX_COLUMNS) {
          throw new InvalidInput(`Each row must be a list of at most ${MAX_COLUMNS} cells.`);
        }
        return row.map((cell: unknown) => (typeof cell === "number" ? cell : String(cell ?? "")));
      }),
    };
  });
}

/** Ported from legacy `document_creator`; adds PowerPoint. Google Docs is not supported. */
export const documentCreator: ToolDefinition = {
  name: "document_creator",
  description:
    "Creates a new document file on the Desktop, after the user allows it in a dialog. 'word' (.docx) and 'text' (.txt) use content; 'powerpoint' (.pptx) starts a slide at each '#' heading in content; 'excel' (.xlsx) uses sheets. Content may use '#' headings and '-' bullets. It cannot create Google Docs or Sheets.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: KINDS, description: "Kind of document." },
      title: { type: "string" },
      content: { type: "string", description: "Body text, for word, powerpoint and text." },
      sheets: {
        type: "array",
        description: "For excel.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            headers: { type: "array", items: { type: "string" } },
            rows: { type: "array", items: { type: "array", items: { type: "string" } } },
          },
        },
      },
    },
    required: ["action", "title"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const kind = oneOf(args.action, KINDS);
      const title = requiredText(args, "title", 200);
      const sheets = kind === "excel" ? parseSheets(args.sheets) : [];
      const content = kind === "excel" ? "" : optionalText(args, "content");
      if (kind !== "excel" && !content) throw new InvalidInput("content is required.");
      const dataBase64 = await buildDocument(kind, { title, content, sheets });
      return ok(
        await ctx.files.change({
          action: "create_document",
          fileName: documentFileName(title, kind, ctx.now()),
          dataBase64,
        }),
      );
    } catch (error) {
      return failureFrom(error);
    }
  },
};
