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

## [Unreleased]

- 2026-07-21: docs: align CODE_OF_CONDUCT.md with concise 5-line CoC (replaces Contributor Covenant boilerplate with internal style)
### Fixed
- Budget pre-flight now projects output-token cost (3× input, conservative), not just input — a large generation can no longer slip past `maxBudgetUsd`
- Claude CLI token usage falls back to a length-based estimate (with a warning) when `--verbose` output can't be parsed, instead of silently recording zero spend and disabling budget enforcement entirely

### Documentation
- Add `docs/AUDIT-2026-06-12.md` — full v0.1.3 project audit (build, tests, security, architecture, correctness, CI). Flags the `.pen` encryption/reader contradiction, budget-bypass gaps, dual glob engines, and in-memory lock manager

## [0.1.4] - 2026-06-12

### Refactor
- Share one ignored-directory list (`IGNORED_DIRS` / `IGNORED_GLOBS`) between watcher and state-hasher; adds `.next` to the skip set, closing the drift where build output was hashed but not watched (P2-E)
- Replace POSIX-only `validatePathWithinDirectory` in config.ts with the cross-platform `validatePathWithin` from utils.ts; removes the duplicate function and fixes path-traversal guard on Windows (P2-D)
- 322 tests passing (6 new tests added across ignored-dirs and config suites)
- 2026-06-12: fix(pen-to-code): report color fast-path no-ops instead of silent success (P2-C)

- 2026-06-12: fix(budget): refresh model pricing table and warn on unknown-model fallback
- 2026-06-12: fix(sync): unify glob matching so watcher and hasher agree on patterns (P2-B)
- 2026-06-12: chore(tooling): add ESLint flat config with typescript-eslint
- 2026-06-12: chore(tooling): measure coverage and enforce thresholds (v8 provider, lines≥81%)
- 2026-06-12: chore(release): bump to v0.1.5 (fast-path fix, glob unification, ESLint, coverage)
- 2026-06-12: chore: ignore .serena/, .hablatone, coverage/ in .gitignore
- 2026-06-18: docs(plan): add iteration plan for Executor interface refactor (Option A)

- 2026-06-18: refactor(executor): add Executor interface and LocalClaudeExecutor wrapping runClaude

- 2026-06-18: refactor(sync): route pen-to-code and code-to-pen through injected Executor

- 2026-06-18: refactor(sync): SyncEngine owns a single Executor and injects it into both directions
- 2026-06-18: feat(mcp): route logger output to stderr in MCP mode
- 2026-06-18: feat(mcp): add pencil-sync-mcp binary with MCP stdio server skeleton
- 2026-06-18: feat(mcp): add pencil_get_config, pencil_diff_design, pencil_diff_code, pencil_detect_conflict tools
- 2026-06-18: feat(mcp): add pencil_build_prompt, pencil_apply_fill_changes, pencil_record_sync tools
- 2026-06-18: chore(release): bump version to 0.2.0 — MCP server feature (minor)
- 2026-06-18: feat(project-dir): replace flat state file with .pencil-sync/ directory
- 2026-06-18: feat(doctor): add pencil-sync doctor preflight command
- 2026-06-18: feat(detect): add detectStyling() css-modules/css detection and findPenFiles() helper
- 2026-06-18: feat(setup): add interactive pencil-sync setup wizard replacing init command
- 2026-06-18: chore(release): bump to v0.3.0 (.pencil-sync/ dir, doctor, auto-detection, setup wizard)
- 2026-06-18: feat(mcp): pencil_record_sync now writes last-run.json alongside state
- 2026-06-18: feat(setup): add --non-interactive flag with --pen-file/--code-dir/--framework/--styling/--direction/--budget
- 2026-06-18: feat(setup): add step counter, section headers, and colored auto-detected values
- 2026-06-18: feat(setup): add confirmation summary screen before writing config
- 2026-06-18: feat(setup): add back navigation to setup wizard (step-array loop, "back" returns to previous step)
- 2026-06-18: feat(tui): ink/react deps, JSX config, logger TUI hook, tui command skeleton
- 2026-06-18: feat(tui): static MappingPanel component with mapping state snapshot
- 2026-06-18: feat(tui): EventFeed component + SyncEngine.onEvent callback for live updates
- 2026-06-18: feat(tui): keybinds (s/d/q), BudgetMeter, and full pencil-sync tui command wired
- 2026-06-18: chore(release): bump to v0.4.0 (setup wizard back-nav + TUI dashboard with ink/react)
- 2026-06-18: fix(tui): wire tui command to load config and pass to startTui; load states from StateStore
- 2026-06-18: chore(release): bump to v0.4.1 (tui wiring fix)
- 2026-06-18: docs(pen-format): correct false ".pen is encrypted" guardrail — .pen is plaintext JSON (resolves P1-A); add docs/PEN-FORMAT.md schema reference
- 2026-06-18: fix(pen-snapshot): canonicalize object/array fill and cornerRadius so real-schema diffs are detected
- 2026-06-18: feat(pen-snapshot): track document variables/themes as design tokens in snapshot diff
- 2026-06-18: feat(pen-snapshot): resolve ref/reusable components when flattening the pen tree
- 2026-06-18: chore(release): bump to v0.5.0 (pen parser real-schema hardening)
- 2026-06-19: fix(config): allow penFile outside configDir — read-only input must not be traversal-guarded
- 2026-06-19: chore(release): bump to v0.5.1 (penFile path-traversal fix)
- 2026-06-19: fix(setup): validate direction field at config load and wizard input; remove 'pen' key from non-interactive answerMap to prevent infinite loop
- 2026-06-19: fix(claude-runner): expand ~ in mcpConfigPath using HOME env var
- 2026-06-19: feat(ai-runner): multi-provider AI runner (Anthropic, OpenAI-compat, Google) + PencilMcpClient; code-to-pen now uses direct API calls when aiProvider is set, eliminating Claude CLI subprocess MCP conflict
- 2026-06-19: fix(pencil-mcp-client): add setVariables() method — token syncs must go through set_variables, not batch_design
- 2026-06-19: feat(mcp-server): add pencil_invalidate_state tool + StateStore.clearMappingState() — enables re-seeding stale hashes after a design rebuild
- 2026-06-19: fix(pencil-sync command): correct step 6 to route token-only changes through set_variables; add state invalidation guidance
- 2026-06-19: fix(claude-runner): strip ANTHROPIC_API_KEY from child env to guarantee subscription billing on executor path
- 2026-06-19: feat(code-to-pen): log active engine at INFO level ("Engine: claude-cli" / "Engine: <provider> API")
- 2026-06-19: fix(cost-labels): clarify costUsd is an API-rate estimate in budget warnings and debug logs; actual billing depends on plan
- 2026-06-19: feat(code-to-pen): add explicit provider field — settings.provider="claude-cli" forces subscription executor even when aiProvider is also set
- 2026-06-19: fix(config): warn at load time when apiBaseUrl uses minimax.chat (China domain) instead of minimaxi.chat (international) to prevent misleading 401 errors
- 2026-06-24: fix(pen-snapshot): diffPenSnapshots now detects added/cleared props, whole-node deletions, and removed tokens on existing nodes (brand-new nodes still intentionally skipped) [audit]
- 2026-06-24: fix(pen-to-code): hexToRgbChannels parses rgb()/rgba() and rejects invalid-length hex instead of silently coercing a wrong RGB [audit]
- 2026-06-24: fix(pen-to-code): applyFillChanges applies color replacements in a single keyed pass to stop chained diffs from corrupting each other (#224846→#333333 then #333333→#444444) [audit]
- 2026-06-24: fix(pen-to-code): surfaced fill zero-match warnings in mixed-diff results and treat Claude no-op (success + zero files changed) as failure [audit iter-1]
- 2026-06-24: fix(pencil-mcp-client): batchGet/batchDesign now throw on isError and non-JSON instead of swallowing errors; fix(code-to-pen): syncCodeToPenDirect returns failure on unreadable .pen or no-op after batch_design [audit iter-3]
- 2026-06-24: fix(provider): honor settings.provider in runner creation and env-key resolution; pen-to-code errors clearly on non-claude-cli provider [audit iter-4]
- 2026-06-24: fix(ai-runners): add claude-haiku-4-5 alias to pricing table; pass systemInstruction to Google getGenerativeModel; warn on OpenAI finish_reason:length truncation; add SSRF guard for non-https and localhost apiBaseUrl [audit iter-10]
- 2026-06-24: chore(release): bump version to 0.5.2 — 10-iteration audit remediation (iters 1-10)
- 2026-06-24: fix(ci): add .npmrc legacy-peer-deps=true to resolve openai peerOptional zod v3 conflict on Node 22
- 2026-06-24: fix(config): migrate zod schema params from v3 API (required_error/invalid_type_error/errorMap) to v4 API (message/error); fix mcp-server null→undefined for penSnapshot
- 2026-06-24: chore: transfer repo to artificemachine org; update package.json repository URL; bump to v0.5.3
- 2026-06-24: fix(ci): rename .shipguard.yml exclude_rules→disable_rules (correct ShipGuard field); add JS-002 suppression (Array.prototype.join false positive); add JS-004 JS-002 suppression rationale; add resolve import and symlink traversal guard to state-store.ts collectFiles
- 2026-06-25: chore: remove personal workspace path from tracked files
- 2026-06-25: chore: remove personal workspace path from tracked files
