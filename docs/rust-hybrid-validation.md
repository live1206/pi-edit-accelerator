# Hybrid Rust validation

## Status

Phase 0 validation infrastructure is in progress. The TypeScript baseline and lifecycle matrix are now runnable before a native backend exists. The baseline below uses 20 measured runs per case and is suitable for comparison with the first native candidate; adoption still requires the resource measurements, pilot, and cross-platform gates in the implementation plan.

Environment and revision:

- revision: `5494a428fd07a03985e3061d2ee559539a7b007b` plus the Phase 0 working-tree changes;
- Node 22.23.2;
- Linux x64 under WSL2;
- AMD EPYC 7763.

Raw reports and the aggregate are in `.artifacts/hybrid-validation-baseline-20-20260920/`.

## Validation coverage added

- Preview and fresh-execution benchmarks now accept file size and positional/suffix strategy options.
- The interactive benchmark distinguishes in-flight preview-plus-execution from execution after a completed preview.
- Interactive reports include preview, execution, and total p50/p95 samples.
- Every benchmark compares final output with Pi's built-in edit before collecting samples.
- A regression test preserves JavaScript's cross-edit surrogate-pair behavior.
- Accelerated executions report privacy-safe eligible-file size buckets.
- `/edit-accelerator-export-stats <directory>` writes a non-overwriting JSON snapshot with random process-session and interval identifiers.
- Export tests verify that reset changes the interval identifier without changing the process-session identifier and that the payload omits its output path.

## TypeScript baseline

Extension median latency in milliseconds:

| Size bucket | Strategy | Preview | Fresh execution | In-flight combined | Completed-preview execution |
|---|---|---:|---:|---:|---:|
| `<100 KB` | positional | 1.13 | 1.75 | 2.28 | 1.13 |
| `<100 KB` | suffix | 1.20 | 1.79 | 2.31 | 1.15 |
| `100 KB–1 MB` | positional | 2.06 | 4.90 | 3.35 | 1.57 |
| `100 KB–1 MB` | suffix | 2.21 | 5.27 | 4.24 | 2.91 |
| `1–5 MB` | positional | 7.15 | 18.04 | 13.04 | 3.01 |
| `1–5 MB` | suffix | 7.85 | 19.20 | 14.37 | 6.86 |
| `>5 MB` | positional | 12.75 | 40.83 | 25.29 | 4.84 |
| `>5 MB` | suffix | 15.16 | 37.05 | 33.23 | 16.65 |

The fixtures were approximately 50 KB, 500 KB, 3 MB, and 6 MB. Each row used 20 measured runs after warmup. Raw reports retain p95 and individual samples; the table shows medians.

## Initial conclusions

- Lifecycle paths must remain separate: completed-preview execution is much cheaper than fresh execution, especially for positional writes.
- Suffix assembly remains material after preview reuse on large files, supporting deferred native `assembleAsciiSuffix` investigation.
- Preview and fresh execution continue to scale with file size and remain the primary native-kernel targets.
- Small-file native routing must be measured carefully because the current TypeScript path is already around 2–4 ms.

## Phase 1 planner prototype

A Linux x64 `napi-rs` prototype now performs ASCII validation, unique matching, overlap and no-op detection, line discovery, and positional/suffix plan construction. TypeScript validates and LF-normalizes edit strings before Node-API conversion, retains Unicode and unsupported cases, and disables the native loader after a load or invocation failure.

The native-specific suite builds the addon, runs Rust unit tests, compares deterministic native plans with the TypeScript oracle, exercises fallback and loader-disable behavior, and reruns exact-edit and extension integration tests with the addon loaded:

```sh
npm run native:test
```

Five-run CPU-profile medians on the original approximately 5 MB fixture were:

| Mode | TypeScript planner | Native planner | Profile wall before | Profile wall with native |
|---|---:|---:|---:|---:|
| Preview | 6.19 ms plus 4.28 ms selection wrapper | 1.99 ms | 23.96 ms | 14.25 ms |
| Execution | 6.56 ms plus 4.64 ms selection wrapper | 2.12 ms | 51.16 ms | 41.42 ms |

The 20-run unprofiled lifecycle comparison was mixed. At approximately 3 MB, preview median improved 13.6% for positional edits and 29.9% for suffix edits. At approximately 6 MB, preview changed by -3.8% and +13.6%, respectively. Fresh execution improved only 0.8–5.9%, in-flight combined execution improved 7.2–11.7%, and completed-preview execution remained approximately flat. Raw results are in `.artifacts/native-phase1-20260920/`; CPU profiles are in `.artifacts/native-phase1-profile-20260920/`.

Phase 1 therefore validates the coarse native boundary and materially reduces planner CPU, but it does not independently meet the adoption gates. Full JavaScript decoding remains about 5.7–11.6 ms in the profile, and fresh execution still constructs output in JavaScript. This supports continuing to the buffer-first Phase 2 experiment rather than adopting the Phase 1 backend by itself.

## Phase 2 buffer-first preview prototype

For line-local ASCII edits, Rust now returns bounded old/new context windows along with plan metadata. TypeScript builds the sparse patch and display diff from those windows without decoding the full file. Structural edits and windows requiring additional ambiguity context fall back to the full TypeScript-compatible path. Preview retains the original `Buffer` and metadata but no full normalized JavaScript string; suffix materialization remains deferred until execution.

Five-run CPU-profile median preview wall time fell from 23.96 ms for TypeScript to 9.16 ms, a 61.8% reduction. The full-buffer decode disappeared from the preview hotspot list. Rust planning plus bounded-window construction used 3.43 ms; filesystem wait used 1.93 ms. Raw profiles are in `.artifacts/native-phase2-profile-20260920/`.

Twenty-run end-to-end medians against the TypeScript baseline were:

| Size | Strategy | Preview | Fresh execution | In-flight combined | Completed-preview execution |
|---|---|---:|---:|---:|---:|
| approximately 3 MB | positional | 50.3% faster | 4.2% faster | 52.8% faster | 10.3% slower |
| approximately 3 MB | suffix | 60.9% faster | 2.7% faster | 10.9% faster | 47.4% slower |
| approximately 6 MB | positional | 45.8% faster | 0.2% slower | 54.8% faster | 4.1% faster |
| approximately 6 MB | suffix | 40.2% faster | 2.4% faster | 4.0% faster | 70.1% slower |

Raw reports are in `.artifacts/native-phase2-20260920/`. Phase 2 clears the preview gate on both large-file buckets and write strategies. Positional combined behavior also clears its gate. Fresh execution remains unchanged because it still uses JavaScript decode and assembly. Completed-preview suffix execution regresses because Phase 2 intentionally moves the previously eager decode out of preview, then pays that cost during execution. The combined suffix result improves only modestly. Native execution-time suffix assembly is therefore required before the hybrid path can satisfy the complete lifecycle gates.

## Phase 3 native execution prototype

Fresh execution now performs planning and, when needed, suffix assembly in one native call. TypeScript retains the mutation queue and filesystem writes. Execution reusing preview metadata validates the complete current byte buffer before making one native suffix-assembly call. Positional preview plans continue to write their bounded replacement buffers directly.

Twenty-run end-to-end medians against the TypeScript baseline were:

| Size | Strategy | Preview | Fresh execution | In-flight combined | Completed-preview execution |
|---|---|---:|---:|---:|---:|
| approximately 3 MB | positional | 53.1% faster | 78.7% faster | 53.7% faster | 8.6% slower |
| approximately 3 MB | suffix | 61.5% faster | 73.9% faster | 43.0% faster | 9.5% faster |
| approximately 6 MB | positional | 48.8% faster | 82.1% faster | 55.2% faster | 4.2% faster |
| approximately 6 MB | suffix | 52.5% faster | 79.4% faster | 62.2% faster | 55.2% faster |

A separate 50-run check of the approximately 3 MB completed-preview path found positional median 1.2% faster and suffix median 8.1% faster. Native p95 was 1.91 ms higher for positional and 1.37 ms higher for suffix, both within the 2 ms absolute compatibility ceiling. The earlier 20-run p95 comparison was therefore dominated by run-to-run variance.

Five-run CPU-profile medians were 9.80 ms for preview and 8.99 ms for fresh execution, versus the TypeScript profile medians of 23.96 ms and 51.16 ms. Full-file JavaScript decode, replacement assembly, and UTF-8 re-encoding are absent from the native fresh-execution hotspot list.

Raw reports are in `.artifacts/native-phase3-20260920/`; CPU profiles are in `.artifacts/native-phase3-profile-20260920/`. Phase 3 clears the large-file median gates for preview, fresh execution, and combined execution. Completed-preview execution remains within the defined absolute regression ceilings on the repeated 3 MB check and improves materially for 6 MB suffix writes.

The 50 KB and 500 KB matrix also remained within the small-file gates. The largest 50 KB median and p95 regressions were 0.12 ms and 0.48 ms. Initial 500 KB samples showed two p95 deltas just over the 0.5 ms ceiling; a 50-run rerun reduced suffix in-flight p95 by 0.71 ms and increased completed-preview p95 by only 0.30 ms. Raw small-file reports are in `.artifacts/native-phase3-small-20260920/`.

## Phase 4 packaging and rollout validation

The loader now tries the target-specific optional package before the development binary path. The initial package scaffold is `@live1206/pi-edit-accelerator-linux-x64-gnu`; it declares Linux, x64, and glibc constraints and contains only its README, manifest, and `.node` binary. `npm run native:package:linux-x64` produced a 240 KB tarball with a 496 KB unpacked size. The package is not published or added as a root optional dependency yet, so ordinary installs continue to use TypeScript unless a development binary is present.

CI now has separate TypeScript-only and Linux x64 native jobs. The native job checks Rust formatting and Clippy, runs the complete native-loaded suite, builds the platform tarball, and uploads it as an artifact. Native observability now records hits, unsupported inputs, semantic declines, load and invocation failures, disabled-backend fallbacks, and TypeScript accelerator fallbacks in both the stats command and privacy-safe JSON export.

A new `bench:resources` harness measures lazy cold-operation latency, extension registration, peak RSS, heap/external/array-buffer deltas, and GC activity under `--expose-gc`. Twenty-run 3 MB and 6 MB results found:

- native warm wall time was 50.2–65.8% lower across preview and fresh execution;
- peak RSS delta was lower in seven of eight cases; 6 MB suffix execution was 1.25 MiB higher, within the 16 MiB ceiling;
- median heap delta was 49.6–98.1% lower for all previews and 3 MB executions, and only 0.3–0.5% higher for 6 MB executions;
- no measured case added a major collection; where operation-time GC occurred, native pause time was about 3.2 ms lower;
- extension registration changed by at most 0.18 ms, within the 1 ms startup ceiling;
- the first native operation remained faster than TypeScript despite lazy addon loading.

Net array-buffer deltas are not a valid cumulative allocation-byte metric: native execution intentionally returns an output buffer whose collection can occur after the measured operation. The allocation-byte gate therefore remains open pending an allocation profiler that includes external/native buffers. Raw resource reports are in `.artifacts/native-phase4-resources-20260920/`.

## Remaining validation work

Before adoption:

1. Run and export the 100–200-call privacy-safe pilot across multiple Pi processes.
2. Add a cumulative allocation profiler that accounts for external/native buffers.
3. Validate Node and Bun on the intended macOS and Windows targets and add their platform packages before broad rollout.
4. Publish the Linux platform package and add it as an optional dependency only after the pilot and remaining gates pass.
