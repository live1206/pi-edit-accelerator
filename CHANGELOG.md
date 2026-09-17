# Changelog

## Unreleased

- Defer complete output construction until execution needs it.
- Write eligible equal-byte-length edits directly at their verified byte positions.
- Report aggregate positional-write counts and add an isolated positional-write benchmark.

## 0.1.2 - 2026-09-17

- Reuse matching in-flight preview plans during execution after exact file-content validation.
- Report aggregate preview-plan reuse counts in accelerator statistics.
- Add a combined interactive preview-and-execution benchmark.

## 0.1.1 - 2026-09-17

- Reduced exact-edit full-file scans and allocations.
- Added scoped execution and preview CPU profiling tools.
- Reduced the 5 MB stress-fixture median from 419 ms to 46 ms versus Pi's built-in edit tool.
- Reduced the matching preview median from 288 ms to 44 ms.
- Added public implementation notes and a Rust decision gate.

## 0.1.0 - 2026-09-17

- Added sparse exact-edit execution and interactive previews.
- Added built-in fallback for fuzzy and unsupported edits.
- Added partial-line and multiline replacements, insertion, deletion, BOM, CRLF, and UTF-8 handling.
- Added privacy-safe accelerated/fallback statistics.
