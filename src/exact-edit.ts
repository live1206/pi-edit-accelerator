import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  type EditToolDetails,
  type EditToolInput,
  type ExtensionContext,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { buildSparseLineDiffs, type LineReplacement } from "./sparse-diff.ts";

export interface ExactEditResult {
  content: Array<{ type: "text"; text: string }>;
  details: EditToolDetails;
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  return crlf !== -1 && crlf === lf - 1 ? "\r\n" : "\n";
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function resolveOrdinaryPath(path: string, cwd: string): string | undefined {
  if (path.startsWith("~") || path.startsWith("@") || path.includes("\u202f")) return undefined;
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

interface ExactEditPlan {
  newContent: string;
  lineReplacements: LineReplacement[];
}

function tryPlanExactEdits(content: string, input: EditToolInput): ExactEditPlan | undefined {
  if (!Array.isArray(input.edits) || input.edits.length === 0) return undefined;
  if (normalizeForFuzzyMatch(content) !== content) return undefined;

  const matches: Array<{ index: number; length: number; replacement: string; lineIndex: number }> = [];
  for (const edit of input.edits) {
    const oldText = normalizeToLf(edit.oldText);
    const newText = normalizeToLf(edit.newText);
    if (oldText.length === 0 || normalizeForFuzzyMatch(oldText) !== oldText) return undefined;

    const index = content.indexOf(oldText);
    if (index === -1 || content.indexOf(oldText, index + 1) !== -1) return undefined;
    const lineStart = content.lastIndexOf("\n", index - 1) + 1;
    const nextNewline = content.indexOf("\n", index);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    if (index !== lineStart || index + oldText.length !== lineEnd || newText.includes("\n")) return undefined;
    const lineIndex = content.slice(0, lineStart).split("\n").length - 1;
    matches.push({ index, length: oldText.length, replacement: newText, lineIndex });
  }

  matches.sort((left, right) => left.index - right.index);
  for (let index = 1; index < matches.length; index++) {
    const previous = matches[index - 1]!;
    if (previous.index + previous.length > matches[index]!.index) return undefined;
  }

  let result = content;
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index]!;
    result = result.slice(0, match.index) + match.replacement + result.slice(match.index + match.length);
  }
  if (result === content) return undefined;
  return {
    newContent: result,
    lineReplacements: matches.map((match) => ({
      lineIndex: match.lineIndex,
      oldText: content.slice(match.index, match.index + match.length),
      newText: match.replacement,
    })),
  };
}

export function tryApplyExactEdits(content: string, input: EditToolInput): string | undefined {
  return tryPlanExactEdits(content, input)?.newContent;
}

export async function tryExecuteExactEdit(
  input: EditToolInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ExactEditResult | undefined> {
  const absolutePath = resolveOrdinaryPath(input.path, ctx.cwd);
  if (!absolutePath) return undefined;

  return withFileMutationQueue(absolutePath, async () => {
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      await access(absolutePath, constants.R_OK | constants.W_OK);
    } catch {
      return undefined;
    }
    if (signal?.aborted) throw new Error("Operation aborted");

    const rawContent = await readFile(absolutePath, "utf8");
    const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : "";
    const content = bom ? rawContent.slice(1) : rawContent;
    const lineEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLf(content);
    const plan = tryPlanExactEdits(normalizedContent, input);
    if (plan === undefined) return undefined;

    const sparseDiffs = buildSparseLineDiffs(
      input.path,
      normalizedContent,
      plan.newContent,
      plan.lineReplacements,
    );
    if (signal?.aborted) throw new Error("Operation aborted");
    await writeFile(absolutePath, bom + restoreLineEndings(plan.newContent, lineEnding), "utf8");
    if (signal?.aborted) throw new Error("Operation aborted");

    return {
      content: [{ type: "text", text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` }],
      details: sparseDiffs,
    };
  });
}
