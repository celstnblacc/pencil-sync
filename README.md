# pencil-sync

![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-green)
![Tests: 154 passing](https://img.shields.io/badge/tests-154%20passing-brightgreen)
![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)

Bidirectional sync between [Pencil.dev](https://pencil.dev) designs and frontend code, powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Edit a component in Pencil — code updates automatically. Change code — the design follows. pencil-sync watches `.pen` files and your source tree, detects conflicts, and uses the Claude CLI to propagate changes in either direction — with budget controls, conflict resolution, and sync loop prevention.

## Prerequisites

- Node.js >= 20
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Install

```bash
npm install
npm run build
```

## Quick Start

```bash
# Generate a config file
pencil-sync init

# Edit pencil-sync.config.json to point to your .pen file and code directory

# Run a one-time sync
pencil-sync sync

# Start watching for changes
pencil-sync watch
```

## Syncing an Existing Project

To sync a project that lives in a separate repo, create a `pencil-sync.config.json` in that project and point `--config` at it:

```bash
# 1. Create a config in your project
cd /path/to/my-project
cat > pencil-sync.config.json << 'EOF'
{
  "version": 1,
  "mappings": [
    {
      "id": "my-app",
      "penFile": "./design.pen",
      "codeDir": "./src",
      "codeGlobs": ["components/**/*.tsx", "app/**/*.tsx", "**/*.css"],
      "direction": "both"
    }
  ],
  "settings": {
    "model": "claude-sonnet-4-6",
    "maxBudgetUsd": 0.5
  }
}
EOF

# 2. One-time sync
pencil-sync sync --config /path/to/my-project/pencil-sync.config.json

# 3. Or watch for live changes
pencil-sync watch --config /path/to/my-project/pencil-sync.config.json

# 4. Check status
pencil-sync status --config /path/to/my-project/pencil-sync.config.json
```

All paths in the config (`penFile`, `codeDir`, `stateFile`) are resolved relative to the config file's directory, so you can run pencil-sync from anywhere.

### Example: Next.js + Tailwind project

```jsonc
{
  "version": 1,
  "mappings": [
    {
      "id": "my-app",
      "penFile": "./design.pen",
      "codeDir": "./frontend",
      "codeGlobs": ["components/**/*.tsx", "app/**/*.tsx", "app/**/*.css"],
      "framework": "nextjs",
      "styling": "tailwind",
      "direction": "both"
    }
  ],
  "settings": {
    "model": "claude-sonnet-4-6",
    "maxBudgetUsd": 0.5,
    "conflictStrategy": "prompt"
  }
}
```

```bash
# Sync only design-to-code
pencil-sync sync -c ./pencil-sync.config.json -d pen-to-code

# Watch a specific mapping (useful with multiple mappings)
pencil-sync watch -c ./pencil-sync.config.json -m my-app
```

## Commands

| Command | Description |
|---------|-------------|
| `pencil-sync init` | Create a starter config file in the current directory |
| `pencil-sync sync` | Run a one-time sync for all (or a specific) mapping |
| `pencil-sync watch` | Start auto-sync file watcher |
| `pencil-sync status` | Show sync state for all mappings |

### Options

```
-c, --config <path>   Path to config file
-v, --verbose         Enable debug logging
```

### Sync options

```
pencil-sync sync -d pen-to-code     # Force design-to-code direction
pencil-sync sync -d code-to-pen     # Force code-to-design direction
pencil-sync sync -m my-app          # Sync a specific mapping only
```

## Configuration

Config file: `pencil-sync.config.json` (also supports `.pencil-sync.json` and JSONC with comments)

```jsonc
{
  "version": 1,
  "mappings": [
    {
      "id": "my-app",
      "penFile": "./design.pen",
      "codeDir": "./src",
      "codeGlobs": ["components/**/*.tsx", "app/**/*.tsx", "*.css"],
      "direction": "both"
    }
  ],
  "settings": {
    "debounceMs": 2000,
    "model": "claude-sonnet-4-6",
    "maxBudgetUsd": 0.5,
    "conflictStrategy": "prompt",
    "stateFile": ".pencil-sync-state.json",
    "logLevel": "info"
  }
}
```

### Mapping fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier for this mapping |
| `penFile` | Yes | Path to the `.pen` design file (relative to config) |
| `codeDir` | Yes | Path to the code directory (relative to config) |
| `codeGlobs` | Yes | Glob patterns for code files to track |
| `direction` | Yes | `"both"`, `"pen-to-code"`, or `"code-to-pen"` |
| `penScreens` | No | Specific screens to sync (defaults to all) |
| `framework` | No | Auto-detected: `nextjs`, `react`, `vue`, `svelte`, `astro` |
| `styling` | No | Auto-detected: `tailwind`, `styled-components`, `css-modules`, `css` |
| `styleFiles` | No | CSS/config files with design tokens (e.g., `["app/globals.css", "tailwind.config.js"]`). Enables the color fast path and provides context to Claude for other changes. |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `debounceMs` | `2000` | Debounce delay for file change events |
| `model` | `claude-sonnet-4-6` | Claude model to use |
| `maxBudgetUsd` | `0.5` | Maximum spend per session (enforced) |
| `conflictStrategy` | `prompt` | How to handle conflicts: `prompt`, `pen-wins`, `code-wins`, `auto-merge` |
| `stateFile` | `.pencil-sync-state.json` | Path to sync state file |
| `logLevel` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## How It Works

```
File Change (chokidar)
  -> debounced trigger
    -> SyncEngine.syncMapping()
      -> LockManager.acquire()
      -> ConflictDetector (hash comparison)
      -> syncPenToCode() or syncCodeToPen()
        -> Snapshot .pen nodes, diff against previous state
        -> Fill changes:  direct CSS variable replacement (fast path)
        -> Other changes: build prompt → spawn Claude CLI → diff file hashes
      -> StateStore.updateMappingState()
      -> LockManager.release() (with grace period)
```

### Color sync: direct replacement (fast path)

Fill/color changes are applied directly by pencil-sync as a find-and-replace in your CSS file. This is faster and more reliable than Claude CLI for colors because it's a mechanical hex→RGB conversion — no reasoning needed. Claude CLI is still used for text, typography, and layout changes that require understanding the component structure.

When a `.pen` node's `fill` property changes:

1. The old and new hex values are converted to space-separated RGB channels (`#224846` → `34 72 70`)
2. All CSS variable declarations matching the old RGB value are replaced with the new RGB in **every theme block** (`:root`, `[data-theme="monokai"]`, `[data-theme="nord"]`, etc.)
3. The updated CSS file is written back

**Requirements for the fast path:**

- `styleFiles` must include a `.css` file in the mapping config
- CSS variables must use the RGB channel format: `--color-token-name: R G B;`
- Multiple theme blocks are supported — all occurrences are updated in one pass

Non-color changes (text content, font size, font weight, etc.) are still delegated to Claude CLI with a focused diff-based prompt.

```jsonc
// Example: enable the fast path by adding styleFiles
{
  "id": "my-app",
  "penFile": "./design.pen",
  "codeDir": "./src",
  "codeGlobs": ["**/*.tsx", "**/*.css"],
  "direction": "both",
  "styleFiles": ["app/globals.css", "tailwind.config.js"]
}
```

### Change detection

Changes are detected by comparing SHA-256 hashes of files before and after Claude runs. This is more reliable than parsing Claude's natural language output.

### Budget enforcement

Token usage is parsed from Claude CLI verbose output and accumulated per session. If cumulative spend reaches `maxBudgetUsd`, further sync operations are blocked.

### Sync loop prevention

When a sync writes files (e.g., pen-to-code writes code files), the watcher would normally detect those writes and trigger a reverse sync. This is prevented by:

1. A grace period (`debounceMs + 500ms`) that keeps the lock held after sync completes
2. Direction-aware trigger suppression that ignores reverse-direction echoes

### Conflict resolution

When both the `.pen` file and code files have changed since the last sync:

- **prompt** — Interactive: asks the user to choose a resolution
- **pen-wins** — Design takes priority, overwrites code
- **code-wins** — Code takes priority, overwrites design
- **auto-merge** — Claude attempts to merge both sides

## MCP Integration

By default, pencil-sync reads `.pen` files directly from disk and delegates code edits to the Claude CLI using standard file tools (`Edit`, `Write`, `Read`, `Glob`, `Grep`). Enabling the **Pencil MCP server** gives the Claude subprocess direct, structured access to the `.pen` file — enabling richer code-to-design sync (reading node IDs, updating design properties, taking screenshots) without raw file parsing.

### How it works

```
Without MCP (default)
  Claude subprocess
    └── file tools only (Edit, Write, Read, Glob, Grep)
    └── reads .pen file as raw JSON snapshot

With MCP enabled
  Claude subprocess
    └── file tools + Pencil MCP tools
          mcp__pencil__batch_get       — read nodes by ID or pattern
          mcp__pencil__batch_design    — insert / update / delete nodes
          mcp__pencil__set_variables   — update design variables / themes
          mcp__pencil__get_screenshot  — visual validation
    └── .pen contents accessed via encrypted MCP protocol (not raw file read)
```

### Setup

1. Install and configure the [Pencil MCP server](https://pencil.dev/docs/mcp).

2. Create an MCP config file (e.g. `mcp.json`):

```json
{
  "mcpServers": {
    "pencil": {
      "command": "npx",
      "args": ["-y", "@pencil/mcp-server"]
    }
  }
}
```

3. Add `mcpConfigPath` to your `pencil-sync.config.json`:

```jsonc
{
  "settings": {
    "model": "claude-sonnet-4-6",
    "maxBudgetUsd": 0.5,
    "mcpConfigPath": "./mcp.json"
  }
}
```

### MCP usage flow (end-to-end)

1. Run a one-time code-to-design sync with MCP enabled:

```bash
pencil-sync sync -d code-to-pen -c ./pencil-sync.config.json
```

2. Verify MCP tool usage in logs (look for `mcp__pencil__` tool calls instead of raw `.pen` JSON writes):

```bash
DEBUG=pencil-sync:* pencil-sync sync -d code-to-pen -c ./pencil-sync.config.json
```

3. Run watcher mode for ongoing sync:

```bash
pencil-sync watch -c ./pencil-sync.config.json
```

4. Validate state after a few edits:

```bash
pencil-sync status -c ./pencil-sync.config.json
```

### Effect on sync direction

| Direction | Without MCP | With MCP |
|-----------|-------------|----------|
| pen-to-code | Reads `.pen` snapshot → color fast path or Claude file edits | Same (snapshot read is local) |
| code-to-pen | Claude edits `.pen` as raw JSON | Claude uses `batch_design` / `set_variables` to write structured updates |
| conflict auto-merge | Claude reasons over both sides via file tools | Claude can visually verify via `get_screenshot` |

MCP is most impactful for **code-to-pen** and **auto-merge** — the directions that need to write back to the design file.

### Security note

`.pen` files are encrypted. The Pencil MCP server is the only supported way to read or write their contents. If `mcpConfigPath` is not set, pencil-sync falls back to treating the `.pen` file as a JSON snapshot (works for design-to-code; code-to-pen writes may be unreliable).

---

## Development

```bash
npm run dev          # TypeScript watch mode
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
npm run build        # Build for production
```

## Docker

```bash
docker build -t pencil-sync .
docker run -v $(pwd):/project pencil-sync watch --config /project/pencil-sync.config.json
```

## Project Structure

```
src/
  index.ts              CLI entry point (commander)
  sync-engine.ts        Orchestrates sync: locks, conflicts, direction routing, budget
  pen-to-code.ts        Design -> code sync with filesystem diffing
  code-to-pen.ts        Code -> design sync with hash diffing
  claude-runner.ts       Spawns Claude CLI, parses token usage
  lock-manager.ts        Per-mapping mutex with grace period and loop prevention
  state-store.ts         SHA-256 hashes persisted to JSON, file collection, diffing
  conflict-detector.ts   Detects when both sides changed since last sync
  prompt-builder.ts      Loads markdown templates, fills placeholders
  config.ts              Config loading, framework/styling auto-detection
  watcher.ts             Chokidar file watching with debounced triggers
  logger.ts              Colored timestamped logging
  __tests__/             154 tests across 10 test files (vitest)
prompts/
  pen-to-code.md         Template for design-to-code prompts
  code-to-pen.md         Template for code-to-design prompts
  conflict-resolve.md    Template for conflict resolution prompts
```

## Keywords

pencil.dev, claude code, design to code, code to design, .pen files, bidirectional sync, AI coding, vibe coding, design sync, MCP, Anthropic, frontend tooling

## License

[MIT](LICENSE)
