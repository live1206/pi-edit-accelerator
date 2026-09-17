import * as Diff from "diff";

export interface SparseReplacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
  firstLine: number;
  lastLine: number;
}

export interface SparseDiffResult {
  diff: string;
  patch: string;
  firstChangedLine: number;
}

interface ReplacementGroup {
  firstLine: number;
  lastLine: number;
  replacements: SparseReplacement[];
}

function findSegmentStart(content: string, matchIndex: number, contextLines: number): number {
  let start = content.lastIndexOf("\n", matchIndex - 1) + 1;
  for (let count = 0; count < contextLines && start > 0; count++) {
    start = content.lastIndexOf("\n", start - 2) + 1;
  }
  return start;
}

function findSegmentEnd(content: string, matchEnd: number, contextLines: number): number {
  let newline = content.indexOf("\n", matchEnd);
  let end = newline === -1 ? content.length : newline + 1;
  for (let count = 0; count < contextLines && end < content.length; count++) {
    newline = content.indexOf("\n", end);
    end = newline === -1 ? content.length : newline + 1;
  }
  return end;
}

function groupReplacements(replacements: readonly SparseReplacement[], contextLines: number): ReplacementGroup[] {
  const groups: ReplacementGroup[] = [];
  for (const replacement of replacements) {
    const current = groups[groups.length - 1];
    if (current && replacement.firstLine - current.lastLine <= contextLines * 2 + 1) {
      current.lastLine = Math.max(current.lastLine, replacement.lastLine);
      current.replacements.push(replacement);
    } else {
      groups.push({
        firstLine: replacement.firstLine,
        lastLine: replacement.lastLine,
        replacements: [replacement],
      });
    }
  }
  return groups;
}

function applyReplacements(content: string, replacements: readonly SparseReplacement[], offset: number): string {
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index]!;
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.slice(0, matchIndex) +
      replacement.newText +
      result.slice(matchIndex + replacement.matchLength);
  }
  return result;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++;
  return count;
}

function buildDisplayDiff(
  hunks: readonly Diff.StructuredPatchHunk[],
  oldLineCount: number,
  maxLineNumber: number,
): { diff: string; firstChangedLine: number } {
  const width = String(maxLineNumber).length;
  const output: string[] = [];
  let firstChangedLine: number | undefined;
  let previousOldEnd = 0;

  for (const hunk of hunks) {
    if (hunk.oldStart > previousOldEnd + 1) output.push(` ${"".padStart(width)} ...`);
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line === "\\ No newline at end of file") continue;
      const marker = line[0]!;
      const text = line.slice(1);
      if (marker === "+") {
        firstChangedLine ??= newLine;
        output.push(`+${String(newLine).padStart(width)} ${text}`);
        newLine++;
      } else if (marker === "-") {
        firstChangedLine ??= newLine;
        output.push(`-${String(oldLine).padStart(width)} ${text}`);
        oldLine++;
      } else {
        output.push(` ${String(oldLine).padStart(width)} ${text}`);
        oldLine++;
        newLine++;
      }
    }
    previousOldEnd = hunk.oldStart + hunk.oldLines - 1;
  }

  if (previousOldEnd < oldLineCount) output.push(` ${"".padStart(width)} ...`);
  return { diff: output.join("\n"), firstChangedLine: firstChangedLine ?? 1 };
}

export function buildSparseDiffs(
  path: string,
  oldContent: string,
  newContent: string,
  replacements: readonly SparseReplacement[],
  oldLineCount: number,
  contextLines = 4,
): SparseDiffResult {
  const groups = groupReplacements(replacements, contextLines);
  const hunks: Diff.StructuredPatchHunk[] = [];
  let cumulativeLineDelta = 0;

  for (const group of groups) {
    const segmentStartLine = Math.max(0, group.firstLine - contextLines);
    const firstReplacement = group.replacements[0]!;
    const lastReplacement = group.replacements[group.replacements.length - 1]!;
    const segmentStartOffset = findSegmentStart(oldContent, firstReplacement.matchIndex, contextLines);
    const segmentEndOffset = findSegmentEnd(
      oldContent,
      lastReplacement.matchIndex + lastReplacement.matchLength,
      contextLines,
    );
    const oldSegment = oldContent.slice(segmentStartOffset, segmentEndOffset);
    const newSegment = applyReplacements(oldSegment, group.replacements, segmentStartOffset);
    const local = Diff.structuredPatch(path, path, oldSegment, newSegment, undefined, undefined, {
      context: contextLines,
    });
    for (const hunk of local.hunks) {
      hunks.push({
        ...hunk,
        oldStart: hunk.oldStart + segmentStartLine,
        newStart: hunk.newStart + segmentStartLine + cumulativeLineDelta,
      });
    }
    for (const replacement of group.replacements) {
      const oldText = oldContent.slice(replacement.matchIndex, replacement.matchIndex + replacement.matchLength);
      cumulativeLineDelta += countNewlines(replacement.newText) - countNewlines(oldText);
    }
  }

  const patch = Diff.formatPatch(
    { oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks },
    Diff.FILE_HEADERS_ONLY,
  );
  const newLineCount = oldLineCount + cumulativeLineDelta;
  const displayedOldLineCount = oldContent.endsWith("\n") ? oldLineCount - 1 : oldLineCount;
  const display = buildDisplayDiff(hunks, displayedOldLineCount, Math.max(oldLineCount, newLineCount));
  return { diff: display.diff, patch, firstChangedLine: display.firstChangedLine };
}
