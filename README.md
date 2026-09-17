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
| Pi built-in edit | 423.37 ms | 502.22 ms |
| Sparse extension | 37.86 ms | 50.62 ms |

Version 0.1.2 reduced median execution latency by approximately 91% on this stress fixture.

An exploratory interactive-preview benchmark measured:

| Preview | Median |
|---|---:|
| Pi built-in preview | 287.98 ms |
| Sparse extension preview | 22.35 ms |

These results demonstrate large-file scaling potential, not guaranteed gains for every edit. Normal-session impact depends on file sizes and fast-path frequency.

## Install

Install from the public GitHub repository:

```sh
pi install git:github.com/live1206/pi-edit-accelerator@v0.1.2
```

Try it for one run without changing settings:

```sh
pi -e git:github.com/live1206/pi-edit-accelerator@v0.1.2
```

Restart Pi or run `/reload` after installation.

Remove it with:

```sh
pi remove git:github.com/live1206/pi-edit-accelerator@v0.1.2
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
- positional writes when every replacement preserves its UTF-8 byte length.

All edits are matched against the original content. The extension preserves Pi-compatible file output, display diff, unified patch, and `firstChangedLine`.

## Built-in fallback

The extension delegates to Pi's captured built-in implementation when it cannot prove fast-path compatibility. This includes fuzzy normalization, duplicate or overlapping matches, special path forms, malformed input, and inaccessible files.

Pi exposes only one `edit` tool. Fallback calls the retained built-in tool object directly; it does not expose a second tool or perform another registry lookup.

## Statistics

Use these process-local commands during a session:

```text
/edit-accelerator-stats
/edit-accelerator-reset-stats
```

They report only total, accelerated, fallback, preview-plan reuse, and positional-write counts plus the fast-path percentage. No paths, arguments, replacement text, or file contents are retained.

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
- the decision gate for a possible Rust implementation.

## Roadmap

1. Collect real-session accelerated/fallback rates.
2. Add permission, symlink, abort, concurrency, malformed-preview, and cross-platform tests.
3. Collect preview-plan reuse rates and watch fallback latency during the pilot.
4. Combine the remaining normalization and matching scans where practical.
5. Validate Linux, macOS, Windows, Node, and Bun.
6. Prototype Rust only if a coarse CPU-bound stage still offers meaningful savings after JS/native conversion.

## License

MIT. See [LICENSE](LICENSE).
