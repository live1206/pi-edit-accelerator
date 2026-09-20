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

Clean benchmark on Node 22.23.2, Pi 0.85.1, Linux/WSL2, AMD EPYC 7763, using a 5 MB file and two distant exact edits:

| Execution | Median | p95 |
|---|---:|---:|
| Pi built-in edit | 401.11 ms | 495.65 ms |
| Sparse extension | 33.56 ms | 39.27 ms |

Version 0.1.5 reduced median execution latency by approximately 92% on this stress fixture.

An exploratory interactive-preview benchmark measured:

| Preview | Median |
|---|---:|
| Pi built-in preview | 299.08 ms |
| Sparse extension preview | 15.69 ms |

Version 0.1.5 also preserves sparse scaling for large batches of independent line-local edits:

| Batch execution | Sparse extension | Pi built-in | Median reduction |
|---|---:|---:|---:|
| 100 edits, 140 KB file | 11.67 ms | 101.50 ms | 89% |
| 200 edits, 278 KB file | 33.41 ms | 366.12 ms | 91% |

Specialized writes avoid rewriting unchanged file regions:

| Prepared write path | Sparse write | Full-file write | Median reduction |
|---|---:|---:|---:|
| Equal-byte-length positional writes | 4.50 ms | 28.32 ms | 84% |
| Length-changing near-end suffix write | 5.67 ms | 26.91 ms | 79% |

These results demonstrate large-file scaling potential, not guaranteed gains for every edit. Normal-session impact depends on file sizes and fast-path frequency.

## Install

Install from the public GitHub repository:

```sh
pi install git:github.com/live1206/pi-edit-accelerator@v0.1.5
```

Try it for one run without changing settings:

```sh
pi -e git:github.com/live1206/pi-edit-accelerator@v0.1.5
```

Restart Pi or run `/reload` after installation.

Remove it with:

```sh
pi remove git:github.com/live1206/pi-edit-accelerator@v0.1.5
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
/edit-accelerator-export-stats <directory>
/edit-accelerator-reset-stats
```

Statistics include aggregate edit outcomes, optimization counts, fast-path percentage, and eligible-file size buckets (`<100 KB`, `100 KB-1 MB`, `1-5 MB`, and `>5 MB`). Export writes a timestamped JSON snapshot with random process-session and snapshot-interval identifiers. No paths, arguments, replacement text, file contents, or exact file sizes are retained. Export once before each pilot process exits; reset starts a new interval within the same process session.

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

On Linux x64 with Rust installed, build and validate the optional Phase 1 native planner:

```sh
npm run native:test
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
npm run profile -- --mode execution --output .artifacts/execution.cpuprofile --report .artifacts/execution-profile.json
npm run profile:analyze -- .artifacts/execution.cpuprofile --output .artifacts/execution-analysis.json
```

The test suite compares sparse output with Pi's built-in result, display diff, unified patch, and final file bytes.

## Implementation notes

See [docs/edit-acceleration.md](docs/edit-acceleration.md) for:

- architecture and fallback behavior;
- sparse hunk generation;
- benchmark methodology;
- current compatibility coverage;
- CPU-profiling plan;
- the decision gate for native acceleration.

See [docs/rust-hybrid-implementation-plan.md](docs/rust-hybrid-implementation-plan.md) for the hybrid design and [docs/rust-hybrid-validation.md](docs/rust-hybrid-validation.md) for current validation results.

## Roadmap

1. Complete the privacy-safe 100–200-call pilot.
2. Prototype buffer-first native preview preparation.
3. Add startup, memory, allocation, and GC measurements.
4. Add permission, symlink, abort, concurrency, malformed-preview, and cross-platform tests.
5. Validate Linux, macOS, Windows, Node, and Bun before broad rollout.

## License

MIT. See [LICENSE](LICENSE).
