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

The exact path currently uses Pi's public full-file display and unified diff helpers. This implementation is **baseline B**: it establishes isolated extension wiring, built-in fallback, and compatibility but does not yet remove the measured diff hotspot. Baseline A is Pi's unmodified built-in `edit` tool. The next implementation step is sparse generation of both outputs from known edit ranges.

## Development

```sh
npm install --ignore-scripts
npm run check
npm test
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
