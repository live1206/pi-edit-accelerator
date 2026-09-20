import { isAscii, isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { access, open, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  type EditToolDetails,
  type EditToolInput,
  type ExtensionContext,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  tryNativeAsciiPlan,
  type NativeExactEditPlan,
  type NativePlanningAttempt,
} from "./native-planner.ts";
import {
  buildSparseDiffs,
  buildSparseDiffsFromWindows,
  type SparseReplacement,
} from "./sparse-diff.ts";

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

const normalizedPathSpacePattern = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/u;

function resolveOrdinaryPath(path: string, cwd: string): string | undefined {
  if (path.startsWith("~") || path.startsWith("@") || normalizedPathSpacePattern.test(path)) return undefined;
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

interface SuffixWrite {
  position: number;
  contentOffset: number;
  replacementIndex: number;
}

export interface PrefetchedExactEditFile {
  absolutePath: string;
  rawBytes: Buffer;
}

export interface PreparedExactEdit {
  absolutePath: string;
  inputKey: string;
  rawBytes: Buffer;
  bom: string;
  lineEnding: "\r\n" | "\n";
  normalizedContent?: string;
  replacements: SparseReplacement[];
  prefetched: boolean;
  positionalWrites?: PositionalWrite[];
  suffixWrite?: SuffixWrite;
  result: ExactEditResult;
}

export function getExactEditPathKey(path: string, cwd: string): string | undefined {
  return resolveOrdinaryPath(path, cwd);
}

export function getExactEditInputKey(input: EditToolInput, cwd: string): string | undefined {
  if (typeof input?.path !== "string" || !Array.isArray(input.edits)) return undefined;
  const absolutePath = getExactEditPathKey(input.path, cwd);
  if (!absolutePath) return undefined;
  try {
    return `${absolutePath}\0${JSON.stringify({ path: input.path, edits: input.edits })}`;
  } catch {
    return undefined;
  }
}

function isAsciiWhitespaceExceptLf(code: number): boolean {
  return code === 9 || code === 11 || code === 12 || code === 13 || code === 32;
}

function plannedEditsProduceChange(
  content: string,
  matches: readonly { index: number; length: number; replacement: string }[],
): boolean {
  let sourceOffset = 0;
  let outputOffset = 0;
  for (const match of matches) {
    const unchangedLength = match.index - sourceOffset;
    if (sourceOffset !== outputOffset) {
      for (let index = 0; index < unchangedLength; index++) {
        if (content.charCodeAt(sourceOffset + index) !== content.charCodeAt(outputOffset + index)) return true;
      }
    }
    outputOffset += unchangedLength;
    for (let index = 0; index < match.replacement.length; index++) {
      if (match.replacement.charCodeAt(index) !== content.charCodeAt(outputOffset + index)) return true;
    }
    outputOffset += match.replacement.length;
    sourceOffset = match.index + match.length;
  }
  const unchangedLength = content.length - sourceOffset;
  if (sourceOffset !== outputOffset) {
    for (let index = 0; index < unchangedLength; index++) {
      if (content.charCodeAt(sourceOffset + index) !== content.charCodeAt(outputOffset + index)) return true;
    }
  }
  return outputOffset + unchangedLength !== content.length;
}

function tryPlanExactEdits(
  content: string,
  input: EditToolInput,
  contentIsAscii = false,
): ExactEditPlan | undefined {
  if (!Array.isArray(input.edits) || input.edits.length === 0) return undefined;
  if (!contentIsAscii && !isFuzzyNormalizationNeutral(content)) return undefined;

  const matches: Array<{
    index: number;
    length: number;
    replacement: string;
    firstLine?: number;
    lastLine?: number;
  }> = [];
  for (const edit of input.edits) {
    const oldText = normalizeToLf(edit.oldText);
    const newText = normalizeToLf(edit.newText);
    if (oldText.length === 0 || !isFuzzyNormalizationNeutral(oldText)) return undefined;

    const index = content.indexOf(oldText);
    if (index === -1 || content.indexOf(oldText, index + 1) !== -1) return undefined;
    matches.push({ index, length: oldText.length, replacement: newText });
  }

  matches.sort((left, right) => left.index - right.index);
  if (!plannedEditsProduceChange(content, matches)) return undefined;

  let currentLine = 0;
  let lineScanOffset = 0;
  for (let index = 0; index < matches.length; index++) {
    const current = matches[index]!;
    const previous = matches[index - 1];
    if (previous && previous.index + previous.length > current.index) return undefined;

    let newline = content.indexOf("\n", lineScanOffset);
    while (newline !== -1 && newline < current.index) {
      if (contentIsAscii && isAsciiWhitespaceExceptLf(content.charCodeAt(newline - 1))) return undefined;
      currentLine++;
      lineScanOffset = newline + 1;
      newline = content.indexOf("\n", lineScanOffset);
    }
    current.firstLine = currentLine;
    const finalMatchedIndex = current.index + current.length - 1;
    while (newline !== -1 && newline < finalMatchedIndex) {
      if (contentIsAscii && isAsciiWhitespaceExceptLf(content.charCodeAt(newline - 1))) return undefined;
      currentLine++;
      lineScanOffset = newline + 1;
      newline = content.indexOf("\n", lineScanOffset);
    }
    current.lastLine = currentLine;
  }
  let remainingNewline = content.indexOf("\n", lineScanOffset);
  while (remainingNewline !== -1) {
    if (contentIsAscii && isAsciiWhitespaceExceptLf(content.charCodeAt(remainingNewline - 1))) return undefined;
    currentLine++;
    lineScanOffset = remainingNewline + 1;
    remainingNewline = content.indexOf("\n", lineScanOffset);
  }

  if (
    contentIsAscii &&
    !content.endsWith("\n") &&
    isAsciiWhitespaceExceptLf(content.charCodeAt(content.length - 1))
  ) {
    return undefined;
  }
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

function selectExactEditPlan(
  rawBytes: Buffer,
  bom: string,
  normalizedContent: string,
  input: EditToolInput,
  contentIsAscii: boolean,
  attemptedNativePlan?: NativePlanningAttempt,
): { plan: ExactEditPlan; nativePlan?: NativeExactEditPlan } | undefined {
  const bomByteLength = Buffer.byteLength(bom);
  const nativeAttempt =
    attemptedNativePlan ?? tryNativeAsciiPlan(rawBytes.subarray(bomByteLength), input, bomByteLength);
  if (nativeAttempt.status === "planned") {
    return { plan: nativeAttempt.plan, nativePlan: nativeAttempt.plan };
  }
  if (nativeAttempt.status === "declined") return undefined;
  const plan = tryPlanExactEdits(normalizedContent, input, contentIsAscii);
  return plan && { plan };
}

function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function buildSparseWritePlan(
  rawBytes: Buffer,
  content: string,
  normalizedContent: string,
  bom: string,
  replacements: readonly SparseReplacement[],
): { positionalWrites?: PositionalWrite[]; suffixWrite?: SuffixWrite } {
  if (!isUtf8(rawBytes) || content !== normalizedContent) return {};
  const writes: PositionalWrite[] = [];
  let suffixWrite: SuffixWrite | undefined;
  let equalByteLengths = true;
  let searchOffset = Buffer.byteLength(bom);
  for (let index = 0; index < replacements.length; index++) {
    const replacement = replacements[index]!;
    const oldText = content.slice(
      replacement.matchIndex,
      replacement.matchIndex + replacement.matchLength,
    );
    if (!isWellFormedUtf16(oldText) || !isWellFormedUtf16(replacement.newText)) return {};
    const oldBytes = Buffer.from(oldText);
    const newBytes = Buffer.from(replacement.newText);
    const position = rawBytes.indexOf(oldBytes, searchOffset);
    if (position === -1) return {};
    if (oldText !== replacement.newText) {
      suffixWrite ??= { position, contentOffset: replacement.matchIndex, replacementIndex: index };
      if (oldBytes.length === newBytes.length) writes.push({ position, bytes: newBytes });
      else equalByteLengths = false;
    }
    searchOffset = position + oldBytes.length;
  }
  return equalByteLengths ? { positionalWrites: writes } : { suffixWrite };
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

function applyPlannedEdits(
  content: string,
  replacements: readonly SparseReplacement[],
  baseOffset = 0,
): string {
  const parts: string[] = [];
  let contentOffset = 0;
  for (const replacement of replacements) {
    const matchIndex = replacement.matchIndex - baseOffset;
    parts.push(content.slice(contentOffset, matchIndex), replacement.newText);
    contentOffset = matchIndex + replacement.matchLength;
  }
  parts.push(content.slice(contentOffset));
  return parts.join("");
}

export function tryApplyExactEdits(content: string, input: EditToolInput): string | undefined {
  const plan = tryPlanExactEdits(content, input);
  return plan && applyPlannedEdits(content, plan.replacements);
}

export async function tryPrefetchExactEditFile(
  path: string,
  cwd: string,
): Promise<PrefetchedExactEditFile | undefined> {
  const absolutePath = getExactEditPathKey(path, cwd);
  if (!absolutePath) return undefined;
  try {
    await access(absolutePath, constants.R_OK);
    return { absolutePath, rawBytes: await readFile(absolutePath) };
  } catch {
    return undefined;
  }
}

function hasUtf8Bom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function materializePreparedContent(prepared: PreparedExactEdit): string {
  if (prepared.normalizedContent !== undefined) return prepared.normalizedContent;
  const rawContent = prepared.rawBytes.toString("utf8");
  const content = prepared.bom ? rawContent.slice(1) : rawContent;
  return normalizeToLf(content);
}

export async function tryPrepareExactEdit(
  input: EditToolInput,
  cwd: string,
  prefetched?: PrefetchedExactEditFile,
): Promise<PreparedExactEdit | undefined> {
  const inputKey = getExactEditInputKey(input, cwd);
  if (!inputKey) return undefined;
  const absolutePath = resolveOrdinaryPath(input.path, cwd)!;
  try {
    let rawBytes: Buffer;
    if (prefetched?.absolutePath === absolutePath) rawBytes = prefetched.rawBytes;
    else {
      await access(absolutePath, constants.R_OK);
      rawBytes = await readFile(absolutePath);
    }
    const bom = hasUtf8Bom(rawBytes) ? "\uFEFF" : "";
    const bomByteLength = Buffer.byteLength(bom);
    const nativeAttempt = tryNativeAsciiPlan(rawBytes.subarray(bomByteLength), input, bomByteLength);
    if (nativeAttempt.status === "planned" && nativeAttempt.plan.diffWindows) {
      const nativeDetails = buildSparseDiffsFromWindows(
        input.path,
        nativeAttempt.plan.diffWindows.map((window) => ({
          oldStartLine: window.oldStartLine,
          oldContent: window.oldBytes.toString("utf8"),
          newContent: window.newBytes.toString("utf8"),
          hasEarlierContent: window.hasEarlierContent,
          hasLaterContent: window.hasLaterContent,
        })),
        nativeAttempt.plan.oldLineCount,
        nativeAttempt.plan.oldEndsWithNewline,
      );
      if (nativeDetails) {
        return {
          absolutePath,
          inputKey,
          rawBytes,
          bom,
          lineEnding: "\n",
          replacements: nativeAttempt.plan.replacements,
          prefetched: prefetched?.absolutePath === absolutePath,
          positionalWrites: nativeAttempt.plan.positionalWrites,
          suffixWrite: nativeAttempt.plan.suffixWrite,
          result: {
            content: [
              { type: "text", text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` },
            ],
            details: nativeDetails,
          },
        };
      }
    }

    const rawContent = rawBytes.toString("utf8");
    const content = bom ? rawContent.slice(1) : rawContent;
    const lineEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLf(content);
    const contentIsAscii = isAscii(rawBytes.subarray(bomByteLength));
    const selectedPlan = selectExactEditPlan(
      rawBytes,
      bom,
      normalizedContent,
      input,
      contentIsAscii,
      nativeAttempt,
    );
    if (!selectedPlan) return undefined;
    const { plan } = selectedPlan;
    const details = buildSparseDiffs(
      input.path,
      normalizedContent,
      plan.replacements,
      plan.oldLineCount,
    );
    if (!details) return undefined;
    const sparseWritePlan = selectedPlan.nativePlan
      ? {
          positionalWrites: selectedPlan.nativePlan.positionalWrites,
          suffixWrite: selectedPlan.nativePlan.suffixWrite,
        }
      : buildSparseWritePlan(
          rawBytes,
          content,
          normalizedContent,
          bom,
          plan.replacements,
        );
    return {
      absolutePath,
      inputKey,
      rawBytes,
      bom,
      lineEnding,
      normalizedContent,
      replacements: plan.replacements,
      prefetched: prefetched?.absolutePath === absolutePath,
      ...sparseWritePlan,
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
  onAcceleratedFileSize?: (bytes: number) => void,
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
    if (preparedMatchesInput && (prepared.positionalWrites || prepared.suffixWrite)) {
      const handle = await open(absolutePath, "r+");
      try {
        rawBytes = await handle.readFile();
        if (prepared.rawBytes.equals(rawBytes)) {
          if (signal?.aborted) throw new Error("Operation aborted");
          if (prepared.positionalWrites) await applyPositionalWrites(handle, prepared.positionalWrites);
          else {
            const suffixWrite = prepared.suffixWrite!;
            const suffixContent = materializePreparedContent(prepared).slice(suffixWrite.contentOffset);
            const suffix = applyPlannedEdits(
              suffixContent,
              prepared.replacements.slice(suffixWrite.replacementIndex),
              suffixWrite.contentOffset,
            );
            const suffixBytes = Buffer.from(suffix);
            await applyPositionalWrites(handle, [{ position: suffixWrite.position, bytes: suffixBytes }]);
            await handle.truncate(suffixWrite.position + suffixBytes.length);
          }
          if (signal?.aborted) throw new Error("Operation aborted");
          onAcceleratedFileSize?.(rawBytes.length);
          return prepared.result;
        }
      } finally {
        await handle.close();
      }
    } else {
      rawBytes = await readFile(absolutePath);
      if (preparedMatchesInput && prepared?.rawBytes.equals(rawBytes)) {
        if (signal?.aborted) throw new Error("Operation aborted");
        const newContent = applyPlannedEdits(materializePreparedContent(prepared), prepared.replacements);
        await writeFile(
          absolutePath,
          prepared.bom + restoreLineEndings(newContent, prepared.lineEnding),
          "utf8",
        );
        if (signal?.aborted) throw new Error("Operation aborted");
        onAcceleratedFileSize?.(rawBytes.length);
        return prepared.result;
      }
    }

    const rawContent = rawBytes.toString("utf8");
    const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : "";
    const content = bom ? rawContent.slice(1) : rawContent;
    const lineEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLf(content);
    const contentIsAscii = isAscii(rawBytes.subarray(Buffer.byteLength(bom)));
    const selectedPlan = selectExactEditPlan(rawBytes, bom, normalizedContent, input, contentIsAscii);
    if (!selectedPlan) return undefined;
    const { plan } = selectedPlan;

    const sparseDiffs = buildSparseDiffs(
      input.path,
      normalizedContent,
      plan.replacements,
      plan.oldLineCount,
    );
    if (!sparseDiffs) return undefined;
    const newContent = applyPlannedEdits(normalizedContent, plan.replacements);
    if (signal?.aborted) throw new Error("Operation aborted");
    await writeFile(absolutePath, bom + restoreLineEndings(newContent, lineEnding), "utf8");
    if (signal?.aborted) throw new Error("Operation aborted");

    onAcceleratedFileSize?.(rawBytes.length);
    return {
      content: [{ type: "text", text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` }],
      details: sparseDiffs,
    };
  });
}
