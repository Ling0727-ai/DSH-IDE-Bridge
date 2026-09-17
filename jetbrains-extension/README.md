# DSH IDE Bridge for JetBrains

Companion plugin for the `dsh-ide-bridge` DeepSeek Harness bundle. One build supports IntelliJ IDEA, PyCharm, WebStorm, GoLand, CLion, DataGrip, and other IntelliJ Platform IDEs with the language module.

The application service starts automatically when a project opens. It publishes an authenticated loopback endpoint in the shared operating-system discovery directory. DSH then selects the instance whose project root best matches its current workspace.

The implementation uses PSI for symbols, reference/implementation searches for navigation, the rename refactoring processor for project-wide rename, daemon highlights for diagnostics, and write commands for guarded edits.

Build with:

```powershell
gradle buildPlugin
```

Install the ZIP from `build/distributions/` through `Settings / Plugins / Install Plugin from Disk...`.
