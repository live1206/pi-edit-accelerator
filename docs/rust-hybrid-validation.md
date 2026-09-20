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

## Remaining validation work

Before adoption:

1. Add reproducible peak RSS, allocated-byte, and GC measurements required by the adoption gates.
2. Run and export the 100–200-call privacy-safe pilot across multiple Pi processes.
3. Implement and measure native execution-time suffix assembly and fresh-execution preparation.
4. Record cold extension startup and lazy native-load latency separately.
