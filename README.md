# Pi edit accelerator

An independently installed Pi extension for experimenting with faster exact edits while preserving the built-in `edit` tool as fallback.

## Current state

The extension:

- captures a public `createEditToolDefinition()` instance;
- registers one replacement tool named `edit`;
- uses a narrow exact-match path for safe ordinary files;
- delegates fuzzy, ambiguous, special-path, and unsupported inputs to the captured built-in tool;
- preserves built-in schema, argument preparation, prompt metadata, and renderers;
- preserves BOM and LF/CRLF on its exact path.

Commit `44fae2d` is **baseline B**: isolated extension wiring with built-in fallback and Pi's full-file diff helpers. Baseline A is Pi's unmodified built-in `edit` tool.

The current development tree is **candidate C**. It sparsely generates display and unified diffs for globally unique, normalization-neutral exact replacements, including partial-line and multiline edits with line insertion or deletion. Fuzzy, ambiguous, special-path, and other unsupported inputs delegate to the captured built-in tool.

Use `/edit-accelerator-stats` to view aggregate accelerated and fallback counts, and `/edit-accelerator-reset-stats` to reset them. Statistics are process-local and never retain paths, arguments, or file contents.

Candidate C also builds sparse interactive previews for eligible edits while preserving Pi's built-in renderer presentation. Unsupported preview inputs delegate to the captured built-in renderer. On a 5 MB, two-edit exploratory benchmark, preview median fell from 303 ms to 91 ms.

## Development

```sh
npm install --ignore-scripts
npm run check
npm test
npm run bench:preview
```

Try without installing:

```sh
pi -e /absolute/path/to/pi-edit-accelerator
```

Install locally:

```sh
pi install /absolute/path/to/pi-edit-accelerator
```

## Safety model

Pi exposes one `edit` tool. The extension wrapper uses its exact path only when compatibility preconditions are proven. Returning `undefined` from the exact attempt causes the wrapper to call its retained built-in edit definition directly; it does not perform a second tool-registry lookup.

Pi packages execute with full system access. Review this extension before installation.
