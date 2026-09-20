import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditToolInput, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  getExactEditPathKey,
  tryApplyExactEdits,
  tryExecuteExactEdit,
  tryPrefetchExactEditFile,
  tryPrepareExactEdit,
} from "../src/exact-edit.ts";

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

  it("delegates when disjoint replacements cancel each other", () => {
    expect(
      tryApplyExactEdits("ab", {
        path: "fixture.txt",
        edits: [
          { oldText: "a", newText: "ab" },
          { oldText: "b", newText: "" },
        ],
      }),
    ).toBeUndefined();
  });

  it.each([
    "\u00A0",
    "\u2000",
    "\u2001",
    "\u2002",
    "\u2003",
    "\u2004",
    "\u2005",
    "\u2006",
    "\u2007",
    "\u2008",
    "\u2009",
    "\u200A",
    "\u202F",
    "\u205F",
    "\u3000",
  ])("delegates paths containing Pi-normalized Unicode space %#", (space) => {
    expect(getExactEditPathKey(`a${space}b.txt`, "/tmp")).toBeUndefined();
  });

  it("retains the Unicode normalization check for non-ASCII files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    await writeFile(join(directory, "fixture.txt"), "é before\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after" }],
    };

    const prepared = await tryPrepareExactEdit(input, directory);
    expect(prepared).toBeDefined();
  });

  it("does not bypass fuzzy safety for ASCII trailing whitespace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    await writeFile(join(directory, "fixture.txt"), "before  \nafter\t", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "changed" }],
    };

    expect(await tryPrepareExactEdit(input, directory)).toBeUndefined();
  });

  it("prepares from prefetched bytes and revalidates them before execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "before\nmiddle\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after" }],
    };
    const prefetched = await tryPrefetchExactEditFile(input.path, directory);
    expect(prefetched).toBeDefined();
    await writeFile(path, "before\nmiddle\nexternal change\n", "utf8");
    const prepared = await tryPrepareExactEdit(input, directory, prefetched);
    expect(prepared?.rawBytes).toBe(prefetched?.rawBytes);

    const result = await tryExecuteExactEdit(
      input,
      undefined,
      { cwd: directory } as ExtensionContext,
      prepared,
    );

    expect(result?.details).not.toBe(prepared?.result.details);
    expect(await readFile(path, "utf8")).toBe("after\nmiddle\nexternal change\n");
  });

  it("ignores prefetched bytes for a different path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    await writeFile(join(directory, "first.txt"), "first\n", "utf8");
    await writeFile(join(directory, "second.txt"), "second\n", "utf8");
    const prefetched = await tryPrefetchExactEditFile("first.txt", directory);
    const prepared = await tryPrepareExactEdit(
      { path: "second.txt", edits: [{ oldText: "second", newText: "changed" }] },
      directory,
      prefetched,
    );

    expect(prepared?.absolutePath).toBe(join(directory, "second.txt"));
    expect(prepared?.rawBytes.toString("utf8")).toBe("second\n");
  });

  it("reuses a matching preview plan during execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    await writeFile(join(directory, "fixture.txt"), "before\nmiddle\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);
    expect(prepared).toBeDefined();
    expect(prepared?.positionalWrites).toBeUndefined();

    const result = await tryExecuteExactEdit(
      input,
      undefined,
      { cwd: directory } as ExtensionContext,
      prepared,
    );

    expect(result?.details).toBe(prepared?.result.details);
    expect(await readFile(join(directory, "fixture.txt"), "utf8")).toBe("after\nmiddle\n");
  });

  it.each([
    { newText: "XYZ", expected: "XYZ� �\n" },
    { newText: "X", expected: "X� �\n" },
  ])("uses a full write when an edit splits a surrogate pair: $newText", async ({ newText, expected }) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "😀 �\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "\ud83d", newText }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);

    expect(prepared?.positionalWrites).toBeUndefined();
    expect(prepared?.suffixWrite).toBeUndefined();
    await tryExecuteExactEdit(input, undefined, { cwd: directory } as ExtensionContext, prepared);
    expect(await readFile(path, "utf8")).toBe(expected);
  });

  it("uses a full write for malformed replacement text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "before\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "\ud83d" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);

    expect(prepared?.positionalWrites).toBeUndefined();
    expect(prepared?.suffixWrite).toBeUndefined();
    await tryExecuteExactEdit(input, undefined, { cwd: directory } as ExtensionContext, prepared);
    expect(await readFile(path, "utf8")).toBe("�\n");
  });

  it("writes equal-byte-length replacements at their byte positions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "\uFEFFé before\nlast\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);
    expect(prepared?.positionalWrites).toHaveLength(1);
    expect(prepared?.positionalWrites?.[0]?.position).toBe(6);

    const result = await tryExecuteExactEdit(
      input,
      undefined,
      { cwd: directory } as ExtensionContext,
      prepared,
    );

    expect(result?.details).toBe(prepared?.result.details);
    expect(await readFile(path, "utf8")).toBe("\uFEFFé after!\nlast\n");
  });

  it("rewrites only the suffix for a length-changing edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "prefix\nbefore\nlast\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "changed value" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);

    expect(prepared?.suffixWrite?.position).toBe(7);
    await tryExecuteExactEdit(input, undefined, { cwd: directory } as ExtensionContext, prepared);
    expect(await readFile(path, "utf8")).toBe("prefix\nchanged value\nlast\n");
  });

  it("truncates the file after a shorter suffix rewrite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "prefix\nbefore and trailing content\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before and trailing content", newText: "after" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);

    expect(prepared?.suffixWrite?.position).toBe(7);
    await tryExecuteExactEdit(input, undefined, { cwd: directory } as ExtensionContext, prepared);
    expect(await readFile(path, "utf8")).toBe("prefix\nafter\n");
  });

  it("uses full-file writes when line-ending normalization changes offsets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "before\r\nlast\r\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);

    expect(prepared?.positionalWrites).toBeUndefined();
    expect(prepared?.suffixWrite).toBeUndefined();
    await tryExecuteExactEdit(input, undefined, { cwd: directory } as ExtensionContext, prepared);
    expect(await readFile(path, "utf8")).toBe("after!\r\nlast\r\n");
  });

  it("does not start positional writes when execution is already aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "before\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);
    const controller = new AbortController();
    controller.abort();

    await expect(
      tryExecuteExactEdit(input, controller.signal, { cwd: directory } as ExtensionContext, prepared),
    ).rejects.toThrow("Operation aborted");
    expect(await readFile(path, "utf8")).toBe("before\n");
  });

  it("invalidates a positional preview plan when the file changes before execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "before\nmiddle\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);
    expect(prepared?.positionalWrites).toHaveLength(1);
    await writeFile(path, "before\nmiddle\nexternal change\n", "utf8");

    const result = await tryExecuteExactEdit(
      input,
      undefined,
      { cwd: directory } as ExtensionContext,
      prepared,
    );

    expect(result?.details).not.toBe(prepared?.result.details);
    expect(await readFile(path, "utf8")).toBe("after!\nmiddle\nexternal change\n");
  });

  it("uses the built-in-compatible full write for invalid UTF-8", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, Buffer.from([0xc0, ...Buffer.from("before\n")]));
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);

    expect(prepared?.positionalWrites).toBeUndefined();
    expect(prepared?.suffixWrite).toBeUndefined();
    await tryExecuteExactEdit(input, undefined, { cwd: directory } as ExtensionContext, prepared);
    expect(await readFile(path)).toEqual(Buffer.from("�after!\n"));
  });

  it("invalidates a preview plan when different bytes decode to the same text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, Buffer.from([0xc0, ...Buffer.from("before\n")]));
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);
    expect(prepared).toBeDefined();
    await writeFile(path, Buffer.from([0xc1, ...Buffer.from("before\n")]));

    const result = await tryExecuteExactEdit(
      input,
      undefined,
      { cwd: directory } as ExtensionContext,
      prepared,
    );

    expect(result?.details).not.toBe(prepared?.result.details);
  });

  it("reports file size only after accelerated execution succeeds", async () => {
    for (const usePrepared of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
      tempDirectories.push(directory);
      const path = join(directory, "fixture.txt");
      await writeFile(path, "before\n", "utf8");
      const input: EditToolInput = {
        path: "fixture.txt",
        edits: [{ oldText: "before", newText: "after!" }],
      };
      const prepared = usePrepared ? await tryPrepareExactEdit(input, directory) : undefined;
      const sizes: number[] = [];

      const result = await tryExecuteExactEdit(
        input,
        undefined,
        { cwd: directory } as ExtensionContext,
        prepared,
        (bytes) => sizes.push(bytes),
      );

      expect(result).toBeDefined();
      expect(sizes).toEqual([7]);
    }

    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    await writeFile(join(directory, "fixture.txt"), "same\nsame\n", "utf8");
    const sizes: number[] = [];
    const result = await tryExecuteExactEdit(
      { path: "fixture.txt", edits: [{ oldText: "same", newText: "changed" }] },
      undefined,
      { cwd: directory } as ExtensionContext,
      undefined,
      (bytes) => sizes.push(bytes),
    );
    expect(result).toBeUndefined();
    expect(sizes).toEqual([]);
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
