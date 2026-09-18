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
  if (matchIndex === 0) return 0;
  let start = content.lastIndexOf("\n", matchIndex - 1) + 1;
  for (let count = 0; count < contextLines && start > 0; count++) {
    if (start === 1) return 0;
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

function needsExpandedContext(
  hunks: readonly Diff.StructuredPatchHunk[],
  contextLines: number,
  hasEarlierContent: boolean,
  hasLaterContent: boolean,
): boolean {
  if (hunks.length === 0) return false;
  const firstLines = hunks[0]!.lines.filter((line) => line !== "\\ No newline at end of file");
  const lastLines = hunks[hunks.length - 1]!.lines.filter((line) => line !== "\\ No newline at end of file");
  const firstChange = firstLines.findIndex((line) => line[0] === "+" || line[0] === "-");
  let lastChange = -1;
  for (let index = lastLines.length - 1; index >= 0; index--) {
    if (lastLines[index]![0] === "+" || lastLines[index]![0] === "-") {
      lastChange = index;
      break;
    }
  }
  return (
    (hasEarlierContent && firstChange < contextLines) ||
    (hasLaterContent && lastLines.length - lastChange - 1 < contextLines)
  );
}

function buildGroupHunks(
  path: string,
  oldContent: string,
  group: ReplacementGroup,
  contextLines: number,
): Diff.StructuredPatchHunk[] {
  const firstReplacement = group.replacements[0]!;
  const lastReplacement = group.replacements[group.replacements.length - 1]!;
  let windowContext = contextLines;
  while (true) {
    const segmentStartLine = Math.max(0, group.firstLine - windowContext);
    const segmentStartOffset = findSegmentStart(oldContent, firstReplacement.matchIndex, windowContext);
    const segmentEndOffset = findSegmentEnd(
      oldContent,
      lastReplacement.matchIndex + lastReplacement.matchLength,
      windowContext,
    );
    const oldSegment = oldContent.slice(segmentStartOffset, segmentEndOffset);
    const newSegment = applyReplacements(oldSegment, group.replacements, segmentStartOffset);
    const local = Diff.structuredPatch(path, path, oldSegment, newSegment, undefined, undefined, {
      context: contextLines,
    });
    if (
      !needsExpandedContext(
        local.hunks,
        contextLines,
        segmentStartOffset > 0,
        segmentEndOffset < oldContent.length,
      )
    ) {
      return local.hunks.map((hunk) => ({
        ...hunk,
        oldStart: hunk.oldStart + segmentStartLine,
        newStart: hunk.newStart + segmentStartLine,
      }));
    }
    windowContext *= 2;
  }
}

function combineGroups(left: ReplacementGroup, right: ReplacementGroup): ReplacementGroup {
  return {
    firstLine: left.firstLine,
    lastLine: right.lastLine,
    replacements: [...left.replacements, ...right.replacements],
  };
}

function prepareGroupHunks(
  path: string,
  oldContent: string,
  groups: readonly ReplacementGroup[],
  contextLines: number,
): Array<{ group: ReplacementGroup; hunks: Diff.StructuredPatchHunk[] }> | undefined {
  const initial = groups.map((group) => ({
    group,
    hunks: buildGroupHunks(path, oldContent, group, contextLines),
  }));

  for (let index = 1; index < initial.length; index++) {
    const previousHunks = initial[index - 1]!.hunks;
    const currentHunks = initial[index]!.hunks;
    const previousHunk = previousHunks[previousHunks.length - 1];
    const currentHunk = currentHunks[0];
    if (
      previousHunk &&
      currentHunk &&
      currentHunk.oldStart <= previousHunk.oldStart + previousHunk.oldLines
    ) {
      return undefined;
    }
  }

  const hasStructuralReplacement = groups.some((group) =>
    group.replacements.some((replacement) => {
      const oldText = oldContent.slice(
        replacement.matchIndex,
        replacement.matchIndex + replacement.matchLength,
      );
      return oldText.includes("\n") || replacement.newText.includes("\n");
    }),
  );
  if (groups.length > 1 && hasStructuralReplacement) {
    const combined = groups.slice(1).reduce(
      (group, current) => combineGroups(group, current),
      groups[0]!,
    );
    return [{ group: combined, hunks: buildGroupHunks(path, oldContent, combined, contextLines) }];
  }
  return initial;
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
  replacements: readonly SparseReplacement[],
  oldLineCount: number,
  contextLines = 4,
): SparseDiffResult | undefined {
  const groups = prepareGroupHunks(
    path,
    oldContent,
    groupReplacements(replacements, contextLines),
    contextLines,
  );
  if (!groups) return undefined;
  const hunks: Diff.StructuredPatchHunk[] = [];
  let cumulativeLineDelta = 0;

  for (const { group, hunks: groupHunks } of groups) {
    const adjustedHunks = groupHunks.map((hunk) => ({
      ...hunk,
      newStart: hunk.newStart + cumulativeLineDelta,
    }));
    const previousHunk = hunks[hunks.length - 1];
    const firstAdjustedHunk = adjustedHunks[0];
    if (
      previousHunk &&
      firstAdjustedHunk &&
      firstAdjustedHunk.oldStart <= previousHunk.oldStart + previousHunk.oldLines
    ) {
      return undefined;
    }
    hunks.push(...adjustedHunks);
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
