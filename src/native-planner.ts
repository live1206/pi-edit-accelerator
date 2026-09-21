import { isAscii } from "node:buffer";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import type { SparseReplacement } from "./sparse-diff.ts";

interface NativeEdit {
  oldText: string;
  newText: string;
}

interface NativeReplacement {
  byteOffset: number;
  oldByteLength: number;
  newText: string;
  firstLine: number;
  lastLine: number;
}

interface NativePositionalWrite {
  position: number;
  bytes: Buffer;
}

interface NativeDiffWindow {
  oldStartLine: number;
  oldBytes: Buffer;
  newBytes: Buffer;
  hasEarlierContent: boolean;
  hasLaterContent: boolean;
}

interface NativePlan {
  oldLineCount: number;
  oldEndsWithNewline: boolean;
  replacements: NativeReplacement[];
  positionalWrites?: NativePositionalWrite[];
  suffixWrite?: { position: number; replacementIndex: number };
  suffixBytes?: Buffer;
  diffWindows?: NativeDiffWindow[];
}

interface NativeBinding {
  planAsciiEdits(content: Buffer, edits: NativeEdit[]): NativePlan | undefined;
  prepareAsciiExecution(content: Buffer, edits: NativeEdit[]): NativePlan | undefined;
  assembleAsciiSuffix(
    content: Buffer,
    replacements: NativeReplacement[],
    position: number,
    replacementIndex: number,
  ): Buffer | undefined;
}

export interface NativeExactEditPlan {
  oldLineCount: number;
  oldEndsWithNewline: boolean;
  replacements: SparseReplacement[];
  positionalWrites?: NativePositionalWrite[];
  suffixWrite?: { position: number; contentOffset: number; replacementIndex: number };
  suffixBytes?: Buffer;
  diffWindows?: NativeDiffWindow[];
}

export type NativePlanningAttempt =
  | { status: "not-used" }
  | { status: "declined" }
  | { status: "planned"; plan: NativeExactEditPlan };

export interface NativeBackendStatsSnapshot {
  nativeHits: number;
  planningAttempts: number;
  plannedCalls: number;
  unsupportedInputs: number;
  nativeDeclines: number;
  loadFailures: number;
  invocationFailures: number;
  disabledFallbacks: number;
  typeScriptFallbacks: number;
}

type LoaderState =
  | { status: "uninitialized" }
  | { status: "loaded"; binding: NativeBinding }
  | { status: "disabled" };

let loaderState: LoaderState = { status: "uninitialized" };
let nativeStats: NativeBackendStatsSnapshot = emptyNativeBackendStats();
const require = createRequire(import.meta.url);

function emptyNativeBackendStats(): NativeBackendStatsSnapshot {
  return {
    nativeHits: 0,
    planningAttempts: 0,
    plannedCalls: 0,
    unsupportedInputs: 0,
    nativeDeclines: 0,
    loadFailures: 0,
    invocationFailures: 0,
    disabledFallbacks: 0,
    typeScriptFallbacks: 0,
  };
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isAsciiString(text: string): boolean {
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) return false;
  return true;
}

function nativeTarget(): { fileName: string; packageName: string } | undefined {
  if (process.platform === "linux" && process.arch === "x64") {
    return {
      fileName: "pi-edit-accelerator-native.linux-x64-gnu.node",
      packageName: "@live1206/pi-edit-accelerator-linux-x64-gnu",
    };
  }
  return undefined;
}

function loadNativeBinding(): NativeBinding | undefined {
  if (loaderState.status === "loaded") return loaderState.binding;
  if (loaderState.status === "disabled" || process.env.PI_EDIT_ACCELERATOR_NATIVE === "0") return undefined;
  const target = nativeTarget();
  if (!target) {
    loaderState = { status: "disabled" };
    return undefined;
  }
  try {
    let binding: NativeBinding;
    const configuredPath = process.env.PI_EDIT_ACCELERATOR_NATIVE_PATH;
    if (configuredPath) binding = require(configuredPath) as NativeBinding;
    else {
      try {
        binding = require(target.packageName) as NativeBinding;
      } catch {
        const localPath = resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../native",
          target.fileName,
        );
        binding = require(localPath) as NativeBinding;
      }
    }
    if (
      typeof binding?.planAsciiEdits !== "function" ||
      typeof binding.prepareAsciiExecution !== "function" ||
      typeof binding.assembleAsciiSuffix !== "function"
    ) {
      throw new Error("Native planner exports are incomplete");
    }
    loaderState = { status: "loaded", binding };
    return binding;
  } catch {
    nativeStats.loadFailures++;
    loaderState = { status: "disabled" };
    return undefined;
  }
}

function normalizedAsciiEdits(input: EditToolInput): NativeEdit[] | undefined {
  if (!Array.isArray(input.edits) || input.edits.length === 0) return undefined;
  const edits: NativeEdit[] = [];
  for (const edit of input.edits) {
    if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") return undefined;
    const oldText = normalizeToLf(edit.oldText);
    const newText = normalizeToLf(edit.newText);
    if (!isAsciiString(oldText) || !isAsciiString(newText)) return undefined;
    edits.push({ oldText, newText });
  }
  return edits;
}

function convertNativePlan(nativePlan: NativePlan, rawOffset: number): NativeExactEditPlan {
  const replacements: SparseReplacement[] = nativePlan.replacements.map((replacement) => ({
    matchIndex: replacement.byteOffset,
    matchLength: replacement.oldByteLength,
    newText: replacement.newText,
    firstLine: replacement.firstLine,
    lastLine: replacement.lastLine,
  }));
  return {
    oldLineCount: nativePlan.oldLineCount,
    oldEndsWithNewline: nativePlan.oldEndsWithNewline,
    replacements,
    positionalWrites: nativePlan.positionalWrites?.map((write) => ({
      position: write.position + rawOffset,
      bytes: write.bytes,
    })),
    suffixWrite: nativePlan.suffixWrite && {
      position: nativePlan.suffixWrite.position + rawOffset,
      contentOffset: nativePlan.suffixWrite.position,
      replacementIndex: nativePlan.suffixWrite.replacementIndex,
    },
    suffixBytes: nativePlan.suffixBytes,
    diffWindows: nativePlan.diffWindows,
  };
}

function tryNativePlan(
  contentBytes: Buffer,
  input: EditToolInput,
  rawOffset: number,
  mode: "preview" | "execution",
): NativePlanningAttempt {
  if (contentBytes.length > 0xffff_ffff || !isAscii(contentBytes) || contentBytes.includes(13)) {
    nativeStats.unsupportedInputs++;
    return { status: "not-used" };
  }
  const edits = normalizedAsciiEdits(input);
  if (!edits) {
    nativeStats.unsupportedInputs++;
    return { status: "not-used" };
  }
  if (loaderState.status === "disabled") nativeStats.disabledFallbacks++;
  const binding = loadNativeBinding();
  if (!binding) return { status: "not-used" };
  try {
    nativeStats.planningAttempts++;
    const nativePlan =
      mode === "preview"
        ? binding.planAsciiEdits(contentBytes, edits)
        : binding.prepareAsciiExecution(contentBytes, edits);
    if (!nativePlan) {
      nativeStats.nativeDeclines++;
      return { status: "declined" };
    }
    if (
      (mode === "preview" && nativePlan.suffixBytes !== undefined) ||
      (mode === "execution" && nativePlan.suffixWrite !== undefined && nativePlan.suffixBytes === undefined)
    ) {
      throw new Error("Native planner returned an invalid suffix contract");
    }
    nativeStats.nativeHits++;
    nativeStats.plannedCalls++;
    return { status: "planned", plan: convertNativePlan(nativePlan, rawOffset) };
  } catch {
    nativeStats.invocationFailures++;
    loaderState = { status: "disabled" };
    return { status: "not-used" };
  }
}

export function tryNativeAsciiPlan(
  contentBytes: Buffer,
  input: EditToolInput,
  rawOffset = 0,
): NativePlanningAttempt {
  return tryNativePlan(contentBytes, input, rawOffset, "preview");
}

export function tryNativeAsciiExecutionPlan(
  contentBytes: Buffer,
  input: EditToolInput,
  rawOffset = 0,
): NativePlanningAttempt {
  return tryNativePlan(contentBytes, input, rawOffset, "execution");
}

export function tryNativeAsciiSuffix(
  contentBytes: Buffer,
  replacements: readonly SparseReplacement[],
  position: number,
  replacementIndex: number,
): Buffer | undefined {
  if (loaderState.status === "disabled") nativeStats.disabledFallbacks++;
  const binding = loadNativeBinding();
  if (!binding) return undefined;
  try {
    const suffix = binding.assembleAsciiSuffix(
      contentBytes,
      replacements.map((replacement) => ({
        byteOffset: replacement.matchIndex,
        oldByteLength: replacement.matchLength,
        newText: replacement.newText,
        firstLine: replacement.firstLine,
        lastLine: replacement.lastLine,
      })),
      position,
      replacementIndex,
    );
    if (!suffix) {
      nativeStats.invocationFailures++;
      loaderState = { status: "disabled" };
      return undefined;
    }
    nativeStats.nativeHits++;
    return suffix;
  } catch {
    nativeStats.invocationFailures++;
    loaderState = { status: "disabled" };
    return undefined;
  }
}

export function recordNativeTypeScriptFallback(): void {
  nativeStats.typeScriptFallbacks++;
}

export function getNativeBackendStats(): NativeBackendStatsSnapshot {
  return { ...nativeStats };
}

export function resetNativeBackendStats(): void {
  nativeStats = emptyNativeBackendStats();
}

export function formatNativeBackendStats(snapshot: NativeBackendStatsSnapshot): string {
  return [
    `Native operations: ${snapshot.nativeHits}`,
    `Native planning attempts: ${snapshot.planningAttempts}`,
    `Native planned calls: ${snapshot.plannedCalls}`,
    `Native unsupported inputs: ${snapshot.unsupportedInputs}`,
    `Native declines: ${snapshot.nativeDeclines}`,
    `Native load failures: ${snapshot.loadFailures}`,
    `Native invocation failures: ${snapshot.invocationFailures}`,
    `Native disabled fallbacks: ${snapshot.disabledFallbacks}`,
    `TypeScript accelerator fallbacks: ${snapshot.typeScriptFallbacks}`,
  ].join("\n");
}

export function getNativePlannerStatus(): "uninitialized" | "loaded" | "disabled" {
  return loaderState.status;
}

export function resetNativePlannerForTests(): void {
  loaderState = { status: "uninitialized" };
  resetNativeBackendStats();
}
