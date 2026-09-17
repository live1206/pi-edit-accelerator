import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildSparseDiffs, type SparseReplacement } from "../src/sparse-diff.ts";

interface TextReplacement {
  oldText: string;
  newText: string;
}

function plan(oldContent: string, edits: readonly TextReplacement[]): { newContent: string; replacements: SparseReplacement[] } {
  const matches = edits.map((edit) => {
    const matchIndex = oldContent.indexOf(edit.oldText);
    if (matchIndex === -1) throw new Error(`Missing fixture text: ${edit.oldText}`);
    const prefix = oldContent.slice(0, matchIndex);
    return {
      matchIndex,
      matchLength: edit.oldText.length,
      newText: edit.newText,
      firstLine: prefix.split("\n").length - 1,
      lastLine: oldContent.slice(0, matchIndex + edit.oldText.length - 1).split("\n").length - 1,
    };
  });
  let newContent = oldContent;
  for (const replacement of [...matches].sort((a, b) => b.matchIndex - a.matchIndex)) {
    newContent =
      newContent.slice(0, replacement.matchIndex) +
      replacement.newText +
      newContent.slice(replacement.matchIndex + replacement.matchLength);
  }
  return { newContent, replacements: matches };
}

function compare(oldContent: string, edits: readonly TextReplacement[], path = "fixture.txt"): void {
  const { newContent, replacements } = plan(oldContent, edits);
  const sparse = buildSparseDiffs(path, oldContent, newContent, replacements);
  const builtIn = generateDiffString(oldContent, newContent);
  expect(sparse.diff).toBe(builtIn.diff);
  expect(sparse.firstChangedLine).toBe(builtIn.firstChangedLine);
  expect(sparse.patch).toBe(generateUnifiedPatch(path, oldContent, newContent));
}

describe("sparse diff", () => {
  it("matches distant hunks", () => {
    const content = `${Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    compare(content, [
      { oldText: "line 1", newText: "changed 1" },
      { oldText: "line 100", newText: "changed 100" },
    ]);
  });

  it("merges nearby changes using built-in context rules", () => {
    const content = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    compare(content, [
      { oldText: "line 6", newText: "changed 6" },
      { oldText: "line 13", newText: "changed 13" },
    ]);
  });

  it("matches files without a trailing newline", () => {
    compare("first\nmiddle\nlast", [{ oldText: "last", newText: "changed" }]);
  });

  it("matches empty and multibyte replacement lines", () => {
    compare("日本語\nmiddle\nlast\n", [
      { oldText: "日本語", newText: "🙂" },
      { oldText: "middle", newText: "" },
    ]);
  });

  it("matches partial-line edits", () => {
    compare("const value = before;\nnext\n", [{ oldText: "before", newText: "after" }]);
  });

  it("matches multiline replacement with line insertion", () => {
    compare("first\nold one\nold two\nlast\n", [
      { oldText: "old one\nold two", newText: "new one\nnew two\nnew three" },
    ]);
  });

  it("matches multiline replacement with line deletion", () => {
    compare("first\nold one\nold two\nold three\nlast\n", [
      { oldText: "old one\nold two\nold three", newText: "new" },
    ]);
  });

  it("adjusts later hunk coordinates after inserted lines", () => {
    const content = `${Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    compare(content, [
      { oldText: "line 2", newText: "line 2a\nline 2b" },
      { oldText: "line 29", newText: "changed 29" },
    ]);
  });

  it("matches multiple partial edits on one line", () => {
    compare("alpha before middle after omega\n", [
      { oldText: "before", newText: "BEFORE" },
      { oldText: "after", newText: "AFTER" },
    ]);
  });
});
