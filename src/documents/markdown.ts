/** The small subset of Markdown the model uses to describe a document. */

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "bullet"; text: string }
  | { type: "paragraph"; text: string };

export function parseBlocks(content: string): Block[] {
  return content.split("\n").flatMap((raw): Block[] => {
    const line = raw.trim();
    if (!line) return [];
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      return [
        {
          type: "heading",
          level: (heading[1] ?? "#").length as 1 | 2 | 3,
          text: heading[2] ?? "",
        },
      ];
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) return [{ type: "bullet", text: bullet[1] ?? "" }];
    return [{ type: "paragraph", text: line }];
  });
}

export interface Slide {
  title: string;
  lines: { text: string; bullet: boolean }[];
}

/** Each heading starts a slide. Long slides continue on a new one. */
export function toSlides(content: string, maxLines = 8): Slide[] {
  const slides: Slide[] = [];
  let current: Slide | null = null;
  for (const block of parseBlocks(content)) {
    if (block.type === "heading") {
      current = { title: block.text, lines: [] };
      slides.push(current);
      continue;
    }
    if (!current || current.lines.length >= maxLines) {
      current = { title: current?.title ?? "", lines: [] };
      slides.push(current);
    }
    current.lines.push({ text: block.text, bullet: block.type === "bullet" });
  }
  return slides;
}
