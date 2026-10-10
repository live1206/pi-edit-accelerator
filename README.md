# Pi Edit Accelerator

A standalone [Pi](https://pi.dev) extension that speeds up exact file edits and interactive edit previews while preserving Pi's built-in `edit` tool as a compatibility fallback.

The implementation is TypeScript-only and uses Pi's released public extension API. No Pi core patch or native build is required.

## Why

Pi's built-in edit path generates a display diff and a unified patch by diffing the complete old and new file twice. That work becomes noticeable for sparse edits in large files, even though the exact changed ranges are already known.

This extension:

1. captures Pi's public `createEditToolDefinition()` implementation;
2. registers one replacement tool named `edit`;
3. applies supported exact edits and generates diffs only around affected ranges;
4. delegates fuzzy or unsupported inputs directly to the captured built-in tool.

## Performance

Latest retest (2026-10-10): accelerator 0.1.6 against **Pi 1.1.0**, Node 26.10.0, Linux/WSL2, AMD EPYC 7763. A ~5 MiB file with two distant exact edits measured:

| Scenario | Pi built-in median | Accelerator median | Speedup |
|---|---:|---:|---:|
| Execution | 251.40 ms | 14.98 ms | **16.8×** |
| Preview | 186.07 ms | 10.77 ms | **17.3×** |
| Interactive, length-changing edits | 436.34 ms | 26.41 ms | **16.5×** |
| Interactive, equal-byte-length edits | 420.64 ms | 14.09 ms | **29.8×** |

Median execution latency was approximately **94% lower**. Execution p95 was 323.88 ms built-in versus 25.24 ms accelerated. Execution used 20 alternating samples after three warmups; preview and interactive measurements used 10 alternating samples. Interactive latency includes preview and execution; standalone preview measures renderer invalidation, not terminal drawing.

A fresh Pi 0.85.1 baseline on the same runtime measured 253.05 ms built-in versus 15.60 ms accelerated for execution. Pi 1.1.0 has not materially closed the large-file execution gap; small version-to-version differences should not be treated as proven improvements.

Large batches of independent line-local edits also retain sparse scaling (three samples per implementation):

| Batch execution | Sparse extension | Pi built-in | Median reduction |
|---|---:|---:|---:|
| 100 edits, 140 KB file | 10.52 ms | 61.45 ms | 83% |
| 200 edits, 278 KB file | 33.18 ms | 304.83 ms | 89% |

Specialized writes avoid rewriting unchanged file regions. These experiments compare accelerator write strategies after planning, not the accelerator against Pi's built-in tool (20 samples per strategy):

| Prepared write path | Sparse write | Full-file write | Median reduction |
|---|---:|---:|---:|
| Equal-byte-length positional writes | 3.55 ms | 8.92 ms | 60% |
| Length-changing near-end suffix write | 3.58 ms | 8.95 ms | 60% |

With a simulated 50 ms argument-streaming window, prefetch reduced median post-argument latency from 13.13 ms to 10.97 ms (approximately 16%).

A separate Pi 1.1.0 normal-file-size matrix compared the built-in edit with this TypeScript extension on synthetic TypeScript-shaped ASCII files. The figures below are milliseconds, averaged across three scenario medians (one or three edits; 150 samples per case over three rounds):

| File | Preview: built-in / TS | Fresh execution: built-in / TS | Preview-reuse execution: built-in / TS |
|---|---:|---:|---:|
| ~5 KB | 0.490 / 0.796 | 1.054 / 0.915 | 1.033 / 1.311 |
| ~18 KB | 0.680 / 0.593 | 1.339 / 0.944 | 1.307 / 1.331 |
| ~38 KB | 1.026 / 0.615 | 1.828 / 0.967 | 1.765 / 1.372 |
| ~75 KB | 1.621 / 0.660 | 3.128 / 1.478 | 3.094 / 1.316 |

At ~5 KB, preview and execution after preview were slower by approximately 0.31 ms and 0.28 ms on average; fresh execution was slightly faster. At ~18 KB, execution after preview was mixed across scenarios. At ~38–75 KB, all three measured lifecycles improved. Preview-reuse execution excludes preview time; these separately collected medians should not be added to estimate complete interactive latency.

These synthetic results demonstrate scaling potential, not guaranteed gains for every edit or end-to-end agent latency improvements. Normal-session impact depends on file sizes and fast-path frequency. Both Pi versions passed all 69 compatibility tests and type checking.

See the [full Pi 1.1.0 performance report](docs/performance-pi-1.1.0.md) for per-case results, methodology, and reproduction commands. The development dependency remains pinned to Pi 0.85.1; to reproduce this retest, install Pi 1.1.0 locally without changing the manifests before running the benchmarks:

```sh
npm install --no-save --package-lock=false --ignore-scripts --legacy-peer-deps @earendil-works/pi-coding-agent@1.1.0
npm run bench:a-vs-b -- --runs 20 --warmup 3
npm run bench:small-files -- --output .artifacts/small-files.json
```

Run `npm ci` afterward to restore the pinned dependency environment.

## Install

Install from the public GitHub repository:

```sh
pi install git:github.com/live1206/pi-edit-accelerator@v0.1.6
```

Try it for one run without changing settings:

```sh
pi -e git:github.com/live1206/pi-edit-accelerator@v0.1.6
```

Restart Pi or run `/reload` after installation.

Remove it with:

```sh
pi remove git:github.com/live1206/pi-edit-accelerator@v0.1.6
```

Pi packages execute with full system access. Review the source before installation.

## Supported fast path

The sparse backend supports normalization-neutral, globally unique exact replacements, including:

- whole-line, partial-line, and multiline replacements;
- line insertion and deletion;
- multiple changes on one line;
- nearby and distant edits;
- cumulative line-number shifts between hunks;
- LF and CRLF files;
- UTF-8 BOM preservation;
- files with or without a trailing newline;
- multibyte UTF-8 text;
- positional writes when every replacement preserves its UTF-8 byte length;
- suffix-only rewrites for other valid UTF-8 files whose line endings require no normalization.

All edits are matched against the original content. The extension preserves Pi-compatible file output, display diff, unified patch, and `firstChangedLine`.

## Built-in fallback

The extension delegates to Pi's captured built-in implementation when it cannot prove fast-path compatibility. This includes fuzzy normalization, duplicate or overlapping matches, unresolved repeated-line diff interactions, Unicode-space and other special path forms, canceling replacement sets, malformed input, and inaccessible files.

Pi exposes only one `edit` tool. Fallback calls the retained built-in tool object directly; it does not expose a second tool or perform another registry lookup.

## Statistics

Use these process-local commands during a session:

```text
/edit-accelerator-stats
/edit-accelerator-reset-stats
```

They report only total, accelerated, fallback, prefetch, preview-plan reuse, positional-write, and suffix-write counts plus the fast-path percentage. No paths, arguments, replacement text, or file contents are retained.

## Other edit overrides

Only one extension can own the tool name `edit`; the last registration wins.

[SoL-Pi](https://github.com/NVlabs/SoL-Pi) Action Fusion also overrides `edit` to add `then_run`. To pilot this accelerator, disable Action Fusion in `sol-pi.json`:

```json
{
  "actionFusion": false
}
```

Other SoL-Pi features can remain enabled. If statistics stay at zero after real edits, verify that another extension has not replaced the active `edit` tool.

## Development

```sh
git clone https://github.com/live1206/pi-edit-accelerator.git
cd pi-edit-accelerator
npm install --ignore-scripts
npm run check
npm test
```

Benchmarks:

```sh
npm run bench:a-vs-b -- --runs 20 --warmup 3
npm run bench:preview
npm run bench:interactive
npm run bench:positional-write
npm run bench:prefetch
npm run bench:suffix-write
npm run bench:group-scaling
npm run bench:small-files -- --runs 50 --rounds 3 --warmup 10 --output .artifacts/small-files.json
npm run profile -- --mode execution --output .artifacts/execution.cpuprofile --report .artifacts/execution-profile.json
npm run profile:analyze -- .artifacts/execution.cpuprofile --output .artifacts/execution-analysis.json
```

The test suite compares sparse output with Pi's built-in result, display diff, unified patch, and final file bytes. CI runs typechecks and tests against Pi 0.85.1 and 1.1.0.

## Implementation notes

See [docs/edit-acceleration.md](docs/edit-acceleration.md) for:

- architecture and fallback behavior;
- sparse hunk generation;
- benchmark methodology;
- current compatibility coverage;
- CPU-profiling plan;
- the decision gate for a possible Rust implementation.

## Roadmap

1. Collect real-session accelerated/fallback rates.
2. Add permission, symlink, abort, concurrency, malformed-preview, and cross-platform tests.
3. Collect prefetch, preview-plan reuse, positional-write, and suffix-write rates during the pilot.
4. Revisit scan fusion only if a native or lower-overhead implementation becomes available.
5. Validate Linux, macOS, Windows, Node, and Bun.
6. Prototype Rust only if a coarse CPU-bound stage still offers meaningful savings after JS/native conversion.

## License

MIT. See [LICENSE](LICENSE).
