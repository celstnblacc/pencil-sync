# Changelog

All notable changes to pencil-sync will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.1.0] — 2026-03-16

### Added
- `pencil-sync sync --dry-run` / `-n` — preview what would change without writing any files
- GitHub Actions CI: test matrix on Node 20 + 22 (`.github/workflows/ci.yml`)
- GitHub Actions Security: ShipGuard SAST gate pinned to `==0.3.2` (`.github/workflows/security.yml`)
- Docker: healthcheck (`node dist/index.js --version` every 60s)
- Docker: memory limit 512M / CPU limit 1.0 in `docker-compose.yml`
- `docs/` directory; moved `REVIEW.md` and `SOUL.md` from repo root

### Fixed
- Dockerfile `|| true` on Claude CLI install — container could start silently broken; build now fails explicitly
- Docker container ran as root — switched to `USER node` (UID 1000); Linux hosts must `chown -R 1000:1000` the project dir
- `.superharness/` directory incorrectly tracked in git — contained machine-specific absolute paths; untracked and gitignored
- `extractErrorMessage()` utility extracted to `utils.ts` — removes 5 inline repetitions of `instanceof Error` guard
- Duplicate `shouldPersist` boolean in `SyncEngine` — extracted to named constant

### Added (core features)
- Bidirectional sync between `.pen` design files and frontend code via Claude CLI
- `pencil-sync init` — generate a starter config
- `pencil-sync sync` — one-time sync with optional direction override (`pen-to-code` / `code-to-pen`)
- `pencil-sync watch` — continuous file watcher with debounce and sync-loop prevention
- `pencil-sync status` — show last sync time, direction, and tracked file count per mapping
- Color fast path: direct CSS variable replacement for fill/color changes (no Claude call)
- Budget enforcement: token usage parsed from Claude CLI `--verbose`, blocks when `maxBudgetUsd` exceeded
- Conflict detection and resolution strategies: `prompt`, `pen-wins`, `code-wins`, `auto-merge`
- MCP integration: optional Pencil MCP server for structured `.pen` read/write
- Exponential backoff retry for transient MCP server errors
- Atomic state writes with `.tmp`+rename and checksum verification
- Path traversal prevention and prototype pollution guards in config loading
- JSONC config support (comments in JSON config files)
- Docker support
- 308 tests across 18 test files (Vitest)

## [0.1.2] — 2026-03-26

### Fixed
- CI: replace `--fail-on high` with `--severity high` in ShipGuard Security workflow — `--fail-on` is not a valid flag (caused exit code 2 on every run)

### Chore
- CLAUDE.md: protect against accidental deletion of youtube-model-feeder source project

## [0.1.3] — 2026-03-26

### Chore
- Add `AGENTS.md` scaffold (agent protocol compliance)
- Update `package-lock.json` lockfile
