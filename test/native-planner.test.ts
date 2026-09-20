import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EditToolInput, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  tryApplyExactEdits,
  tryExecuteExactEdit,
  tryPrepareExactEdit,
} from "../src/exact-edit.ts";
import {
  getNativeBackendStats,
  getNativePlannerStatus,
  resetNativePlannerForTests,
  tryNativeAsciiExecutionPlan,
  tryNativeAsciiPlan,
  tryNativeAsciiSuffix,
} from "../src/native-planner.ts";

const nativePath = resolve("native/pi-edit-accelerator-native.linux-x64-gnu.node");
const nativeAvailable =
  process.env.PI_EDIT_ACCELERATOR_NATIVE !== "0" &&
  process.platform === "linux" &&
  process.arch === "x64" &&
  existsSync(nativePath);
const originalNativePath = process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH;
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  if (originalNativePath === undefined) delete process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH;
  else process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = originalNativePath;
  resetNativePlannerForTests();
});

describe.skipIf(!nativeAvailable)("native ASCII planner", () => {
  it("returns matching offsets, lines, and positional writes", () => {
    process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = nativePath;
    resetNativePlannerForTests();
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [
        { oldText: "first", newText: "FIRST" },
        { oldText: "last", newText: "LAST" },
      ],
    };

    const attempt = tryNativeAsciiPlan(Buffer.from("first\nmiddle\nlast\n"), input);

    expect(attempt).toMatchObject({
      status: "planned",
      plan: {
        oldLineCount: 4,
        oldEndsWithNewline: true,
        replacements: [
          { matchIndex: 0, matchLength: 5, newText: "FIRST", firstLine: 0, lastLine: 0 },
          { matchIndex: 13, matchLength: 4, newText: "LAST", firstLine: 2, lastLine: 2 },
        ],
        positionalWrites: [
          { position: 0, bytes: Buffer.from("FIRST") },
          { position: 13, bytes: Buffer.from("LAST") },
        ],
        suffixWrite: undefined,
      },
    });
    if (attempt.status !== "planned") throw new Error("Native planner unexpectedly declined");
    expect(attempt.plan.diffWindows).toHaveLength(1);
    expect(attempt.plan.diffWindows?.[0]?.oldBytes.toString("utf8")).toBe("first\nmiddle\nlast\n");
    expect(attempt.plan.diffWindows?.[0]?.newBytes.toString("utf8")).toBe("FIRST\nmiddle\nLAST\n");
    expect(getNativePlannerStatus()).toBe("loaded");
    expect(getNativeBackendStats().nativeHits).toBe(1);
  });

  it("returns suffix metadata without assembling output", () => {
    process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = nativePath;
    resetNativePlannerForTests();
    const attempt = tryNativeAsciiPlan(
      Buffer.from("first\nmiddle\nlast\n"),
      { path: "fixture.txt", edits: [{ oldText: "first", newText: "expanded" }] },
      3,
    );

    expect(attempt.status).toBe("planned");
    if (attempt.status !== "planned") throw new Error("Native planner unexpectedly declined");
    expect(attempt.plan.positionalWrites).toBeUndefined();
    expect(attempt.plan.suffixWrite).toEqual({ position: 3, contentOffset: 0, replacementIndex: 0 });
  });

  it("declines ambiguous plans but leaves Unicode edits to TypeScript", () => {
    process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = nativePath;
    resetNativePlannerForTests();
    expect(
      tryNativeAsciiPlan(
        Buffer.from("same\nsame\n"),
        { path: "fixture.txt", edits: [{ oldText: "same", newText: "changed" }] },
      ).status,
    ).toBe("declined");

    resetNativePlannerForTests();
    expect(
      tryNativeAsciiPlan(
        Buffer.from("ab\n"),
        {
          path: "fixture.txt",
          edits: [
            { oldText: "a", newText: "\ud83d" },
            { oldText: "b", newText: "\ude00" },
          ],
        },
      ),
    ).toEqual({ status: "not-used" });
    expect(getNativePlannerStatus()).toBe("uninitialized");
    expect(getNativeBackendStats().unsupportedInputs).toBe(1);
  });

  it("assembles suffixes only for execution", () => {
    process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = nativePath;
    resetNativePlannerForTests();
    const content = Buffer.from("first\nmiddle\nlast\n");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "first", newText: "first expanded" }],
    };
    const preview = tryNativeAsciiPlan(content, input);
    const execution = tryNativeAsciiExecutionPlan(content, input);

    expect(preview.status).toBe("planned");
    expect(execution.status).toBe("planned");
    if (preview.status !== "planned" || execution.status !== "planned") return;
    expect(preview.plan.suffixBytes).toBeUndefined();
    expect(execution.plan.suffixBytes?.toString("utf8")).toBe("first expanded\nmiddle\nlast\n");
    expect(
      tryNativeAsciiSuffix(
        content,
        preview.plan.replacements,
        preview.plan.suffixWrite!.contentOffset,
        preview.plan.suffixWrite!.replacementIndex,
      )?.toString("utf8"),
    ).toBe("first expanded\nmiddle\nlast\n");
  });

  it("keeps preview buffer-first and defers suffix materialization until execution", async () => {
    process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = nativePath;
    resetNativePlannerForTests();
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-native-preview-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "first\nmiddle\nlast\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "first", newText: "first expanded" }],
    };

    const prepared = await tryPrepareExactEdit(input, directory);

    expect(prepared).toBeDefined();
    expect(prepared?.normalizedContent).toBeUndefined();
    expect(prepared?.suffixWrite).toEqual({ position: 0, contentOffset: 0, replacementIndex: 0 });
    const result = await tryExecuteExactEdit(
      input,
      undefined,
      { cwd: directory } as ExtensionContext,
      prepared,
    );
    expect(result).toEqual(prepared?.result);
    expect(await readFile(path, "utf8")).toBe("first expanded\nmiddle\nlast\n");
  });

  it("preserves a UTF-8 BOM during fresh native suffix execution", async () => {
    process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = nativePath;
    resetNativePlannerForTests();
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-native-bom-"));
    tempDirectories.push(directory);
    const path = join(directory, "fixture.txt");
    await writeFile(path, "\uFEFFbefore\nafter\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "before expanded" }],
    };

    const result = await tryExecuteExactEdit(
      input,
      undefined,
      { cwd: directory } as ExtensionContext,
    );

    expect(result).toBeDefined();
    expect(await readFile(path, "utf8")).toBe("\uFEFFbefore expanded\nafter\n");
  });

  it("matches the TypeScript oracle across deterministic ASCII plans", () => {
    process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = nativePath;
    resetNativePlannerForTests();
    for (let caseIndex = 0; caseIndex < 100; caseIndex++) {
      const lines = Array.from({ length: 5 + (caseIndex % 20) }, (_, index) => `line_${caseIndex}_${index}`);
      const content = `${lines.join("\n")}\n`;
      const selected = [caseIndex % lines.length, (caseIndex * 7 + 3) % lines.length]
        .sort((left, right) => left - right)
        .filter((value, index, values) => index === 0 || value !== values[index - 1]);
      const input: EditToolInput = {
        path: "fixture.txt",
        edits: selected.map((line) => ({
          oldText: `${lines[line]}\n`,
          newText: `changed_${caseIndex}_${line}\n`,
        })),
      };
      const expected = tryApplyExactEdits(content, input);
      const attempt = tryNativeAsciiPlan(Buffer.from(content), input);
      expect(attempt.status).toBe("planned");
      if (attempt.status !== "planned") continue;
      let actual = content;
      for (const replacement of [...attempt.plan.replacements].reverse()) {
        actual =
          actual.slice(0, replacement.matchIndex) +
          replacement.newText +
          actual.slice(replacement.matchIndex + replacement.matchLength);
        expect(replacement.firstLine).toBe(content.slice(0, replacement.matchIndex).split("\n").length - 1);
      }
      expect(actual).toBe(expected);
    }
  });

  it("caches a native load failure as disabled", () => {
    process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = resolve("native/missing.node");
    resetNativePlannerForTests();
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };

    expect(tryNativeAsciiPlan(Buffer.from("before\n"), input)).toEqual({ status: "not-used" });
    expect(getNativePlannerStatus()).toBe("disabled");
    expect(getNativeBackendStats().loadFailures).toBe(1);
    process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH = nativePath;
    expect(tryNativeAsciiPlan(Buffer.from("before\n"), input)).toEqual({ status: "not-used" });
    expect(getNativeBackendStats().disabledFallbacks).toBe(1);
  });
});
