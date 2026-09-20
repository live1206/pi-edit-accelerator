# Hybrid Rust implementation plan review

## Outcome

Proceed with the bounded Rust investigation. The initial real-usage sample is small, but its 71.4% fast-path rate is sufficient to justify a prototype when combined with the profiling evidence. Run a dedicated, longer pilot separately to validate representativeness and measure eligible file sizes; do not block the investigation on that pilot.

Initial session snapshot:

| Metric | Result |
|---|---:|
| Total edit calls | 21 |
| Accelerated | 15 |
| Built-in fallback | 6 |
| Fast-path rate | 71.4% |
| Preview plans reused | 13 |
| Prefetched files | 13 |
| Positional writes | 0 |
| Suffix writes | 13 |

The counters are currently in-memory and per Pi process. The dedicated pilot should preserve session snapshots and add coarse file-size buckets; it must not record paths, file contents, or edit text.

## Required plan changes

### 1. Validate edit strings before UTF-8 conversion

The API accepts JavaScript strings but returns individually encoded replacement buffers. The fallback list excludes non-ASCII file content without explicitly excluding unsupported edit strings before native conversion.

Verified against both the TypeScript accelerator and Pi's built-in edit:

```text
Original: "ab\n"
Edits:    "a" → "\ud83d"
          "b" → "\ude00"

TypeScript/built-in result: "😀\n"
Individually encoded replacements: "��\n"
```

TypeScript joins UTF-16 strings before encoding; independent UTF-8 conversion loses the surrogate pairing. The existing sparse-write planner rejects malformed replacement strings for this reason.

Validate `oldText` and `newText` in TypeScript before native conversion. Initially decline non-ASCII edit strings, or at minimum malformed UTF-16, to the TypeScript accelerator. Add ASCII-file/non-ASCII-edit and surrogate-boundary cases to differential tests.

References: `docs/rust-hybrid-implementation-plan.md:85-95,233-242` and `src/exact-edit.ts:213-242`.

### 2. Gate fresh execution and preview reuse separately

Fresh execution uses execution-mode preparation, while preview-reused execution uses cached metadata and, when needed, suffix assembly. The performance gate specifies a single execution median without requiring measurements of both paths.

The existing `benchmark/a-vs-b.ts` measures execution without preview. Passing it would not validate preview reuse, which accounted for 13 of 15 accelerated calls in the pilot.

Require separate measurements for:

- fresh execution;
- execution after completed preview;
- combined preview-plus-execution.

Exercise both positional and suffix writes, and specify the improvement or no-regression gates for each path. Use `benchmark/interactive.ts` as a starting point for the combined case.

References: `docs/rust-hybrid-implementation-plan.md:199-200,251-261`.

## Dedicated pilot follow-up

Collect multiple representative sessions, preferably at least 100-200 edit calls in aggregate. Preserve totals by session and capture coarse eligible-file size buckets such as `<100 KB`, `100 KB-1 MB`, `1-5 MB`, and `>5 MB`. The pilot should validate the expected production benefit and inform native selection policy; it is not a prerequisite for starting the prototype.
