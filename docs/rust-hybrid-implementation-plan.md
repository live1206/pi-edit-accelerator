# Hybrid Rust acceleration plan

## Decision

Prototype a narrow Rust native kernel for the existing TypeScript extension. Do not rewrite the full extension.

TypeScript remains the reference implementation, owns Pi integration and filesystem orchestration, and handles every unsupported or unavailable-native case. Rust accelerates only the coarse CPU-bound preparation path.

## Evidence

Fresh profiles of revision `5494a42` used a 5,242,900-byte ASCII fixture with two unique edits at opposite ends of the file. Five captures were collected for preview and execution.

| Mode | Unprofiled median | Main profiled costs |
|---|---:|---|
| Preview | 20.08 ms | planning 6.15 ms; full-buffer UTF-8 decode 5.60 ms; preparation 4.94 ms; GC 3.66 ms |
| Execution | 34.00 ms | I/O/idle 15.95 ms; decode 12.23 ms; planning 6.92 ms; replacement assembly 5.24 ms; wrapper 5.17 ms |

Sparse diff generation is now below 0.8 ms inclusive and is not itself a porting target. Older profiles showing 21–24 ms in `buildSparseDiffs` predate the retained sparse-diff optimizations.

The profiler increases wall time materially, so sampled milliseconds indicate hotspot ranking rather than directly realizable savings. Raw profiles and the full report are in `.artifacts/rust-gate-20260920/`. Phase 0 progress and baseline results are tracked in [Hybrid Rust validation](rust-hybrid-validation.md).

An initial real-usage snapshot recorded 21 edit calls: 15 accelerated and 6 built-in fallbacks, for a 71.4% fast-path rate. It also recorded 13 preview-plan reuses, 13 prefetched files, 13 suffix writes, and no positional writes. This small sample supports starting the prototype but is not representative enough to predict production savings.

Run a separate pilot over preferably 100–200 edit calls across multiple sessions. Preserve per-session totals and bucket eligible file sizes as `<100 KB`, `100 KB–1 MB`, `1–5 MB`, and `>5 MB`. Do not record paths, file contents, or edit text. Add this instrumentation before the prototype so the pilot can run alongside the investigation; completing the pilot does not block the prototype.

## Goals

- Remove repeated full-file JavaScript scans from the common ASCII exact-edit path.
- Avoid decoding the complete input into a JavaScript UTF-16 string when only small changed regions are needed.
- Cross the Node-API boundary once per preparation or execution, not once per sub-operation.
- Preserve byte-for-byte compatibility with the TypeScript implementation.
- Fall back safely when native code is unavailable or a case is unsupported.
- Ship prebuilt binaries; never require users to compile Rust during package installation.

## Non-goals

- Rewriting extension registration, renderers, preview caching, prefetch, mutation queues, or general filesystem orchestration.
- Porting sparse diff generation in isolation.
- Supporting all Unicode and fuzzy-normalization behavior in the first prototype.
- Replacing the TypeScript reference or fallback implementation.

## Architecture

The preferred data flow is:

```text
TypeScript readFile() -> Buffer
                         |
                         v
              one native preparation call
                         |
                         v
       match metadata + write plan + bounded diff data
                         |
                         v
       TypeScript result/rendering and queued writes
```

TypeScript owns:

- Pi tool registration and lifecycle;
- path validation and mutation queue integration;
- prefetch and preview-plan caching;
- result and renderer integration;
- filesystem writes unless benchmarks justify moving a complete atomic operation;
- validation and LF normalization of edit strings before any Node-API conversion;
- Unicode, unusual-file, and error fallback behavior.

Rust owns, through one coarse call per preparation or execution operation:

1. ASCII and UTF-8 eligibility validation;
2. BOM, line-ending, and trailing-whitespace checks;
3. unique match discovery;
4. overlap and no-op detection;
5. line counting and changed-line discovery;
6. byte-offset calculation;
7. positional-versus-suffix write planning;
8. execution-only replacement assembly for length-changing writes, after TypeScript validates file identity;
9. extraction of bounded context windows needed by the TypeScript diff/result layer.

## Native API sketch

The initial API should accept the original `Buffer`, avoiding a full JavaScript string conversion before entering Rust. Before crossing Node-API, TypeScript normalizes edit line endings and verifies that every code unit in every `oldText` and `newText` is ASCII. A non-ASCII edit string, including any surrogate code unit, declines native handling and continues through the TypeScript accelerator. This prevents separate replacement encoding from changing JavaScript's final UTF-16 concatenation semantics.

```ts
interface NativeEdit {
  oldText: string;
  newText: string;
}

interface NativeReplacement {
  byteOffset: number;
  oldByteLength: number;
  firstLine: number;
  lastLine: number;
  newBytes: Buffer;
}

interface NativeSuffixPlan {
  kind: "suffix";
  position: number;
  replacementIndex: number;
}

interface NativePreparedEdit {
  oldLineCount: number;
  replacements: NativeReplacement[];
  writePlan:
    | { kind: "positional"; writes: Array<{ position: number; bytes: Buffer }> }
    | NativeSuffixPlan;
  diffWindows: Array<{
    oldStartLine: number;
    oldBytes: Buffer;
    newBytes: Buffer;
    hasEarlierContent: boolean;
    hasLaterContent: boolean;
  }>;
}

interface NativeExecutionEdit extends Omit<NativePreparedEdit, "writePlan"> {
  writePlan:
    | { kind: "positional"; writes: Array<{ position: number; bytes: Buffer }> }
    | { kind: "suffix"; position: number; bytes: Buffer };
}

function prepareAsciiEdit(
  bytes: Buffer,
  edits: NativeEdit[],
  mode: "preview",
): NativePreparedEdit | undefined;
function prepareAsciiEdit(
  bytes: Buffer,
  edits: NativeEdit[],
  mode: "execution",
): NativeExecutionEdit | undefined;
function assembleAsciiSuffix(
  currentBytes: Buffer,
  replacements: NativeReplacement[],
  plan: NativeSuffixPlan,
): Buffer;
```

The exact result shape may change during the prototype. It must remain compact and avoid returning a second full-file JavaScript string. Preview mode returns suffix metadata, not an assembled suffix buffer; otherwise an unexecuted preview could allocate almost the entire changed file. Fresh execution mode plans and assembles a required suffix in the same native call. Execution that reuses preview metadata instead calls `assembleAsciiSuffix`, but only after file-identity validation. Each preparation or execution operation therefore crosses the native boundary at most once. Bounded diff-window buffers remain acceptable. Buffers returned from Rust should use ownership transfer or external-buffer support where the selected Node-API library permits it.

The native preparation function returns `undefined` for an ordinary unsupported case. The TypeScript wrapper validates each call contract before entering native code; caller or contract violations throw because they indicate an integration defect.

The native kernel must be pure and must not mutate files or external state. TypeScript catches recoverable implementation errors and Rust panics surfaced through Node-API, disables the native backend for the remainder of the process, and retries the operation through the TypeScript implementation. The loader caches this disabled state so later calls do not repeatedly invoke a broken binding. Native load failures follow the same cached-disable path. A fatal process-level native crash cannot be recovered and remains a residual risk.

## Delivery phases

### Phase 0: benchmark and contract harness

Before native implementation:

- extract shared fixtures for direct TypeScript/native comparison;
- cover successful plans and every fallback decision;
- benchmark realistic file sizes, edit counts, and edit positions;
- measure preview only, fresh execution, execution after a completed preview, and combined preview-plus-execution as separate lifecycle paths;
- exercise equal-byte-length positional writes and length-changing suffix writes in every lifecycle path;
- use `benchmark/interactive.ts` as the starting point for the combined in-flight preview-plus-execution case and add a completed-preview benchmark;
- record cold-load separately from warm-call latency;
- retain the current 5 MB endpoint fixture for comparison;
- add privacy-preserving eligible-file size buckets to the existing process-local statistics;
- generate one random process-session identifier when the extension starts;
- add an explicit `/edit-accelerator-export-stats <directory>` command that writes one timestamped JSON snapshot with that identifier, a snapshot-interval identifier, aggregate counters, and size buckets;
- require pilot operators to export once before each Pi process exits and preserve those files as the multi-session pilot input.

The exported payload must not contain the output directory, project or file paths, file contents, edit text, or raw edit sizes. Resetting counters starts a new snapshot interval with a new interval identifier while retaining the process-session identifier. Required benchmark size coverage includes the same `<100 KB`, `100 KB–1 MB`, `1–5 MB`, and `>5 MB` buckets used by the pilot.

### Phase 1: native scan and planning prototype

Implement only:

- ASCII eligibility;
- exact unique matching;
- overlap and no-op checks;
- line discovery;
- positional/suffix plan metadata.

Continue using the current TypeScript decode and sparse-diff path. This phase measures Node-API overhead and validates byte and line offsets. It is not expected to capture the full potential because complete JavaScript decoding remains.

Stop if the native call overhead or packaging burden makes a material end-to-end improvement implausible.

### Phase 2: buffer-first preview preparation

Avoid full-file JavaScript decoding on eligible files:

- return bounded old/new context windows;
- decode only those windows in TypeScript;
- return only suffix position and replacement metadata during preview preparation;
- do not assemble a full suffix or output buffer for an unexecuted preview, with a contract test proving that `assembleAsciiSuffix` is not called;
- preserve current sparse display diff and unified patch output exactly;
- fall back when structural edits require unsupported grouping or context expansion.

This phase targets preview decoding, planning, allocation, and GC together.

### Phase 3: native execution assembly

For execution:

- retain TypeScript-owned queued filesystem writes;
- use positional writes for equal-byte-length replacements;
- for fresh execution, call `prepareAsciiEdit` in execution mode so planning and any required suffix assembly happen in one native call;
- for execution reusing preview metadata, request suffix assembly only after validating file identity, using one `assembleAsciiSuffix` call;
- avoid constructing the full changed file as a JavaScript string.

Before applying any native-derived write plan, TypeScript must enter the mutation queue, reread the current file, and establish that it is the same input used to prepare the plan. The initial implementation must use exact byte comparison against the prepared buffer. On mismatch, it must prepare again from the bytes read inside the queue or use the TypeScript fallback; it must never apply stale native offsets. Any later replacement for exact comparison must provide equivalent file-identity safety rather than relying only on path, size, timestamps, or other mutable metadata. Only after this validation may TypeScript call `assembleAsciiSuffix` with the validated current bytes and apply its result. A fresh execution has no stale preview plan: it passes the bytes read inside the mutation queue directly to execution-mode preparation.

Only consider moving filesystem operations into Rust if later profiles show that doing so offers a meaningful additional benefit without weakening queueing, identity validation, abort, concurrency, permission, or symlink behavior.

### Phase 4: packaging and controlled rollout

- publish platform-specific prebuilt packages selected by the TypeScript package;
- make the native dependency optional so installation and startup still work without it;
- validate Node and Bun on Linux, macOS, and Windows;
- expose native-hit, unsupported, disabled-after-failure, load-failure, and TypeScript-fallback counters;
- extend the Phase 0 snapshot export format with those native-specific counters;
- complete the pilot before making the native path the default.

## Correctness requirements

For every accelerated case, compare native and TypeScript behavior for:

- final file bytes;
- tool result text and details;
- display diff and unified patch;
- first changed line;
- replacement positions and ordering;
- positional and suffix write boundaries;
- BOM and LF/CRLF preservation;
- missing trailing newline;
- insertion, deletion, multiline edits, and cumulative line shifts;
- nearby, distant, and same-line edit groups;
- duplicate, overlapping, and no-op edits;
- ASCII files with valid non-ASCII and emoji replacements;
- lone surrogate edit strings and adjacent replacements that form a surrogate pair only after JavaScript concatenation;
- non-ASCII `oldText` and confirmation that a native decline still attempts TypeScript acceleration;
- abort and concurrent-edit behavior at the TypeScript orchestration layer.

Use property-based or fuzz tests over ASCII content and edit sets. The TypeScript result is the oracle. A mismatch must fall back or fail the test; it must never be accepted as an alternative result. Differential tests must include the boundary case `"ab\n"` with adjacent replacements `"a"` to `"\ud83d"` and `"b"` to `"\ude00"`: TypeScript produces `"😀\n"`, while independent replacement encoding would incorrectly produce two replacement characters.

Initially decline native handling and continue through the TypeScript accelerator for:

- non-ASCII content;
- any non-ASCII `oldText` or `newText`, including valid Unicode and malformed surrogate code units;
- malformed UTF-8;
- fuzzy-normalization-sensitive text;
- mixed or unsupported line endings;
- unsupported structural grouping or context expansion;
- any ambiguous match or native validation uncertainty.

## Performance gates

Measure unprofiled end-to-end latency, not native function time alone. Benchmark these lifecycle paths separately for both positional and suffix-write fixtures:

1. preview only;
2. fresh execution without preview;
3. execution after a fully completed and reusable preview;
4. combined preview plus execution, including the existing in-flight preview behavior.

On every performance-gated target, the `1–5 MB` and `>5 MB` buckets must satisfy:

| Lifecycle path | Large-file gate |
|---|---|
| Preview only | at least 25% lower p50 |
| Fresh execution | at least 20% lower p50 |
| Combined preview plus execution | at least 20% lower p50 |
| Execution after completed preview | no more than the compatibility-target p50 and p95 regression ceilings below |

Every lifecycle path must also remain within the compatibility-target p95 regression ceiling for its large-file bucket, including paths with a p50 improvement requirement. Continue beyond the prototype only if both write strategies pass the applicable lifecycle gate and all of the following hold:

- in the `<100 KB` bucket, no more than 0.25 ms p50 regression and 0.5 ms p95 regression for any lifecycle path;
- in the `100 KB–1 MB` bucket, no more than the larger of 0.5 ms or 5% regression at p50 or p95 for any lifecycle path;
- no more than 1 ms p50 and 2 ms p95 extension-startup regression, with the native binding loaded lazily;
- peak RSS growth no greater than the larger of 16 MiB or 20% over TypeScript on the same fixture;
- median allocated bytes per operation no more than 10% above TypeScript;
- aggregate GC pause time no more than 5% above TypeScript and no additional major collection in the benchmark window;
- the resource limits above pass for each lifecycle path and write strategy where the metric applies;
- native acceptance of at least 95% of TypeScript-eligible ASCII calls, excluding explicitly documented unsupported categories;
- no reduction in the extension's overall accelerated-hit rate, because a native decline must try the TypeScript accelerator before built-in fallback.

Report median, p95, minimum, maximum, allocated bytes, peak RSS, GC pause time, major collections, and native and overall hit rates separately by lifecycle path and write strategy. Alternate candidate and baseline order, warm both implementations, and retain raw samples. Measure cold extension startup separately. A size router may keep a smaller bucket on TypeScript and must run before loading or invoking the native binding.

### Runtime and platform policy

Use the following initial matrix:

| Runtime and target | Initial policy | Required size coverage |
|---|---|---|
| Node 22 on Linux x64 | Performance-gated production target | `<100 KB`, `100 KB–1 MB`, `1–5 MB`, and `>5 MB` |
| Node 22 on macOS arm64 and x64 | Compatibility target until promoted | Correctness suite plus small- and large-file no-regression benchmarks |
| Node 22 on Windows x64 | Compatibility target until promoted | Correctness suite plus small- and large-file no-regression benchmarks |
| Current supported Bun on Linux x64, macOS arm64, and Windows x64 | Compatibility target until promoted | Binding/load spike, correctness suite, and small- and large-file no-regression benchmarks |

The lifecycle thresholds above must pass separately in the `1–5 MB` and `>5 MB` buckets on every performance-gated target, for positional and suffix fixtures. The two smaller buckets must satisfy the p50 and p95 limits above; a measured size threshold may route them to TypeScript. Compatibility targets must pass byte-for-byte equivalence and these large-file regression ceilings for every lifecycle path and both write strategies:

| Bucket | Maximum p50 regression | Maximum p95 regression |
|---|---:|---:|
| `1–5 MB` | larger of 1 ms or 5% | larger of 2 ms or 5% |
| `>5 MB` | larger of 2 ms or 5% | larger of 5 ms or 10% |

They must also satisfy the smaller-file limits above. Startup, peak RSS, allocated-byte, and GC limits apply to every target for which a native binary is tested. If a runtime cannot expose equivalent allocation or GC metrics, record that limitation and keep the target compatibility-only; it cannot be promoted until the complete resource gate is measurable and passes.

Native selection uses an explicit allowlist of runtime, operating-system, and architecture combinations that passed the full performance and resource gates. A correct target that misses a gate, an unknown target, or a target with no compatible binary uses TypeScript by default. Add production environments to the performance-gated set before enabling native acceleration there. Revisit the matrix when supported runtimes or actual deployment targets change.

## Packaging approach

Prefer a mature Node-API binding toolchain such as `napi-rs`, subject to a small Node-and-Bun compatibility spike. Use a loader that attempts the matching platform package lazily and caches either the loaded binding or the load failure.

The TypeScript package must remain functional when:

- no binary exists for the current platform;
- optional dependencies were omitted;
- native loading is blocked;
- the binary ABI is incompatible;
- the native operation declines an input.

Initial binary targets are the actual deployment environments selected for native enablement. Other supported Linux, macOS, and Windows architectures are required only for broad rollout to those targets, not for the first allowlisted adoption.

## Main risks

| Risk | Mitigation |
|---|---|
| Node-API conversion erases the speedup | Pass the original `Buffer`; use one coarse call; avoid returning a full JS string. |
| Rust and JavaScript use different offset units | Keep the first native path ASCII-only, where byte and UTF-16 offsets coincide; test every returned offset. |
| Diff output drifts from Pi behavior | Keep formatting in TypeScript and compare complete result objects and bytes. |
| Native binaries complicate installation | Optional, platform-specific prebuilds with transparent TypeScript fallback. |
| Small files regress | Lazy-load and use a measured size threshold if necessary. |
| Bun behavior differs from Node | Run a dedicated compatibility spike before selecting the binding and packaging design. |
| Native crashes expand the reliability surface | Keep the kernel pure and narrow; validate all boundaries; use fuzzing and sanitizers in CI. |

## Adoption milestones

### Initial adoption

Enable the hybrid backend only on explicit allowlisted targets for which:

- the dedicated pilot is complete;
- correctness, performance, startup, memory, allocation, and GC gates pass;
- a reliable prebuilt binary is available;
- optional loading and TypeScript fallback are validated.

The initial milestone may enable only Node 22 on Linux x64. Unknown, failed-gate, and compatibility-only targets remain native-disabled and use TypeScript.

### Broad rollout

Broad rollout additionally requires:

- completion of the intended Node/Bun and Linux/macOS/Windows compatibility matrix;
- reliable prebuilt binaries for every target intended to receive native acceleration;
- correctness and measurable no-regression gates passing across the matrix;
- the full performance and resource gates passing on every default-enabled target.

If initial-adoption requirements are not met, retain the TypeScript implementation and archive the prototype results. If broad-rollout requirements are not met, keep passing allowlisted targets enabled and all others on TypeScript. The native backend remains an optimization rather than a correctness dependency.
