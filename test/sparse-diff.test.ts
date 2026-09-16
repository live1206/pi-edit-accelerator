import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildSparseLineDiffs, type LineReplacement } from "../src/sparse-diff.ts";

function compare(oldContent: string, replacements: LineReplacement[], path = "fixture.txt"): void {
  const lines = oldContent.split("\n");
  for (const replacement of replacements) lines[replacement.lineIndex] = replacement.newText;
  const newContent = lines.join("\n");
  const sparse = buildSparseLineDiffs(path, oldContent, newContent, replacements);
  const builtIn = generateDiffString(oldContent, newContent);
  expect(sparse.diff).toBe(builtIn.diff);
  expect(sparse.firstChangedLine).toBe(builtIn.firstChangedLine);
  expect(sparse.patch).toBe(generateUnifiedPatch(path, oldContent, newContent));
}

describe("sparse line diff", () => {
  it("matches distant hunks", () => {
    const content = `${Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    compare(content, [
      { lineIndex: 0, oldText: "line 1", newText: "changed 1" },
      { lineIndex: 99, oldText: "line 100", newText: "changed 100" },
    ]);
  });

  it("merges nearby changes using built-in context rules", () => {
    const content = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    compare(content, [
      { lineIndex: 5, oldText: "line 6", newText: "changed 6" },
      { lineIndex: 12, oldText: "line 13", newText: "changed 13" },
    ]);
  });

  it("matches files without a trailing newline", () => {
    compare("first\nmiddle\nlast", [
      { lineIndex: 2, oldText: "last", newText: "changed" },
    ]);
  });

  it("matches empty and multibyte replacement lines", () => {
    compare("日本語\nmiddle\nlast\n", [
      { lineIndex: 0, oldText: "日本語", newText: "🙂" },
      { lineIndex: 1, oldText: "middle", newText: "" },
    ]);
  });
});
