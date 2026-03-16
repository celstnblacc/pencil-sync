# pencil-sync — Code Review

**Date:** 2026-03-03
**Reviewer:** Claude Opus 4.6
**Version:** 0.1.0
**Updated:** 2026-03-03 — All 4 high-priority issues resolved, test suite added (154 tests)

---

## Overview

A CLI tool for **bidirectional synchronization between `.pen` design files and frontend code**, using the Claude CLI as the AI bridge. It watches for file changes, detects conflicts, and spawns `claude -p` with tailored prompts to propagate design or code changes in either direction.

| | |
|---|---|
| **Stack** | TypeScript (ES2022, NodeNext), commander, chokidar, chalk, ora, vitest |
| **Source** | ~850 LOC across 11 source files + 3 prompt templates + 10 test files (154 tests) |
| **Entry** | `src/index.ts` — CLI with `watch`, `sync`, `init`, `status` commands |
| **Engine** | `src/sync-engine.ts` — orchestrates lock, conflict detection, direction routing |
| **AI Bridge** | `src/claude-runner.ts` — spawns `claude` CLI as subprocess |

---

## Architecture

```
CLI (index.ts)
 ├── watch command → Watcher (chokidar) → debounced triggers
 ├── sync command  → direct invocation
 ├── init command  → config template
 └── status command → state display

SyncEngine (sync-engine.ts)
 ├── LockManager      — per-mapping mutex with grace period
 ├── StateStore       — SHA-256 hashes of .pen + code files, persisted to JSON
 ├── ConflictDetector — compares current hashes vs last-sync state
 ├── pen-to-code.ts   — design → code (spawns Claude with pen-to-code prompt)
 ├── code-to-pen.ts   — code → design (spawns Claude with code-to-pen prompt)
 └── PromptBuilder    — loads markdown templates, fills placeholders

Config (config.ts)
 ├── Auto-detects framework (Next.js, React, Vue, Svelte, Astro)
 ├── Auto-detects styling (Tailwind, styled-components, CSS)
 └── Resolves paths relative to config file location
```

---

## Strengths

### Clean separation of concerns
Every module has a single responsibility. The sync engine orchestrates without knowing how Claude is invoked or how files are watched. The lock manager knows nothing about sync directions. This makes the codebase easy to navigate and reason about.

### Conflict resolution system
Four strategies (`prompt`, `pen-wins`, `code-wins`, `auto-merge`) with a well-structured handler in `sync-engine.ts:109-131`. The interactive prompt fallback (`promptUserForResolution`) gives users control when automatic resolution isn't appropriate.

### Lock manager with grace period and loop prevention
`lock-manager.ts` prevents concurrent syncs on the same mapping and holds the lock for a configurable grace period (`debounceMs + 500ms`) after completion to absorb filesystem event noise. Tracks last sync direction per mapping to suppress reverse-direction echo triggers, preventing infinite sync loops.

### Auto-detection
`config.ts` inspects the project for framework config files (`next.config.js`, `svelte.config.js`, etc.) and `package.json` dependencies to auto-populate `framework` and `styling` fields. Reduces config burden for users.

### Prompt engineering
The three prompt templates (`prompts/*.md`) are well-structured with clear instructions for Claude:
- `pen-to-code.md` — preserves functional code while updating visual properties
- `code-to-pen.md` — reflects code changes back into the design
- `conflict-resolve.md` — merges both sides with design-wins priority for aesthetics

### Budget enforcement
`sync-engine.ts` tracks cumulative token spend per session using parsed token data from Claude CLI verbose output. Pre-flight checks estimate input cost and block execution when the configured `maxBudgetUsd` would be exceeded. Model pricing table covers Sonnet, Haiku, and Opus.

### Filesystem-based change detection
`pen-to-code.ts` and `code-to-pen.ts` snapshot file hashes before/after Claude runs and diff to detect actual changes — replacing the previous fragile regex parsing of Claude's natural language output.

### Test suite
154 tests across 10 test files using Vitest, covering all core modules: lock-manager, state-store, conflict-detector, claude-runner, pen-to-code, code-to-pen, sync-engine, config, prompt-builder, and watcher.

### Other positives
- TypeScript strict mode with zero type errors
- JSONC config support (comments stripped before parsing)
- Docker + docker-compose support for containerized operation
- Debounced file watching with `awaitWriteFinish` stability thresholds
- Graceful shutdown handling (SIGINT/SIGTERM)
- `--max-turns 3` safety net on Claude CLI invocations

---

## Issues

### High Priority (All Resolved)

#### 1. ~~`parseChangedFiles` is extremely fragile~~ — FIXED

**Resolution:** Replaced regex-based output parsing with filesystem diffing. Both `pen-to-code.ts` and `code-to-pen.ts` now snapshot file hashes via `hashCodeDir()` / `hashFile()` before Claude runs, then diff against post-run hashes to detect actual changes. Added `diffHashes()` utility to `state-store.ts`. Also fixed a bug in `globToRegex()` where `**/*.tsx` failed to match root-level files like `app.tsx`.

---

#### 2. ~~`maxBudgetUsd` is never enforced~~ — FIXED

**Resolution:** Added `TokenUsage` type and `tokenUsage` field to `ClaudeRunResult`. `claude-runner.ts` now parses token counts from Claude CLI `--verbose` stderr output, with a model pricing lookup table (`MODEL_PRICING`). `SyncEngine` tracks cumulative spend per session, performs pre-flight budget estimates, and blocks execution when `maxBudgetUsd` would be exceeded. Also added `--max-turns 3` as a safety net to prevent runaway agent loops.

---

#### 3. ~~Potential infinite sync loop~~ — FIXED

**Resolution:** Two-pronged fix:
1. **Dynamic grace period:** `LockManager` now accepts `debounceMs` in its constructor and sets grace period to `debounceMs + 500ms`, ensuring the lock outlasts the debounce window.
2. **Direction-aware suppression:** `LockManager` tracks last sync direction per mapping via `setLastSyncDirection()`. `shouldSuppressTrigger()` detects reverse-direction echo triggers (e.g., code-changed after pen-to-code sync) and suppresses them within the grace window. `Watcher` calls this check before triggering sync.

---

#### 4. ~~No tests~~ — FIXED

**Resolution:** Added Vitest with 154 tests across 10 test files:
- `lock-manager.test.ts` (17) — acquire/release, grace period timing, direction suppression, stale locks
- `state-store.test.ts` (16) — hash functions, `diffHashes`, `globToRegex`, state persistence
- `conflict-detector.test.ts` (7) — all conflict scenarios
- `claude-runner.test.ts` (22) — token parsing, cost estimation, spawn mock, chunked I/O, timeout
- `pen-to-code.test.ts` (13) — color fast path, theme blocks, Claude CLI for text/typography
- `code-to-pen.test.ts` (5) — hash diff with mocked Claude
- `sync-engine.test.ts` (19) — orchestration, budget, conflicts, all resolution strategies
- `config.test.ts` (20) — framework/styling detection, config loading, JSONC, duplicate IDs
- `prompt-builder.test.ts` (19) — template loading, snapshots, diffing
- `watcher.test.ts` (8) — debounce, echo suppression, lifecycle

---

### Medium Priority

#### 5. Watcher ignores file deletions
**File:** `src/watcher.ts:77-85`

The code watcher listens for `change` and `add` events but not `unlink`. If a developer deletes a component file, the code-to-pen sync won't trigger to remove it from the design.

---

#### 6. `detectFramework` treats all Vite projects as React
**File:** `src/config.ts:38-39`

```typescript
["vite.config.ts", "react"],
["vite.config.js", "react"],
```

Vite is used with Vue, Svelte, Solid, and others. This misclassifies non-React Vite projects, which could lead to incorrect prompt templates.

---

#### 7. ~~No config validation~~ — PARTIALLY FIXED

**Resolution:** Added duplicate mapping ID detection (throws on load). JSONC comment stripping fixed to not corrupt glob patterns inside strings. Remaining: `direction` value validation, existence checks for `penFile`/`codeDir`.

---

#### 8. `globToRegex` is naive
**File:** `src/state-store.ts:121-129`

The custom glob converter handles `**`, `*`, `?`, and `.` escaping but not:
- Brace expansion: `{tsx,jsx}`
- Character classes: `[a-z]`
- Negation: `!pattern`

Works for simple globs in the example config but will silently fail on complex patterns.

---

#### 9. Dockerfile masks install failures
**File:** `Dockerfile:7`

```dockerfile
RUN npm install -g @anthropic-ai/claude-code || true
```

If the Claude CLI fails to install, the image builds successfully but won't function at runtime. Should fail the build instead.

---

### Low Priority

#### 10. ~~`code-to-pen` hardcodes `filesChanged`~~ — FIXED
**File:** `src/code-to-pen.ts`

Resolved as part of Fix 1. Now diffs `.pen` file hash before/after Claude runs and only reports it as changed if the hash actually differs.

---

#### 11. `initMappingState` hashes on first load
**File:** `src/state-store.ts:53-56`

On first run (no state file), every mapping's entire code directory gets hashed. For large projects with many matching files, this could cause noticeable startup delay.

---

#### 12. `dist/` directory exists
Despite being in `.gitignore`, the `dist/` directory is present. Not an issue yet (no git repo), but will cause noise when `git init` happens unless cleaned up first.

---

## Remaining Suggestions

| Suggestion | Impact | Effort |
|---|---|---|
| ~~Replace output parsing with fs diffing~~ | ~~Eliminates silent failures~~ | ~~Done~~ |
| Add `--dry-run` mode | Better debugging/testing | Low |
| Add `unlink` event handling | Catches file deletions | Low |
| Add config schema validation | Clear error messages | Medium |
| Use a proper glob library (`picomatch`) | Correct glob matching | Low |
| ~~Add `--max-turns 1` to Claude CLI args~~ | ~~Prevent runaway agent loops~~ | ~~Done~~ |
| Remove `|| true` from Dockerfile | Fail fast on bad builds | Trivial |

---

## Summary

Solid foundation with clean architecture and good separation of concerns. The prompt templates are well-crafted, the conflict resolution system is thoughtful, and the auto-detection reduces setup friction.

All 4 high-priority issues have been resolved:
- **Filesystem diffing** replaced brittle regex output parsing (+ bonus `globToRegex` bug fix)
- **Budget enforcement** with token tracking, model pricing, pre-flight estimates, and session-level spend limits
- **Sync loop prevention** via dynamic grace periods and direction-aware trigger suppression
- **154 tests** across 10 test files provide a safety net for all core modules

Remaining medium-priority items (file deletion handling, config validation, Vite framework detection) are non-critical and can be addressed incrementally.
