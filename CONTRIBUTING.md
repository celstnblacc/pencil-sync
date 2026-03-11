# Contributing to pencil-sync

Thanks for your interest in contributing! Here's how to get started.

## Prerequisites

- Node.js >= 20
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Setup

```bash
git clone https://github.com/celstnblacc/pencil-sync.git
cd pencil-sync
npm install
npm run build
```

## Development workflow

1. **Fork** the repo and create a branch from `main`.
2. Make your changes in `src/`.
3. Build: `npm run build`
4. Run tests: `npm test`
5. Open a Pull Request against `main`.

## What to contribute

- Bug fixes (check open issues)
- New sync direction strategies or conflict resolution improvements
- Tests (unit and integration)
- Documentation fixes

Issues labeled `good first issue` or `help wanted` are a great starting point.

## Code conventions

- TypeScript, ES modules (`"type": "module"`)
- Tests use Vitest
- Config files use `pencil-sync.config.json` format (version 1)

## Commit messages

Keep commits focused. Use a short summary line describing what changed and why.

## Reporting bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your `pencil-sync.config.json` (redact any sensitive paths)
- Node.js version (`node --version`)

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
