# pencil-sync

Bidirectional sync between Pencil.dev `.pen` design files and frontend code via the Claude CLI.

## Commands

```bash
npm run build        # Compile TypeScript → dist/
npm test             # Run all tests (Vitest)
npm run test:watch   # Tests in watch mode
npm start            # Run CLI (node dist/index.js)
```

## Tech Stack

- **Language:** TypeScript (ESM, `"type": "module"`)
- **Runtime:** Node.js >= 20
- **Testing:** Vitest
- **Key deps:** chokidar (file watching), commander (CLI), chalk + ora (output)

## Project Structure

```
src/
  index.ts             CLI entry point (commander)
  sync-engine.ts       Orchestrates pen→code and code→pen sync
  pen-to-code.ts       Reads .pen snapshots, applies color fast path or spawns Claude
  code-to-pen.ts       Detects code changes, spawns Claude to update .pen
  claude-runner.ts     Spawns Claude CLI, parses token usage
  prompt-builder.ts    Builds prompts from templates + snapshots
  config.ts            Loads and validates pencil-sync.config.json
  conflict-detector.ts Detects concurrent edits
  state-store.ts       Persists sync state (hashes, snapshots)
  lock-manager.ts      File-based locking
  watcher.ts           Chokidar file watcher
  logger.ts            Chalk-based logger
  types.ts             Shared types and defaults
prompts/               Prompt templates (pen-to-code, code-to-pen, conflict-resolve)
```

## Conventions

- `.pen` file contents are encrypted — always use Pencil MCP tools, never `Read`/`Grep`
- All imports use `.js` extensions (ESM resolution)
- Config merging uses `safeMerge()` to prevent prototype pollution
- Budget tracking via token parsing from Claude CLI `--verbose` stderr
