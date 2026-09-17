# DSH IDE Bridge for VS Code

Companion extension for the `dsh-ide-bridge` DeepSeek Harness plugin. It exposes the current VS Code-compatible IDE window to DSH through an authenticated loopback-only protocol.

The extension starts after the IDE has loaded. Use the command palette actions `DSH IDE Bridge: Show Status` and `DSH IDE Bridge: Restart Bridge` for diagnostics.

Security defaults:

- listens only on `127.0.0.1`;
- generates a new random token for every IDE process;
- rejects file access outside open workspace folders;
- allows only configured command identifiers;
- uses guarded exact replacements or language-service symbol ranges for edits.

See the root project README for DSH installation and the complete tool reference.
