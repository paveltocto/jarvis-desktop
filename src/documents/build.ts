/** Builds document files. The libraries are loaded only when a document is made. */
import { parseBlocks, toSlides } from "./markdown";
import { buildXlsx, type SheetInput } from "./xlsx";

export type DocumentKind = "word" | "excel" | "powerpoint" | "text";

export const EXTENSIONS: Record<DocumentKind, string> = {
  word: "docx",
  excel: "xlsx",
  powerpoint: "pptx",
  text: "txt",
};

export interface DocumentContent {
  title: string;
  content: string;
  sheets: SheetInput[];
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

async function buildWord({ title, content }: DocumentContent): Promise<string> {
  const { Document, HeadingLevel, Packer, Paragraph } = await import("docx");
  const headings = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  } as const;
  const body = parseBlocks(content).map((block) => {
    switch (block.type) {
      case "heading":
        return new Paragraph({ text: block.text, heading: headings[block.level] });
      case "bullet":
        return new Paragraph({ text: block.text, bullet: { level: 0 } });
      case "paragraph":
        return new Paragraph({ text: block.text });
    }
  });
  const document = new Document({
    sections: [
      { children: [new Paragraph({ text: title, heading: HeadingLevel.TITLE }), ...body] },
    ],
  });
  return Packer.toBase64String(document);
}

async function buildPowerPoint({ title, content }: DocumentContent): Promise<string> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const deck = new PptxGenJS();
  deck.title = title;
  deck.layout = "LAYOUT_WIDE";
  deck.addSlide().addText(title, {
    x: 0.8,
    y: 2.5,
    w: 11.7,
    h: 2,
    fontSize: 40,
    bold: true,
    align: "center",
  });
  for (const slide of toSlides(content)) {
    const page = deck.addSlide();
    page.addText(slide.title || title, {
      x: 0.6,
      y: 0.4,
      w: 12.1,
      h: 1,
      fontSize: 28,
      bold: true,
    });
    if (slide.lines.length === 0) continue;
    page.addText(
      slide.lines.map((line) => ({
        text: line.text,
        options: { bullet: line.bullet, breakLine: true },
      })),
      { x: 0.6, y: 1.6, w: 12.1, h: 5.3, fontSize: 18, valign: "top", fit: "shrink" },
    );
  }
  return (await deck.write({ outputType: "base64" })) as string;
}

/** The file as base64. */
export async function buildDocument(kind: DocumentKind, input: DocumentContent): Promise<string> {
  switch (kind) {
    case "word":
      return buildWord(input);
    case "powerpoint":
      return buildPowerPoint(input);
    case "excel":
      return toBase64(buildXlsx(input.sheets));
    case "text":
      return toBase64(new TextEncoder().encode(`${input.title}\n\n${input.content}\n`));
  }
}
