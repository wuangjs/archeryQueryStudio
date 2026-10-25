# Third-party notices

Archery Query Studio bundles the following runtime libraries into the webview bundle:

- **CodeMirror 6** packages (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/lang-sql`, `@codemirror/language`, `@codemirror/search`, `@codemirror/autocomplete`) — MIT License — https://github.com/codemirror
- **@lezer/highlight** — MIT License — https://github.com/lezer-parser/highlight

Build and test dependencies (not bundled into the extension runtime) include esbuild (MIT), TypeScript (Apache-2.0), Vitest (MIT), and `@vscode/vsce` (MIT). See `package-lock.json` for the full dependency tree and each package for its license text.

Archery itself is a separate open-source project by hhyo and contributors, licensed under Apache-2.0: https://github.com/hhyo/Archery. This extension is not affiliated with or endorsed by the Archery project.
