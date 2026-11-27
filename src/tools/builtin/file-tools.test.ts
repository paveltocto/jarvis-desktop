/* eslint-disable @typescript-eslint/no-non-null-assertion -- a missing value should fail the test */
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { buildDocument } from "../../documents/build";
import { toSlides } from "../../documents/markdown";
import { buildXlsx, columnName, sheetNames } from "../../documents/xlsx";
import { testContext } from "../testing/context";
import { documentCreator, parseSheets } from "./document-creator";
import { fileController } from "./file-controller";
import { smartFileOrganizer } from "./smart-file-organizer";

function files() {
  return {
    query: vi.fn().mockResolvedValue("listing"),
    change: vi.fn().mockResolvedValue("done"),
  };
}

const unzipBase64 = (data: string) =>
  unzipSync(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));

describe("file_controller", () => {
  it("sends reads and changes to different backend calls", async () => {
    const api = files();
    const ctx = testContext({ files: api });
    await fileController.execute({ action: "list", path: "desktop" }, ctx);
    await fileController.execute({ action: "write", path: "desktop/a", content: "" }, ctx);
    expect(api.query).toHaveBeenCalledWith({ action: "list", path: "desktop" });
    expect(api.change).toHaveBeenCalledWith({
      action: "write",
      path: "desktop/a",
      content: "",
      overwrite: false,
    });
  });

  it("passes on a refusal from the user as a failure", async () => {
    const api = files();
    api.change.mockRejectedValue("the user declined the change");
    const result = await fileController.execute(
      { action: "delete", path: "desktop/a" },
      testContext({ files: api }),
    );
    expect(result).toEqual({ ok: false, code: "failed", error: "the user declined the change" });
  });
});

describe("smart_file_organizer", () => {
  it("looks in downloads by default", async () => {
    const api = files();
    await smartFileOrganizer.execute({ action: "find_duplicates" }, testContext({ files: api }));
    expect(api.query).toHaveBeenCalledWith({ action: "duplicates", path: "downloads" });
  });
});

describe("documents", () => {
  const input = { title: "Plan <1>", content: "# One\n- first\ntext", sheets: [] };

  it("builds a Word file with the content", async () => {
    const parts = unzipBase64(await buildDocument("word", input));
    const xml = strFromU8(parts["word/document.xml"]!);
    expect(xml).toContain("Plan &lt;1&gt;");
    expect(xml).toContain("first");
  });

  it("builds a PowerPoint file with a title slide and one per heading", async () => {
    const parts = unzipBase64(
      await buildDocument("powerpoint", { ...input, content: "# One\n- a\n# Two\n- b" }),
    );
    const slides = Object.keys(parts).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));
    expect(slides).toHaveLength(3);
  });

  it("keeps formulas and leading zeros as text in spreadsheets", () => {
    const parts = unzipSync(buildXlsx([{ name: "A", rows: [["=1+1", "007", "-2.5", 3]] }]));
    const xml = strFromU8(parts["xl/worksheets/sheet1.xml"]!);
    expect(xml).not.toContain("<f>");
    expect(xml).toContain(">=1+1</t>");
    expect(xml).toContain(">007</t>");
    expect(xml).toContain('<c r="C1"><v>-2.5</v></c>');
    expect(xml).toContain('<c r="D1"><v>3</v></c>');
  });

  it("names columns and sheets the way Excel accepts", () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    expect(sheetNames(["a/b", "A B", ""])).toEqual(["a b", "A B 2", "Sheet3"]);
  });

  it("continues long slides on a new one", () => {
    const slides = toSlides("# T\n" + "line\n".repeat(10), 8);
    expect(slides.map((slide) => slide.lines.length)).toEqual([8, 2]);
  });

  it("asks the backend to save a new file with a safe name", async () => {
    const api = files();
    await documentCreator.execute(
      { action: "text", title: "../Notes: 1", content: "hi" },
      testContext({ files: api }),
    );
    const change = api.change.mock.calls[0]?.[0];
    expect(change).toMatchObject({ action: "create_document" });
    expect(change.fileName).toMatch(/^Notes 1 [\d -]+\.txt$/);
  });

  it("requires sheets for a spreadsheet", () => {
    expect(() => parseSheets([])).toThrow();
    expect(parseSheets([{ headers: ["a"], rows: [["b"]] }])[0]?.rows).toEqual([["a"], ["b"]]);
  });
});
