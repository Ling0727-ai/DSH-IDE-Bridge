---
name: dsh-ide-bridge
description: Explicitly route work through a connected VS Code, Cursor, or JetBrains IDE. Use when the user mentions the current/open file, editor, selection, cursor, IDE diagnostics, definitions, references, implementations, rename/refactor, opening a file in the IDE, or asks to operate the IDE.
---

# DSH IDE Bridge

Use the `ide_*` tools as the source of truth for live editor state and IDE language intelligence.

## Required Dispatch

Call an IDE tool before answering when the request depends on any of these:

- current or open editor/file;
- cursor or selected text;
- live IDE errors and warnings;
- definitions, references, implementations, or hover information;
- IDE rename/refactoring;
- opening or revealing a source location;
- formatting, saving, navigation, or another explicit IDE command.

Do not infer current editor state from the workspace filesystem.

## Tool Choice

| Need | Tool |
| --- | --- |
| Confirm connection or workspace | `ide_status` |
| Current file, cursor, selection, nearby source | `ide_context` |
| Open and reveal a file | `ide_open` |
| Errors and warnings | `ide_diagnostics` |
| Symbols, definitions, references, implementations | `ide_symbols` |
| Guarded text or whole-symbol edit | `ide_edit` |
| Project-aware rename | `ide_rename_symbol` |
| Explicit allowlisted IDE action | `ide_command` |

Use `read`, `grep`, and `glob` for broad textual exploration, generated files, or workspaces without a matching IDE window. Use IDE semantic tools when textual matches are ambiguous or the requested operation is editor-specific.

## Workflow

1. If the target window is unclear, call `ide_status`. With multiple windows, use an absolute file path to bind the intended workspace; never guess.
2. For current-editor requests, call `ide_context` with `include_text: false` first. Request nearby text only when needed.
3. Before a semantic edit, retrieve the symbol or relevant source. Prefer `ide_rename_symbol` for renames and `ide_edit` symbol operations for complete definitions.
4. After editing, inspect returned warning/error diagnostics. Call `ide_diagnostics` again only when broader verification is needed.
5. Keep defaults compact. Set `include_low_value: true`, larger limits, or hint severity only when the task requires that detail.

## Safety

- Do not bypass workspace confinement.
- Do not use `ide_command` for a command the user did not request or the workflow does not require.
- Do not retry another IDE window after an outside-workspace rejection unless the target workspace is explicitly identified.
- When the IDE reports ambiguity or unsupported behavior, state it and use a safe filesystem or language-server fallback when appropriate.
