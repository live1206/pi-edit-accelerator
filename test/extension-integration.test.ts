import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditToolDefinition,
  initTheme,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it } from "vitest";
import editAccelerator from "../extensions/edit-accelerator.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-extension-integration-"));
  tempDirectories.push(directory);
  return directory;
}

function loadExtensionTool(): ReturnType<typeof createEditToolDefinition> {
  let registered: ReturnType<typeof createEditToolDefinition> | undefined;
  editAccelerator({
    registerTool(tool: unknown) {
      registered = tool as unknown as ReturnType<typeof createEditToolDefinition>;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  if (!registered) throw new Error("Extension did not register its edit tool");
  return registered;
}

async function execute(
  tool: ReturnType<typeof createEditToolDefinition>,
  directory: string,
  input: EditToolInput,
) {
  return tool.execute("tool-call", input, undefined, undefined, { cwd: directory } as ExtensionContext);
}

function renderPreview(
  tool: ReturnType<typeof createEditToolDefinition>,
  directory: string,
  input: EditToolInput,
  prefetch = false,
) {
  if (!tool.renderCall) throw new Error("Extension did not register a call renderer");
  type RenderCall = NonNullable<typeof tool.renderCall>;
  const identity = (text: string): string => text;
  const theme = new Proxy(
    { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: identity },
    { get: (target, property) => Reflect.get(target, property) ?? identity },
  ) as unknown as Parameters<RenderCall>[1];
  const state = {};
  let resolvePreview!: () => void;
  let rejectPreview!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolvePreview = resolve;
    rejectPreview = reject;
  });
  const timeout = setTimeout(() => rejectPreview(new Error("Preview timed out")), 2_000);
  const context = {
    state,
    lastComponent: undefined,
    argsComplete: true,
    cwd: directory,
    invalidate() {
      clearTimeout(timeout);
      resolvePreview();
    },
  } as unknown as Parameters<RenderCall>[2];
  const partialComponent = prefetch
    ? tool.renderCall(
        { path: input.path, edits: [] },
        theme,
        { ...context, argsComplete: false },
      )
    : undefined;
  const component = tool.renderCall(input, theme, { ...context, lastComponent: partialComponent });
  return { component, done };
}

describe("edit accelerator extension", () => {
  it("builds an accelerated interactive preview from a streamed path", async () => {
    initTheme("dark");
    const directory = await createDirectory();
    await writeFile(join(directory, "fixture.txt"), "before\nmiddle\n", "utf8");
    const tool = loadExtensionTool();
    const preview = renderPreview(tool, directory, {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after" }],
    }, true);
    await preview.done;

    expect(preview.component.render(80).join("\n")).toContain("after");
  });

  it("shares an in-flight preview with positional execution", async () => {
    initTheme("dark");
    const directory = await createDirectory();
    await writeFile(join(directory, "fixture.txt"), "before\nmiddle\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const tool = loadExtensionTool();

    const preview = renderPreview(tool, directory, input);
    const [result] = await Promise.all([execute(tool, directory, input), preview.done]);

    expect(result.details?.diff).toContain("+1 after!");
    expect(await readFile(join(directory, "fixture.txt"), "utf8")).toBe("after!\nmiddle\n");
  });

  it("delegates Unicode-space paths to Pi normalization", async () => {
    initTheme("dark");
    for (const prepared of [false, true]) {
      const directory = await createDirectory();
      await writeFile(join(directory, "a\u00a0b.txt"), "before\n", "utf8");
      await writeFile(join(directory, "a b.txt"), "before\n", "utf8");
      const input: EditToolInput = {
        path: "a\u00a0b.txt",
        edits: [{ oldText: "before", newText: "after" }],
      };
      const tool = loadExtensionTool();
      if (prepared) {
        const preview = renderPreview(tool, directory, input, true);
        await Promise.all([execute(tool, directory, input), preview.done]);
      } else await execute(tool, directory, input);

      expect(await readFile(join(directory, "a\u00a0b.txt"), "utf8")).toBe("before\n");
      expect(await readFile(join(directory, "a b.txt"), "utf8")).toBe("after\n");
    }
  });

  it("preserves Pi's no-change error and original bytes", async () => {
    initTheme("dark");
    for (const content of ["ab\r\nend\n", "ab"]) {
      for (const prepared of [false, true]) {
        const directory = await createDirectory();
        const path = join(directory, "fixture.txt");
        await writeFile(path, content, "utf8");
        const input: EditToolInput = {
          path: "fixture.txt",
          edits: [
            { oldText: "a", newText: "ab" },
            { oldText: "b", newText: "" },
          ],
        };
        const tool = loadExtensionTool();
        if (prepared) {
          const preview = renderPreview(tool, directory, input, true);
          await expect(Promise.all([execute(tool, directory, input), preview.done])).rejects.toThrow(
            "No changes made to fixture.txt",
          );
        } else {
          await expect(execute(tool, directory, input)).rejects.toThrow("No changes made to fixture.txt");
        }
        expect(await readFile(path, "utf8")).toBe(content);
      }
    }
  });

  it("matches built-in alignment after merging separated repeated-line groups", async () => {
    initTheme("dark");
    for (const prepared of [false, true]) {
      const extensionDirectory = await createDirectory();
      const builtInDirectory = await createDirectory();
      const content = "head\n\n{\n{\n{\n\n}\na\n}\n\n{\n{\n{\n\n}\n\n\n\n\nb\n";
      await writeFile(join(extensionDirectory, "fixture.txt"), content, "utf8");
      await writeFile(join(builtInDirectory, "fixture.txt"), content, "utf8");
      const input: EditToolInput = {
        path: "fixture.txt",
        edits: [
          { oldText: "\n{\n{\n{\n\n}\na\n}", newText: "" },
          { oldText: "b", newText: "\n\n" },
        ],
      };
      const extensionTool = loadExtensionTool();
      let extensionResult;
      if (prepared) {
        const preview = renderPreview(extensionTool, extensionDirectory, input, true);
        [extensionResult] = await Promise.all([
          execute(extensionTool, extensionDirectory, input),
          preview.done,
        ]);
      } else extensionResult = await execute(extensionTool, extensionDirectory, input);
      const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

      expect(extensionResult).toEqual(builtInResult);
      const extensionBytes = await readFile(join(extensionDirectory, "fixture.txt"));
      expect(extensionBytes).toEqual(await readFile(join(builtInDirectory, "fixture.txt")));
      expect(applyPatch(content, extensionResult.details!.patch)).toBe(extensionBytes.toString("utf8"));
    }
  });

  it("matches built-in alignment for wider structural groups", async () => {
    initTheme("dark");
    const widen = (text: string): string => text.replace(/\n/g, "\n".repeat(4));
    for (const prepared of [false, true]) {
      const extensionDirectory = await createDirectory();
      const builtInDirectory = await createDirectory();
      const content = widen("head\n\n{\n{\n{\n\n}\na\n}\n\n{\n{\n{\n\n}\n\n\n\n\nb\n");
      await writeFile(join(extensionDirectory, "fixture.txt"), content, "utf8");
      await writeFile(join(builtInDirectory, "fixture.txt"), content, "utf8");
      const input: EditToolInput = {
        path: "fixture.txt",
        edits: [
          { oldText: widen("\n{\n{\n{\n\n}\na\n}"), newText: "" },
          { oldText: "b", newText: widen("\n\n") },
        ],
      };
      const extensionTool = loadExtensionTool();
      let extensionResult;
      if (prepared) {
        const preview = renderPreview(extensionTool, extensionDirectory, input, true);
        [extensionResult] = await Promise.all([
          execute(extensionTool, extensionDirectory, input),
          preview.done,
        ]);
      } else extensionResult = await execute(extensionTool, extensionDirectory, input);
      const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

      expect(extensionResult).toEqual(builtInResult);
      const extensionBytes = await readFile(join(extensionDirectory, "fixture.txt"));
      expect(extensionBytes).toEqual(await readFile(join(builtInDirectory, "fixture.txt")));
      expect(applyPatch(content, extensionResult.details!.patch)).toBe(extensionBytes.toString("utf8"));
    }
  });

  it("delegates interacting expanded groups to built-in details", async () => {
    initTheme("dark");
    for (const prepared of [false, true]) {
      const extensionDirectory = await createDirectory();
      const builtInDirectory = await createDirectory();
      const content = `head\na\nx\n${"a\n".repeat(12)}tail\n`;
      await writeFile(join(extensionDirectory, "fixture.txt"), content, "utf8");
      await writeFile(join(builtInDirectory, "fixture.txt"), content, "utf8");
      const input: EditToolInput = {
        path: "fixture.txt",
        edits: [
          { oldText: "a\nx\n", newText: "" },
          { oldText: "tail", newText: "TAIL" },
        ],
      };
      const extensionTool = loadExtensionTool();
      let extensionResult;
      if (prepared) {
        const preview = renderPreview(extensionTool, extensionDirectory, input, true);
        [extensionResult] = await Promise.all([
          execute(extensionTool, extensionDirectory, input),
          preview.done,
        ]);
      } else extensionResult = await execute(extensionTool, extensionDirectory, input);
      const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

      expect(extensionResult).toEqual(builtInResult);
      const extensionBytes = await readFile(join(extensionDirectory, "fixture.txt"));
      expect(extensionBytes).toEqual(await readFile(join(builtInDirectory, "fixture.txt")));
      expect(applyPatch(content, extensionResult.details!.patch)).toBe(extensionBytes.toString("utf8"));
    }
  });

  it("matches built-in bytes when replacement text splits a surrogate pair", async () => {
    initTheme("dark");
    for (const newText of ["XYZ", "X"]) {
      const extensionDirectory = await createDirectory();
      const builtInDirectory = await createDirectory();
      await writeFile(join(extensionDirectory, "fixture.txt"), "😀 �\n", "utf8");
      await writeFile(join(builtInDirectory, "fixture.txt"), "😀 �\n", "utf8");
      const input: EditToolInput = {
        path: "fixture.txt",
        edits: [{ oldText: "\ud83d", newText }],
      };
      const extensionTool = loadExtensionTool();
      const preview = renderPreview(extensionTool, extensionDirectory, input, true);
      const [extensionResult] = await Promise.all([
        execute(extensionTool, extensionDirectory, input),
        preview.done,
      ]);
      const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

      expect(extensionResult).toEqual(builtInResult);
      expect(await readFile(join(extensionDirectory, "fixture.txt"))).toEqual(
        await readFile(join(builtInDirectory, "fixture.txt")),
      );
    }
  });

  it.each([
    { content: "\nabc\ndef\n", oldText: "\nabc", newText: "X" },
    { content: "\na\nb\nc\nd\ne\nf\n", oldText: "b", newText: "B" },
    { content: `head\na\nx\n${"a\n".repeat(8)}tail\n`, oldText: "a\nx\n", newText: "" },
  ])("matches built-in details for sparse boundary fixture %#", async ({ content, oldText, newText }) => {
    initTheme("dark");
    const extensionDirectory = await createDirectory();
    const builtInDirectory = await createDirectory();
    await writeFile(join(extensionDirectory, "fixture.txt"), content, "utf8");
    await writeFile(join(builtInDirectory, "fixture.txt"), content, "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText, newText }],
    };
    const extensionTool = loadExtensionTool();
    const preview = renderPreview(extensionTool, extensionDirectory, input, true);
    const [extensionResult] = await Promise.all([
      execute(extensionTool, extensionDirectory, input),
      preview.done,
    ]);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"))).toEqual(
      await readFile(join(builtInDirectory, "fixture.txt")),
    );
  });

  it("registers one edit override with the built-in contract", () => {
    const tool = loadExtensionTool();
    expect(tool.name).toBe("edit");
    expect(tool.prepareArguments).toBeTypeOf("function");
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
  });

  it("matches the built-in result for an exact edit", async () => {
    const extensionDirectory = await createDirectory();
    const builtInDirectory = await createDirectory();
    await writeFile(join(extensionDirectory, "fixture.txt"), "before\nmiddle\n", "utf8");
    await writeFile(join(builtInDirectory, "fixture.txt"), "before\nmiddle\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after" }],
    };

    const extensionResult = await execute(loadExtensionTool(), extensionDirectory, input);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"), "utf8")).toBe(
      await readFile(join(builtInDirectory, "fixture.txt"), "utf8"),
    );
  });

  it("matches the built-in result for partial and multiline edits", async () => {
    const extensionDirectory = await createDirectory();
    const builtInDirectory = await createDirectory();
    const content = "const before = 1;\nold one\nold two\nlast\n";
    await writeFile(join(extensionDirectory, "fixture.txt"), content, "utf8");
    await writeFile(join(builtInDirectory, "fixture.txt"), content, "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [
        { oldText: "before", newText: "after" },
        { oldText: "old one\nold two", newText: "new one\nnew two\nnew three" },
      ],
    };

    const extensionTool = loadExtensionTool();
    const preview = renderPreview(extensionTool, extensionDirectory, input, true);
    const [extensionResult] = await Promise.all([
      execute(extensionTool, extensionDirectory, input),
      preview.done,
    ]);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"), "utf8")).toBe(
      await readFile(join(builtInDirectory, "fixture.txt"), "utf8"),
    );
  });

  it("matches built-in byte behavior for invalid UTF-8", async () => {
    const extensionDirectory = await createDirectory();
    const builtInDirectory = await createDirectory();
    const content = Buffer.from([0xc0, ...Buffer.from("before\n")]);
    await writeFile(join(extensionDirectory, "fixture.txt"), content);
    await writeFile(join(builtInDirectory, "fixture.txt"), content);
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const extensionTool = loadExtensionTool();
    const preview = renderPreview(extensionTool, extensionDirectory, input, true);
    const [extensionResult] = await Promise.all([
      execute(extensionTool, extensionDirectory, input),
      preview.done,
    ]);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"))).toEqual(
      await readFile(join(builtInDirectory, "fixture.txt")),
    );
  });

  it("falls back to built-in fuzzy matching", async () => {
    const extensionDirectory = await createDirectory();
    const builtInDirectory = await createDirectory();
    await writeFile(join(extensionDirectory, "fixture.txt"), "const value = ‘before’;\n", "utf8");
    await writeFile(join(builtInDirectory, "fixture.txt"), "const value = ‘before’;\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "const value = 'before';", newText: "const value = 'after';" }],
    };

    const extensionTool = loadExtensionTool();
    const preview = renderPreview(extensionTool, extensionDirectory, input);
    const [extensionResult] = await Promise.all([
      execute(extensionTool, extensionDirectory, input),
      preview.done,
    ]);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"), "utf8")).toBe(
      await readFile(join(builtInDirectory, "fixture.txt"), "utf8"),
    );
  });
});
