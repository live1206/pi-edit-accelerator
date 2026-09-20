# Edit acceleration implementation

## Goal

Reduce Pi edit latency without modifying Pi core or replacing behavior that the extension cannot reproduce exactly.

The extension uses only the released public API from `@earendil-works/pi-coding-agent`. It captures a built-in edit definition, registers one replacement tool named `edit`, accelerates supported exact edits, and calls the captured built-in implementation for unsupported cases.

## Architecture

```text
model calls edit
  -> extension edit wrapper
     -> supported exact input
        -> sparse TypeScript execution
        -> sparse interactive preview
     -> unsupported or fuzzy input
        -> captured builtInEdit.execute()
        -> captured built-in preview renderer
```

Pi exposes one `edit` tool. Fallback is a direct call to the retained built-in tool object; it is not a second registry lookup.

The wrapper is created from:

```ts
const builtInEdit = createEditToolDefinition(process.cwd());
```

Spreading that definition preserves the installed Pi version's schema, argument preparation, prompt metadata, and result renderer.

## Implemented fast path

The TypeScript sparse backend currently supports normalization-neutral, globally unique exact replacements, including:

- whole-line replacements
- partial-line replacements
- multiline replacements
- line insertion and deletion
- multiple changes on one line
- multiple distant changes
- nearby changes whose context merges
- cumulative line-number shifts between hunks
- LF and CRLF files
- UTF-8 BOM preservation
- files with or without a trailing newline
- multibyte UTF-8 text

It matches all edits against the original content, validates uniqueness and overlap, assembles the replacement result in one forward pass, and generates only the affected diff regions plus context.

## Built-in fallback

The extension delegates to Pi's captured built-in edit implementation when fast-path compatibility is not proven. Examples include:

- fuzzy quote, dash, whitespace, or Unicode normalization
- duplicate matches
- overlapping edits
- unsupported or malformed input
- special path forms handled by Pi, including Unicode spaces normalized by Pi
- replacement sets whose combined output is unchanged
- inaccessible files

Fallback preserves Pi's current errors and behavior. The fast path does not mutate a file before deciding whether it is supported.

## Sparse diff generation

Pi's built-in path computes two general full-file diffs after applying replacements:

- display-oriented diff
- standard unified patch

The extension already knows the exact replacement offsets. It groups affected line ranges, adds four lines of context, expands ambiguous repeated-line boundaries until alignment stabilizes, and adjusts later hunk coordinates for inserted or removed lines. Multiple structural groups—those spanning or producing line boundaries—are recomputed together once without a distance cutoff. Line-local groups retain independent sparse hunks. If independently expanded groups overlap or become adjacent before shared recomputation, the extension delegates to Pi rather than concatenate an invalid patch. Otherwise it formats:

- the display diff used by Pi's edit renderer
- the complete unified patch
- `firstChangedLine`

Compatibility tests compare all three outputs against Pi's public built-in helpers.

## Interactive preview

The built-in edit renderer normally rereads and diffs the complete file before execution. Candidate C computes the same sparse result asynchronously and feeds it into Pi's built-in renderer, retaining the normal presentation.

Once a complete path and an edits array appear during argument streaming, the extension schedules a debounced file prefetch. Path changes cancel an unstarted read, while argument completion starts it immediately. This overlaps file I/O with the remaining model output without delaying execution.

Execution shares the resulting in-flight exact-preview plan when the resolved path and complete edit input match. It still rereads the file under Pi's mutation queue and reuses the plan only when the file bytes exactly match the preview input. A changed file is replanned from its current content. Prepared plans expire after 60 seconds and only one plan is retained, bounding memory use.

Preview planning retains sparse replacement offsets but defers complete output construction until execution needs it. For valid UTF-8 files whose line endings require no normalization, execution opens the file once and verifies all bytes. If every changed range preserves its UTF-8 byte length, it writes only those ranges. Otherwise it rewrites from the first changed byte through the new end of file and truncates there. BOM offsets are handled using raw-buffer searches. Invalid UTF-8 and normalized-line-ending edits retain the built-in-compatible full-write path.

Unsupported preview inputs are delegated to the captured built-in preview implementation.

## Observability

The extension provides process-local, privacy-safe commands:

```text
/edit-accelerator-stats
/edit-accelerator-export-stats <directory>
/edit-accelerator-reset-stats
```

They report or export only:

- total edit calls
- accelerated calls
- built-in fallback calls
- preview plans reused
- prefetched files
- positional writes
- suffix writes
- eligible-file size buckets (`<100 KB`, `100 KB-1 MB`, `1-5 MB`, and `>5 MB`)
- native hits, declines, load and invocation failures, disabled fallbacks, and TypeScript fallbacks
- fast-path percentage

JSON exports also contain random process-session and snapshot-interval identifiers plus the collection timestamp. No paths, arguments, old text, replacement text, file contents, or exact file sizes are retained. Export once before each pilot process exits; reset starts a new interval within the same process session.

## Measured results

Environment:

```text
Node 22.23.2
Linux under WSL2, x64
AMD EPYC 7763
Pi 0.85.1
5 MB file, two distant exact edits
```

### Baseline definitions

- **A:** unmodified built-in Pi edit tool
- **B:** isolated extension boundary using Pi's full-file diff helpers
- **C:** sparse TypeScript extension

### Clean execution benchmark

Twenty alternating measured runs after three warmups from commit `b8fe59b`:

| Implementation | Median | p95 | Mean |
|---|---:|---:|---:|
| Built-in A | 401.11 ms | 495.65 ms | 412.68 ms |
| Sparse extension C | 33.56 ms | 39.27 ms | 35.23 ms |

Version 0.1.5 reduced median execution latency by approximately 92% on this stress fixture.

### Interactive preview benchmark

Ten alternating runs:

| Preview | Median |
|---|---:|
| Built-in | 299.08 ms |
| Sparse extension | 15.69 ms |

The preview result is exploratory but confirms that sparse preview removes most of the separate interactive diff cost.

### Combined interactive preview and execution

Ten alternating 5 MB runs start preview and execution in the same order as Pi's interactive lifecycle. The released `v0.1.1` implementation independently planned both operations; the preview-reuse candidate shares the in-flight plan.

| Extension version | Median preview-to-write latency |
|---|---:|
| `v0.1.1` | 77.40 ms |
| `v0.1.2` | 51.16 ms |

Version 0.1.2 reduced median interactive latency by approximately 34%. Normalizing each extension result against the built-in measurement from the same run gives an approximately 36% relative improvement, reducing the effect of machine-load variation between benchmark runs.

### Equal-byte-length positional writes

Twenty alternating executions compared the same prepared 5 MB edit with positional writes enabled and deliberately disabled:

| Write strategy | Median execution |
|---|---:|
| Full-file materialization and write | 28.32 ms |
| Verified positional writes | 4.50 ms |

The positional write stage was approximately 84% faster. For the complete interactive lifecycle, an equal-byte-length edit measured 26.24 ms on `v0.1.3` and 16.62 ms on `v0.1.4`, a further 37% reduction.

### Prefetch and suffix-write experiments

With a 50 ms simulated argument-streaming window, prefetch reduced post-argument latency from 33.30 ms to 27.22 ms, approximately 18%. A length-changing edit at byte 5,242,888 used a suffix rewrite instead of a complete write:

| Write strategy | Median execution |
|---|---:|
| Complete file | 26.91 ms |
| Changed suffix | 5.67 ms |

The suffix stage was approximately 79% faster. When the first change was at the beginning of the file, version 0.1.4 measured 31.42 ms for the complete interactive lifecycle.

These stress results demonstrate scaling potential. They do not establish normal-session impact; that depends on real file sizes and fast-path frequency.

## Edit override compatibility

SoL-Pi Action Fusion also registers an `edit` override to add optional `then_run` behavior. Only one registered tool can own the name `edit`; the last registration wins.

This conflict was verified in a real session: an edit completed through Action Fusion while accelerator statistics remained zero. The local pilot disables only SoL-Pi `actionFusion`; its other features remain enabled.

Users must either disable the competing edit override or add explicit composition between the extensions. Do not infer fast-path frequency while another extension owns the active `edit` tool.

## Validation coverage

Current tests cover:

- extension registration and built-in contract preservation
- exact execution equivalence
- fuzzy fallback equivalence
- sparse preview rendering
- in-flight preview-plan reuse
- exact file-content invalidation before reuse
- equal-byte-length positional writes
- raw byte offsets after BOM
- invalid UTF-8 fallback to built-in-compatible full-file writes
- CRLF fallback to full-file writes
- suffix expansion and truncation
- malformed UTF-16 replacement fallback
- stale prefetched-content invalidation and path mismatch
- leading-blank-line diff boundaries
- repeated-line whole-file alignment
- shared recomputation for separated and wider structural repeated-line groups
- interacting expanded-group fallback and patch applicability
- 100/200-edit line-local group scaling
- canceling replacement sets and no-change errors
- abort before positional mutation
- partial-line and multiline edits
- insertion and deletion
- nearby and distant hunks
- cumulative line shifts
- multiple changes on one line
- BOM and CRLF preservation
- missing trailing newline
- multibyte text
- statistics and reset behavior

Before broad rollout, add focused coverage for permission failures, symlinks, abort timing, concurrent edits, malformed previews, and platform-specific paths.

## CPU profile results

Scoped profiles verify built-in output equivalence before capture and measure execution and preview separately. The profiler uses a requested 10 µs interval and removes the initial inspector delay from the retained profile.

Three isolated TypeScript scan experiments were measured against the same 5 MB fixture:

| Version | Execution wall | Preview wall | Result |
|---|---:|---:|---|
| allocation-light normalization baseline | 102 ms | 72 ms | retained |
| one ASCII normalization eligibility scan | 96 ms | 75 ms | about 5 ms CPU reduction; retained |
| local hunk-boundary lookup instead of a full line-start array | 70 ms | 40 ms | major reduction; retained |
| one-pass replacement assembly | 66 ms | 42 ms | small execution reduction; retained |

The latest execution profile retained 505 samples over approximately 67 ms. Its largest self-time stages were:

| Function or stage | Self CPU |
|---|---:|
| exact edit planning | 16.2 ms |
| UTF-8 decode | 11.9 ms |
| extension execution wrapper and assembly | 8.8 ms |
| fuzzy-normalization eligibility | 7.8 ms |
| idle / I/O wait | 15.3 ms |
| garbage collection | 1.9 ms |

The latest preview profile retained 321 samples over approximately 43 ms. Exact planning used 11.0 ms, normalization eligibility 7.3 ms, UTF-8 decode 5.5 ms, and sparse diff construction only 0.4 ms.

Sparse hunk generation is no longer a meaningful hotspot. Remaining CPU is split across matching, safety checks, decoding, and filesystem work. Preview-plan reuse removes duplicate planning, prefetch overlaps the initial read with argument streaming, and sparse writes reduce output work.

A combined normalization-and-line-discovery scan was also tested. Its self time was 16.37 ms versus approximately 12.45 ms for the existing native-regex and `indexOf` path, and preview median rose to 31.01 ms. That experiment was rejected.

A narrower ASCII experiment was retained. Native `isAscii` validation used 0.23 ms and allowed the 7.37 ms Unicode-normalization scan to be skipped; trailing whitespace is checked during existing line discovery. Against the immediately preceding revision, preview median decreased from 22.42 ms to 20.08 ms, approximately 10%.

An initial transitive merge implementation repeatedly recomputed a growing prefix and regressed from 356 ms at 100 edits to 5,825 ms at 200 edits. The final two-phase policy builds each line-local group once and computes any shared structural group once. The same fixtures measured 11.67 ms and 33.41 ms, versus Pi's 101.50 ms and 366.12 ms.

## Rust decision gate

See [Hybrid Rust acceleration plan](rust-hybrid-implementation-plan.md) for the proposed native boundary, delivery phases, correctness requirements, packaging strategy, and performance gates.

Do not add Rust solely because candidate C still has measurable latency. A native backend is justified only if profiling shows a substantial CPU-bound region that Rust can replace through one coarse call.

Proceed to a Rust prototype only when all of these are true:

1. Real usage shows a useful fast-path hit rate.
2. Remaining latency is primarily CPU rather than filesystem I/O or rendering.
3. A self-contained stage has meaningful self time, such as scanning, matching, line indexing, or sparse hunk construction.
4. Estimated savings remain meaningful after JS/native string conversion and allocation.
5. The native package can ship prebuilt binaries for required Node/Bun platforms without install-time compilation.
6. The complete native result remains byte-compatible with the TypeScript reference.

If no single stage dominates, keep the TypeScript implementation and optimize its remaining scans instead. Likely TypeScript opportunities include combining normalization eligibility, match discovery, duplicate detection, and line indexing into fewer full-file passes.

## Recommended sequence

1. Resolve or temporarily disable the competing SoL-Pi Action Fusion edit override.
2. Run a controlled local pilot and collect aggregate hit/fallback counts.
3. Collect prefetch, preview-plan reuse, positional-write, and suffix-write rates during the pilot.
4. Revisit scan fusion only if a lower-overhead implementation becomes available.
5. Rerun scoped execution, preview, and combined interactive profiles after material changes.
6. Prototype Rust only if a coarse stage still offers meaningful savings after JS/native conversion.
7. Validate Node, Bun, Linux, macOS, and Windows before broad installation.
