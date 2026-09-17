import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { EditToolInput, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tryExecuteExactEdit, tryPrepareExactEdit } from "../src/exact-edit.ts";

interface Sample {
  wallTimeMs: number;
  result: Awaited<ReturnType<typeof tryExecuteExactEdit>>;
  content: string;
}

function makeFixture(): string {
  return `FIRST_MARKER\n${"0123456789abcdef0123456789abcdef\n".repeat(158_875)}LAST_MARKER\n`;
}

const input: EditToolInput = {
  path: "large.txt",
  edits: [
    { oldText: "FIRST_MARKER", newText: "FIRST_CHANGE" },
    { oldText: "LAST_MARKER", newText: "LAST_CHANGE" },
  ],
};

async function measure(positional: boolean): Promise<Sample> {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-positional-"));
  const path = join(directory, input.path);
  try {
    await writeFile(path, makeFixture(), "utf8");
    const prepared = await tryPrepareExactEdit(input, directory);
    if (!prepared) throw new Error("Unable to prepare exact edit");
    if (!prepared.positionalWrites) throw new Error("Fixture is not eligible for positional writes");
    const executionPlan = positional ? prepared : { ...prepared, positionalWrites: undefined };
    const startedAt = performance.now();
    const result = await tryExecuteExactEdit(
      input,
      undefined,
      { cwd: directory } as ExtensionContext,
      executionPlan,
    );
    return {
      wallTimeMs: performance.now() - startedAt,
      result,
      content: await readFile(path, "utf8"),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function summarize(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    samplesMs: sorted,
  };
}

const fullReference = await measure(false);
const positionalReference = await measure(true);
deepStrictEqual(positionalReference.result, fullReference.result);
strictEqual(positionalReference.content, fullReference.content);

for (let index = 0; index < 3; index++) {
  await measure(index % 2 === 0);
  await measure(index % 2 !== 0);
}

const fullWriteSamples: number[] = [];
const positionalWriteSamples: number[] = [];
for (let index = 0; index < 20; index++) {
  if (index % 2 === 0) {
    fullWriteSamples.push((await measure(false)).wallTimeMs);
    positionalWriteSamples.push((await measure(true)).wallTimeMs);
  } else {
    positionalWriteSamples.push((await measure(true)).wallTimeMs);
    fullWriteSamples.push((await measure(false)).wallTimeMs);
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      runs: 20,
      fixtureBytes: Buffer.byteLength(makeFixture()),
      edits: input.edits.length,
      fullWrite: summarize(fullWriteSamples),
      positionalWrite: summarize(positionalWriteSamples),
    },
    null,
    2,
  )}\n`,
);
