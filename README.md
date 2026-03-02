# pencil-sync

Bidirectional sync between `.pen` design files and frontend code via the Claude CLI.

pencil-sync watches for changes in your design files or code, detects conflicts, and spawns Claude with tailored prompts to propagate changes in either direction.

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
      "id": "viddocs-ui",
      "penFile": "./viddocs_ui_monokai.pen",
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
pencil-sync watch -c ./pencil-sync.config.json -m viddocs-ui
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
        -> Build prompt from markdown template
        -> Spawn Claude CLI (claude -p --max-turns 1)
        -> Diff file hashes before/after to detect changes
      -> StateStore.updateMappingState()
      -> LockManager.release() (with grace period)
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
  __tests__/             92 tests across 9 test files (vitest)
prompts/
  pen-to-code.md         Template for design-to-code prompts
  code-to-pen.md         Template for code-to-design prompts
  conflict-resolve.md    Template for conflict resolution prompts
```

## License

ISC
