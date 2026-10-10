# Pi 1.1.0 edit performance retest

## Environment and method

- Date: 2026-10-10; accelerator 0.1.6, revision `ff14355fddbbc3d07a7369c4e60758d85723a0fe`.
- Runtime: v26.10.0; 6.18.33.2-microsoft-standard-WSL2, x64; AMD EPYC 7763 64-Core Processor.
- Identical accelerator source; only the local Pi dependency was changed. Package manifests/lockfile are unchanged. The pre-existing untracked `.pi/` directory makes benchmark metadata report a dirty worktree.
- Version suites ran serially, 0.85.1 first and 1.1.0 second; implementations alternate within suites. Version-to-version differences are exploratory (machine-load/order effects are not eliminated).
- Large execution: 20 samples after 3 warmups. Preview/interactive: 10 samples. Scaling: 3 samples. Small-file matrix: 150 samples/case over 3 rounds, 10 warmups/case/round, isolated workers.
- Execution/interactive/scaling/small-file harnesses assert output equivalence. Standalone preview measures renderer invalidation latency, not terminal drawing. Preview-reuse execution excludes preview time. These are synthetic local tool measurements, not end-to-end agent/model latency.
- Both Pi versions passed all 69 tests and `npm run check`.

## Large-file and scaling results

Median milliseconds; speedup is built-in / accelerator.

| Scenario | Pi | Built-in | Accelerator | Speedup |
|---|---|---:|---:|---:|
| 5 MiB execution | 0.85.1 | 253.05 | 15.60 | 16.22× |
| 5 MiB preview | 0.85.1 | 172.34 | 10.44 | 16.51× |
| 5 MiB interactive (length-changing) | 0.85.1 | 511.12 | 30.22 | 16.91× |
| 5 MiB interactive (equal-byte-length) | 0.85.1 | 428.90 | 14.62 | 29.33× |
| 100 edit groups | 0.85.1 | 62.06 | 11.27 | 5.50× |
| 200 edit groups | 0.85.1 | 302.21 | 32.09 | 9.42× |
| 5 MiB execution | 1.1.0 | 251.40 | 14.98 | 16.78× |
| 5 MiB preview | 1.1.0 | 186.07 | 10.77 | 17.28× |
| 5 MiB interactive (length-changing) | 1.1.0 | 436.34 | 26.41 | 16.52× |
| 5 MiB interactive (equal-byte-length) | 1.1.0 | 420.64 | 14.09 | 29.84× |
| 100 edit groups | 1.1.0 | 61.45 | 10.52 | 5.84× |
| 200 edit groups | 1.1.0 | 304.83 | 33.18 | 9.19× |

### Large-file execution tails

| Pi | Built-in p95 | Accelerator p95 |
|---|---:|---:|
| 0.85.1 | 313.52 ms | 23.29 ms |
| 1.1.0 | 323.88 ms | 25.24 ms |

## Small-file results

Each row gives the minimum–maximum across three edit scenarios (single suffix, multiple positional, multiple suffix). These are ranges of per-case medians, not pooled medians. Negative change means the accelerator is faster.

| Pi | Size bucket | Lifecycle | Built-in median range (ms) | Accelerator median range (ms) | Accelerator change range |
|---|---|---|---:|---:|---:|
| 0.85.1 | lt10kb | preview | 0.49–0.55 | 0.72–0.77 | 34.59–47.84% |
| 0.85.1 | lt10kb | fresh-execution | 1.04–1.11 | 0.92–0.93 | -15.88–-11.45% |
| 0.85.1 | lt10kb | preview-reuse-execution | 1.02–1.09 | 1.29–1.43 | 21.98–36.73% |
| 0.85.1 | 10-25kb | preview | 0.59–0.75 | 0.55–0.64 | -18.80–-6.97% |
| 0.85.1 | 10-25kb | fresh-execution | 1.26–1.40 | 0.90–0.93 | -34.72–-28.28% |
| 0.85.1 | 10-25kb | preview-reuse-execution | 1.21–1.39 | 1.32–1.38 | -3.11–10.88% |
| 0.85.1 | 25-50kb | preview | 0.86–1.15 | 0.55–0.65 | -43.28–-35.39% |
| 0.85.1 | 25-50kb | fresh-execution | 1.64–1.94 | 0.93–0.97 | -50.51–-42.98% |
| 0.85.1 | 25-50kb | preview-reuse-execution | 1.58–1.89 | 1.31–1.42 | -30.69–-14.94% |
| 0.85.1 | 50-100kb | preview | 1.31–1.82 | 0.58–0.69 | -62.55–-55.94% |
| 0.85.1 | 50-100kb | fresh-execution | 2.75–3.30 | 1.40–1.49 | -55.10–-48.94% |
| 0.85.1 | 50-100kb | preview-reuse-execution | 2.70–3.32 | 1.28–1.41 | -59.56–-52.42% |
| 1.1.0 | lt10kb | preview | 0.48–0.50 | 0.73–0.91 | 51.12–82.02% |
| 1.1.0 | lt10kb | fresh-execution | 1.04–1.09 | 0.91–0.92 | -15.79–-11.52% |
| 1.1.0 | lt10kb | preview-reuse-execution | 1.03–1.04 | 1.24–1.39 | 21.14–34.20% |
| 1.1.0 | 10-25kb | preview | 0.59–0.73 | 0.54–0.63 | -15.81–-8.79% |
| 1.1.0 | 10-25kb | fresh-execution | 1.24–1.39 | 0.90–0.97 | -31.27–-27.24% |
| 1.1.0 | 10-25kb | preview-reuse-execution | 1.19–1.37 | 1.29–1.40 | -4.71–9.19% |
| 1.1.0 | 25-50kb | preview | 0.84–1.13 | 0.54–0.66 | -42.74–-35.41% |
| 1.1.0 | 25-50kb | fresh-execution | 1.65–1.94 | 0.93–0.99 | -48.94–-43.78% |
| 1.1.0 | 25-50kb | preview-reuse-execution | 1.55–1.88 | 1.33–1.43 | -27.35–-14.25% |
| 1.1.0 | 50-100kb | preview | 1.30–1.79 | 0.58–0.70 | -60.95–-55.32% |
| 1.1.0 | 50-100kb | fresh-execution | 2.74–3.35 | 1.42–1.53 | -54.91–-48.26% |
| 1.1.0 | 50-100kb | preview-reuse-execution | 2.71–3.32 | 1.29–1.36 | -60.08–-52.37% |

### Pi 1.1.0 individual cases

| Bucket | Scenario | Lifecycle | Built-in median | Accelerator median | Change | Built-in p95 | Accelerator p95 |
|---|---|---|---:|---:|---:|---:|---:|
| lt10kb | single-suffix | preview | 0.48 | 0.73 | 51.12% | 0.62 | 0.93 |
| lt10kb | single-suffix | fresh-execution | 1.04 | 0.91 | -12.33% | 1.29 | 1.13 |
| lt10kb | single-suffix | preview-reuse-execution | 1.04 | 1.30 | 25.36% | 1.34 | 1.45 |
| lt10kb | multi-positional | preview | 0.50 | 0.91 | 82.02% | 0.69 | 1.15 |
| lt10kb | multi-positional | fresh-execution | 1.09 | 0.91 | -15.79% | 1.42 | 1.09 |
| lt10kb | multi-positional | preview-reuse-execution | 1.04 | 1.39 | 34.20% | 1.29 | 1.58 |
| lt10kb | multi-suffix | preview | 0.48 | 0.75 | 53.86% | 0.66 | 1.03 |
| lt10kb | multi-suffix | fresh-execution | 1.04 | 0.92 | -11.52% | 1.23 | 1.06 |
| lt10kb | multi-suffix | preview-reuse-execution | 1.03 | 1.24 | 21.14% | 1.23 | 1.49 |
| 10-25kb | single-suffix | preview | 0.59 | 0.54 | -8.79% | 0.86 | 0.71 |
| 10-25kb | single-suffix | fresh-execution | 1.24 | 0.90 | -27.24% | 1.48 | 1.17 |
| 10-25kb | single-suffix | preview-reuse-execution | 1.19 | 1.30 | 9.19% | 1.44 | 1.54 |
| 10-25kb | multi-positional | preview | 0.73 | 0.63 | -12.83% | 1.00 | 0.86 |
| 10-25kb | multi-positional | fresh-execution | 1.39 | 0.96 | -31.27% | 1.60 | 1.13 |
| 10-25kb | multi-positional | preview-reuse-execution | 1.37 | 1.40 | 1.73% | 1.82 | 1.61 |
| 10-25kb | multi-suffix | preview | 0.72 | 0.60 | -15.81% | 0.89 | 0.74 |
| 10-25kb | multi-suffix | fresh-execution | 1.38 | 0.97 | -29.90% | 1.72 | 1.11 |
| 10-25kb | multi-suffix | preview-reuse-execution | 1.36 | 1.29 | -4.71% | 1.63 | 1.47 |
| 25-50kb | single-suffix | preview | 0.84 | 0.54 | -35.41% | 0.99 | 0.69 |
| 25-50kb | single-suffix | fresh-execution | 1.65 | 0.93 | -43.78% | 1.99 | 1.13 |
| 25-50kb | single-suffix | preview-reuse-execution | 1.55 | 1.33 | -14.25% | 2.08 | 1.54 |
| 25-50kb | multi-positional | preview | 1.11 | 0.66 | -41.00% | 1.25 | 0.80 |
| 25-50kb | multi-positional | fresh-execution | 1.90 | 0.98 | -48.19% | 2.19 | 1.19 |
| 25-50kb | multi-positional | preview-reuse-execution | 1.88 | 1.43 | -23.75% | 2.39 | 1.66 |
| 25-50kb | multi-suffix | preview | 1.13 | 0.65 | -42.74% | 1.28 | 0.79 |
| 25-50kb | multi-suffix | fresh-execution | 1.94 | 0.99 | -48.94% | 2.17 | 1.19 |
| 25-50kb | multi-suffix | preview-reuse-execution | 1.87 | 1.36 | -27.35% | 2.43 | 1.66 |
| 50-100kb | single-suffix | preview | 1.30 | 0.58 | -55.32% | 1.86 | 0.73 |
| 50-100kb | single-suffix | fresh-execution | 2.74 | 1.42 | -48.26% | 4.01 | 1.77 |
| 50-100kb | single-suffix | preview-reuse-execution | 2.71 | 1.29 | -52.37% | 3.22 | 1.52 |
| 50-100kb | multi-positional | preview | 1.78 | 0.70 | -60.55% | 2.08 | 0.90 |
| 50-100kb | multi-positional | fresh-execution | 3.29 | 1.48 | -54.91% | 4.17 | 1.78 |
| 50-100kb | multi-positional | preview-reuse-execution | 3.32 | 1.36 | -59.03% | 3.87 | 1.58 |
| 50-100kb | multi-suffix | preview | 1.79 | 0.70 | -60.95% | 2.01 | 0.84 |
| 50-100kb | multi-suffix | fresh-execution | 3.35 | 1.53 | -54.25% | 4.32 | 1.78 |
| 50-100kb | multi-suffix | preview-reuse-execution | 3.25 | 1.30 | -60.08% | 3.80 | 1.45 |

## Accelerator write-path experiments on Pi 1.1.0

These compare accelerator strategies, not built-in Pi against the accelerator. Twenty samples per strategy, 5 MiB fixture. Positional/suffix tests reuse a prepared plan and time execution after preparation; prefetch measures post-argument latency with a simulated 50 ms streaming window.

| Experiment | Disabled/full-write median | Enabled median | Reduction |
|---|---:|---:|---:|
| Positional write | 8.92 ms | 3.55 ms | 60.19% |
| Suffix write (first change at byte 5,242,888) | 8.95 ms | 3.58 ms | 60.02% |
| Prefetch | 13.13 ms | 10.97 ms | 16.49% |

## Interpretation

- Pi 1.1.0 does not materially close the large-file execution gap: built-in median is 251.40 ms versus 253.05 ms on 0.85.1; accelerator is 14.98 ms versus 15.60 ms. Small percentage differences are not proof of version-specific improvements.
- The accelerator still delivers roughly 16–30× lower median latency on these large-file execution/preview/interactive fixtures, and roughly 6–9× on the many-edit fixtures.
- At the ~5 KB fixture, accelerator preview is 0.25–0.41 ms slower and execution after preview is 0.22–0.35 ms slower. Fresh execution saves 0.12–0.17 ms. At ~18 KB, execution after preview is mixed. At ~38 KB and ~75 KB, all three measured lifecycles improve.
- Do not infer complete small-file interactive latency by adding separately collected preview and preview-reuse execution medians; they are distinct isolated measurements.
- These results support retaining the accelerator for larger files, not claiming a universal win or an end-to-end agent latency improvement.

## Commands and evidence

Run `npm test` and `npm run check` for each installed Pi version. Use `node --import tsx benchmark/<name>.ts` for `preview`, `interactive`, `group-scaling`, `positional-write`, `prefetch`, and `suffix-write`; run `interactive` again with `--equal-byte-length`. Use `node --import tsx benchmark/a-vs-b.ts --output <path>` and `node --import tsx benchmark/small-file-matrix.ts --output <path>` with their default sample counts.

Raw JSON, compatibility logs, installation log, environment records, and this summarizer are in `.artifacts/pi-1.1.0-retest-20261010/` (ignored by git). Successful task logs record elapsed time: the six 0.85.1 comparison suites took about 102 seconds total; all nine 1.1.0 suites took about 102 seconds total (59 seconds for the small-file matrix). Two initial runner setup failures occurred before their benchmark loops (missing external timer and expected npm manifest-pin mismatch); neither produced performance samples. No production code was modified. Local `node_modules` now contains Pi 1.1.0 while the manifest remains pinned to 0.85.1; `npm ci` restores the pinned dependency environment.
