import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditToolInput, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  tryApplyExactEdits,
  tryExecuteExactEdit,
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

  it("uses raw byte positions when invalid UTF-8 precedes a replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-accelerator-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, Buffer.from([0xc0, ...Buffer.from("before\n")]));
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const prepared = await tryPrepareExactEdit(input, directory);

    expect(prepared?.positionalWrites?.[0]?.position).toBe(1);
    await tryExecuteExactEdit(input, undefined, { cwd: directory } as ExtensionContext, prepared);
    expect(await readFile(path)).toEqual(Buffer.from([0xc0, ...Buffer.from("after!\n")]));
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
