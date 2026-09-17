import { constants } from "node:fs";
import { access, open, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  type EditToolDetails,
  type EditToolInput,
  type ExtensionContext,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { buildSparseDiffs, type SparseReplacement } from "./sparse-diff.ts";

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

const trailingWhitespacePattern = /[^\S\n]+(?=\n|$)/u;
const fuzzySpecialCharacterPattern = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2010-\u2015\u2212\u00A0\u2002-\u200A\u202F\u205F\u3000]/u;
const normalizationCandidatePattern = /([^\S\n]+(?=\n|$))|([^\x00-\x7F])/u;

function isFuzzyNormalizationNeutral(text: string): boolean {
  const candidate = normalizationCandidatePattern.exec(text);
  if (!candidate) return true;
  if (candidate[1] !== undefined) return false;
  if (trailingWhitespacePattern.test(text) || fuzzySpecialCharacterPattern.test(text)) return false;
  return text.normalize("NFKC") === text;
}

function resolveOrdinaryPath(path: string, cwd: string): string | undefined {
  if (path.startsWith("~") || path.startsWith("@") || path.includes("\u202f")) return undefined;
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

interface ExactEditPlan {
  replacements: SparseReplacement[];
  oldLineCount: number;
}

interface PositionalWrite {
  position: number;
  bytes: Buffer;
}

export interface PreparedExactEdit {
  absolutePath: string;
  inputKey: string;
  rawBytes: Buffer;
  bom: string;
  lineEnding: "\r\n" | "\n";
  normalizedContent: string;
  replacements: SparseReplacement[];
  positionalWrites?: PositionalWrite[];
  result: ExactEditResult;
}

export function getExactEditInputKey(input: EditToolInput, cwd: string): string | undefined {
  if (typeof input?.path !== "string" || !Array.isArray(input.edits)) return undefined;
  const absolutePath = resolveOrdinaryPath(input.path, cwd);
  if (!absolutePath) return undefined;
  try {
    return `${absolutePath}\0${JSON.stringify({ path: input.path, edits: input.edits })}`;
  } catch {
    return undefined;
  }
}

function tryPlanExactEdits(content: string, input: EditToolInput): ExactEditPlan | undefined {
  if (!Array.isArray(input.edits) || input.edits.length === 0) return undefined;
  if (!isFuzzyNormalizationNeutral(content)) return undefined;

  const matches: Array<{
    index: number;
    length: number;
    replacement: string;
    firstLine?: number;
    lastLine?: number;
  }> = [];
  let hasChange = false;
  for (const edit of input.edits) {
    const oldText = normalizeToLf(edit.oldText);
    const newText = normalizeToLf(edit.newText);
    if (oldText.length === 0 || !isFuzzyNormalizationNeutral(oldText)) return undefined;

    const index = content.indexOf(oldText);
    if (index === -1 || content.indexOf(oldText, index + 1) !== -1) return undefined;
    if (oldText !== newText) hasChange = true;
    matches.push({ index, length: oldText.length, replacement: newText });
  }

  matches.sort((left, right) => left.index - right.index);
  let currentLine = 0;
  let lineScanOffset = 0;
  for (let index = 0; index < matches.length; index++) {
    const current = matches[index]!;
    const previous = matches[index - 1];
    if (previous && previous.index + previous.length > current.index) return undefined;

    let newline = content.indexOf("\n", lineScanOffset);
    while (newline !== -1 && newline < current.index) {
      currentLine++;
      lineScanOffset = newline + 1;
      newline = content.indexOf("\n", lineScanOffset);
    }
    current.firstLine = currentLine;
    const finalMatchedIndex = current.index + current.length - 1;
    while (newline !== -1 && newline < finalMatchedIndex) {
      currentLine++;
      lineScanOffset = newline + 1;
      newline = content.indexOf("\n", lineScanOffset);
    }
    current.lastLine = currentLine;
  }
  let remainingNewline = content.indexOf("\n", lineScanOffset);
  while (remainingNewline !== -1) {
    currentLine++;
    lineScanOffset = remainingNewline + 1;
    remainingNewline = content.indexOf("\n", lineScanOffset);
  }

  if (!hasChange) return undefined;
  return {
    oldLineCount: currentLine + 1,
    replacements: matches.map((match) => ({
      matchIndex: match.index,
      matchLength: match.length,
      newText: match.replacement,
      firstLine: match.firstLine!,
      lastLine: match.lastLine!,
    })),
  };
}

function buildPositionalWrites(
  rawBytes: Buffer,
  content: string,
  normalizedContent: string,
  bom: string,
  replacements: readonly SparseReplacement[],
): PositionalWrite[] | undefined {
  if (content !== normalizedContent) return undefined;
  const writes: PositionalWrite[] = [];
  let searchOffset = Buffer.byteLength(bom);
  for (const replacement of replacements) {
    const oldText = content.slice(
      replacement.matchIndex,
      replacement.matchIndex + replacement.matchLength,
    );
    const oldBytes = Buffer.from(oldText);
    const newBytes = Buffer.from(replacement.newText);
    if (oldBytes.length !== newBytes.length) return undefined;
    const position = rawBytes.indexOf(oldBytes, searchOffset);
    if (position === -1) return undefined;
    if (oldText !== replacement.newText) writes.push({ position, bytes: newBytes });
    searchOffset = position + oldBytes.length;
  }
  return writes;
}

async function applyPositionalWrites(
  handle: Awaited<ReturnType<typeof open>>,
  writes: readonly PositionalWrite[],
): Promise<void> {
  for (const write of writes) {
    let offset = 0;
    while (offset < write.bytes.length) {
      const { bytesWritten } = await handle.write(
        write.bytes,
        offset,
        write.bytes.length - offset,
        write.position + offset,
      );
      if (bytesWritten === 0) throw new Error("Unable to complete positional edit write");
      offset += bytesWritten;
    }
  }
}

function applyPlannedEdits(content: string, replacements: readonly SparseReplacement[]): string {
  const parts: string[] = [];
  let contentOffset = 0;
  for (const replacement of replacements) {
    parts.push(content.slice(contentOffset, replacement.matchIndex), replacement.newText);
    contentOffset = replacement.matchIndex + replacement.matchLength;
  }
  parts.push(content.slice(contentOffset));
  return parts.join("");
}

export function tryApplyExactEdits(content: string, input: EditToolInput): string | undefined {
  const plan = tryPlanExactEdits(content, input);
  return plan && applyPlannedEdits(content, plan.replacements);
}

export async function tryPrepareExactEdit(
  input: EditToolInput,
  cwd: string,
): Promise<PreparedExactEdit | undefined> {
  const inputKey = getExactEditInputKey(input, cwd);
  if (!inputKey) return undefined;
  const absolutePath = resolveOrdinaryPath(input.path, cwd)!;
  try {
    await access(absolutePath, constants.R_OK);
    const rawBytes = await readFile(absolutePath);
    const rawContent = rawBytes.toString("utf8");
    const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : "";
    const content = bom ? rawContent.slice(1) : rawContent;
    const lineEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLf(content);
    const plan = tryPlanExactEdits(normalizedContent, input);
    if (!plan) return undefined;
    const details = buildSparseDiffs(
      input.path,
      normalizedContent,
      plan.replacements,
      plan.oldLineCount,
    );
    return {
      absolutePath,
      inputKey,
      rawBytes,
      bom,
      lineEnding,
      normalizedContent,
      replacements: plan.replacements,
      positionalWrites: buildPositionalWrites(rawBytes, content, normalizedContent, bom, plan.replacements),
      result: {
        content: [
          { type: "text", text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` },
        ],
        details,
      },
    };
  } catch {
    return undefined;
  }
}

export async function tryBuildExactPreview(
  input: EditToolInput,
  cwd: string,
): Promise<EditToolDetails | undefined> {
  return (await tryPrepareExactEdit(input, cwd))?.result.details;
}

export async function tryExecuteExactEdit(
  input: EditToolInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  prepared?: PreparedExactEdit,
): Promise<ExactEditResult | undefined> {
  if (typeof input?.path !== "string" || !Array.isArray(input.edits)) return undefined;
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

    const preparedMatchesInput =
      prepared?.absolutePath === absolutePath &&
      prepared.inputKey === getExactEditInputKey(input, ctx.cwd);
    let rawBytes: Buffer;
    if (preparedMatchesInput && prepared.positionalWrites) {
      const handle = await open(absolutePath, "r+");
      try {
        rawBytes = await handle.readFile();
        if (prepared.rawBytes.equals(rawBytes)) {
          if (signal?.aborted) throw new Error("Operation aborted");
          await applyPositionalWrites(handle, prepared.positionalWrites);
          if (signal?.aborted) throw new Error("Operation aborted");
          return prepared.result;
        }
      } finally {
        await handle.close();
      }
    } else {
      rawBytes = await readFile(absolutePath);
      if (preparedMatchesInput && prepared?.rawBytes.equals(rawBytes)) {
        if (signal?.aborted) throw new Error("Operation aborted");
        const newContent = applyPlannedEdits(prepared.normalizedContent, prepared.replacements);
        await writeFile(
          absolutePath,
          prepared.bom + restoreLineEndings(newContent, prepared.lineEnding),
          "utf8",
        );
        if (signal?.aborted) throw new Error("Operation aborted");
        return prepared.result;
      }
    }

    const rawContent = rawBytes.toString("utf8");
    const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : "";
    const content = bom ? rawContent.slice(1) : rawContent;
    const lineEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLf(content);
    const plan = tryPlanExactEdits(normalizedContent, input);
    if (plan === undefined) return undefined;

    const sparseDiffs = buildSparseDiffs(
      input.path,
      normalizedContent,
      plan.replacements,
      plan.oldLineCount,
    );
    const newContent = applyPlannedEdits(normalizedContent, plan.replacements);
    if (signal?.aborted) throw new Error("Operation aborted");
    await writeFile(absolutePath, bom + restoreLineEndings(newContent, lineEnding), "utf8");
    if (signal?.aborted) throw new Error("Operation aborted");

    return {
      content: [{ type: "text", text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` }],
      details: sparseDiffs,
    };
  });
}
