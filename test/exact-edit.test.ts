import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditToolInput, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { tryApplyExactEdits, tryExecuteExactEdit } from "../src/exact-edit.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("exact edit fast path", () => {
  it("applies disjoint edits against the original content", () => {
    expect(
      tryApplyExactEdits("first\nmiddle\nlast\n", {
        path: "fixture.txt",
        edits: [
          { oldText: "first", newText: "changed first" },
          { oldText: "last", newText: "changed last" },
        ],
      }),
    ).toBe("changed first\nmiddle\nchanged last\n");
  });

  it("delegates fuzzy and ambiguous inputs", () => {
    expect(
      tryApplyExactEdits("const value = ‘old’;\n", {
        path: "fixture.txt",
        edits: [{ oldText: "const value = 'old';", newText: "const value = 'new';" }],
      }),
    ).toBeUndefined();
    expect(
      tryApplyExactEdits("same same", {
        path: "fixture.txt",
        edits: [{ oldText: "same", newText: "changed" }],
      }),
    ).toBeUndefined();
  });

  it("preserves BOM and CRLF and returns built-in-compatible details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    await writeFile(join(directory, "fixture.txt"), "\uFEFFbefore\r\nafter\r\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "changed" }],
    };

    const result = await tryExecuteExactEdit(input, undefined, { cwd: directory } as ExtensionContext);

    expect(result).toBeDefined();
    expect(result?.details.diff).toContain("+1 changed");
    expect(result?.details.patch).toContain("--- fixture.txt");
    expect(result?.details.firstChangedLine).toBe(1);
    expect(await readFile(join(directory, "fixture.txt"), "utf8")).toBe("\uFEFFchanged\r\nafter\r\n");
  });
});
