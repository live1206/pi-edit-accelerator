import * as Diff from "diff";

export interface LineReplacement {
  lineIndex: number;
  oldText: string;
  newText: string;
}

export interface SparseDiffResult {
  diff: string;
  patch: string;
  firstChangedLine: number;
}

interface ReplacementGroup {
  firstLine: number;
  lastLine: number;
  replacements: LineReplacement[];
}

function groupReplacements(replacements: readonly LineReplacement[], contextLines: number): ReplacementGroup[] {
  const groups: ReplacementGroup[] = [];
  for (const replacement of replacements) {
    const current = groups[groups.length - 1];
    if (current && replacement.lineIndex - current.lastLine <= contextLines * 2 + 1) {
      current.lastLine = replacement.lineIndex;
      current.replacements.push(replacement);
    } else {
      groups.push({
        firstLine: replacement.lineIndex,
        lastLine: replacement.lineIndex,
        replacements: [replacement],
      });
    }
  }
  return groups;
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

export function buildSparseLineDiffs(
  path: string,
  oldContent: string,
  newContent: string,
  replacements: readonly LineReplacement[],
  contextLines = 4,
): SparseDiffResult {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const groups = groupReplacements(replacements, contextLines);
  const hunks: Diff.StructuredPatchHunk[] = [];
  let cumulativeLineDelta = 0;

  for (const group of groups) {
    const segmentStart = Math.max(0, group.firstLine - contextLines);
    const segmentEnd = Math.min(oldLines.length, group.lastLine + contextLines + 1);
    const oldSegmentLines = oldLines.slice(segmentStart, segmentEnd);
    const newSegmentLines = [...oldSegmentLines];
    for (const replacement of group.replacements) {
      newSegmentLines[replacement.lineIndex - segmentStart] = replacement.newText;
    }

    const oldSegment = oldSegmentLines.join("\n") + (segmentEnd < oldLines.length ? "\n" : "");
    const newSegment = newSegmentLines.join("\n") + (segmentEnd < oldLines.length ? "\n" : "");
    const local = Diff.structuredPatch(path, path, oldSegment, newSegment, undefined, undefined, {
      context: contextLines,
    });
    for (const hunk of local.hunks) {
      hunks.push({
        ...hunk,
        oldStart: hunk.oldStart + segmentStart,
        newStart: hunk.newStart + segmentStart + cumulativeLineDelta,
      });
    }
    cumulativeLineDelta += newSegmentLines.length - oldSegmentLines.length;
  }

  const patch = Diff.formatPatch(
    { oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks },
    Diff.FILE_HEADERS_ONLY,
  );
  const displayedOldLineCount = oldContent.endsWith("\n") ? oldLines.length - 1 : oldLines.length;
  const display = buildDisplayDiff(hunks, displayedOldLineCount, Math.max(oldLines.length, newLines.length));
  return { diff: display.diff, patch, firstChangedLine: display.firstChangedLine };
}
