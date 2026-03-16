#!/usr/bin/env node

import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { setLogLevel, log } from "./logger.js";
import { SyncEngine } from "./sync-engine.js";
import { Watcher } from "./watcher.js";
import { shutdownManager } from "./shutdown.js";
import { extractErrorMessage } from "./utils.js";
import type { PencilSyncConfig, SyncDirection } from "./types.js";

const program = new Command();

async function getVersion(): Promise<string> {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

program
  .name("pencil-sync")
  .description("Bidirectional sync between .pen design files and frontend code")
  .version(await getVersion())
  .option("-c, --config <path>", "Path to config file")
  .option("-v, --verbose", "Enable debug logging");

program
  .command("watch")
  .description("Start auto-sync file watcher")
  .option("-m, --mapping <id>", "Watch specific mapping only")
  .action(async (opts) => {
    const config = await initConfig(program.opts());
    const engine = new SyncEngine(config);
    await engine.initialize();

    const watcher = new Watcher(config, engine);

    // Register cleanup handlers
    shutdownManager.registerCleanup("watcher", async () => {
      await watcher.stop();
    });

    installShutdownHandlers();

    await watcher.start(opts.mapping);

    // Never-resolving promise keeps the event loop alive so the file watcher continues running
    await new Promise(() => {});
  });

program
  .command("sync")
  .description("Run a one-time sync")
  .option("-d, --direction <dir>", "Sync direction: pen-to-code | code-to-pen")
  .option("-m, --mapping <id>", "Sync specific mapping only")
  .option("-n, --dry-run", "Preview what would change without writing any files")
  .action(async (opts) => {
    const config = await initConfig(program.opts());
    const engine = new SyncEngine(config);
    await engine.initialize();

    // Register cleanup handlers
    shutdownManager.registerCleanup("engine", () => {
      engine.shutdown();
    });

    installShutdownHandlers();

    const mappings = opts.mapping
      ? config.mappings.filter((m) => m.id === opts.mapping)
      : config.mappings;

    if (mappings.length === 0) {
      log.error(`Mapping "${opts.mapping}" not found`);
      process.exit(1);
    }

    const direction = opts.direction as SyncDirection | undefined;
    if (direction && direction !== "pen-to-code" && direction !== "code-to-pen") {
      log.error(`Invalid direction "${direction}". Use: pen-to-code | code-to-pen`);
      process.exit(1);
    }

    const dryRun = !!opts.dryRun;
    if (dryRun) log.info("[dry-run] No files will be written.");

    let hasErrors = false;

    for (const mapping of mappings) {
      const spinnerLabel = dryRun ? `Previewing "${mapping.id}"...` : `Syncing "${mapping.id}"...`;
      const spinner = ora(spinnerLabel).start();
      try {
        const result = await engine.syncMapping(
          mapping,
          "manual",
          direction as "pen-to-code" | "code-to-pen" | undefined,
          dryRun,
        );

        if (result.success) {
          const count = result.filesChanged.length;
          if (dryRun) {
            spinner.info(
              count > 0
                ? `${mapping.id}: would change ${count} file(s): ${result.filesChanged.join(", ")}`
                : `${mapping.id}: no changes detected`,
            );
          } else {
            spinner.succeed(
              `${mapping.id}: ${count} files synced`,
            );
          }
        } else {
          spinner.fail(`${mapping.id}: ${result.error}`);
          hasErrors = true;
        }
      } catch (err) {
        spinner.fail(
          `${mapping.id}: ${extractErrorMessage(err)}`,
        );
        hasErrors = true;
      }
    }

    engine.shutdown();
    process.exit(hasErrors ? 1 : 0);
  });

program
  .command("init")
  .description("Create a pencil-sync config file in the current directory")
  .action(async () => {
    const configPath = join(process.cwd(), "pencil-sync.config.json");

    try {
      await access(configPath);
      log.error(`Config already exists: ${configPath}`);
      log.info("Delete it first or edit it directly.");
      process.exit(1);
    } catch {
      // File doesn't exist — good, proceed
    }

    const template = {
      version: 1,
      mappings: [
        {
          id: "my-app",
          penFile: "./design.pen",
          codeDir: "./src",
          codeGlobs: ["components/**/*.tsx", "app/**/*.tsx", "*.css"],
          direction: "both",
        },
      ],
      settings: {
        debounceMs: 2000,
        model: "claude-sonnet-4-6",
        maxBudgetUsd: 0.5,
        conflictStrategy: "prompt",
        stateFile: ".pencil-sync-state.json",
        logLevel: "info",
      },
    };

    await writeFile(configPath, JSON.stringify(template, null, 2));
    log.success(`Config created: ${configPath}`);
    log.info("Edit the config to set your .pen file and code directory paths.");
  });

program
  .command("status")
  .description("Show sync state for all mappings")
  .action(async () => {
    const config = await initConfig(program.opts());
    const engine = new SyncEngine(config);
    await engine.initialize();

    // Register cleanup handlers
    shutdownManager.registerCleanup("engine", () => {
      engine.shutdown();
    });

    installShutdownHandlers();

    const store = engine.getStateStore();

    console.log(chalk.bold("\nPencil Sync Status\n"));

    for (const mapping of config.mappings) {
      const state = store.getMappingState(mapping.id);
      console.log(chalk.bold(`  ${mapping.id}`));
      console.log(`    .pen:       ${mapping.penFile}`);
      console.log(`    code:       ${mapping.codeDir}`);
      console.log(`    direction:  ${mapping.direction}`);
      console.log(`    framework:  ${mapping.framework ?? "auto"}`);
      console.log(`    styling:    ${mapping.styling ?? "auto"}`);

      if (state) {
        const ago = timeSince(state.lastSyncTimestamp);
        const files = Object.keys(state.codeHashes).length;
        console.log(`    last sync:  ${ago} (${state.lastSyncDirection})`);
        console.log(`    tracked:    ${files} code files`);
        console.log(`    pen hash:   ${state.penHash.slice(0, 12)}...`);
      } else {
        console.log(chalk.yellow(`    state:      not yet synced`));
      }
      console.log();
    }

    engine.shutdown();
    process.exit(0);
  });

function installShutdownHandlers(): void {
  shutdownManager.installSignalHandlers();
  shutdownManager.installUnhandledRejectionHandler();
  shutdownManager.installUncaughtExceptionHandler();
}

async function initConfig(
  opts: { config?: string; verbose?: boolean },
): Promise<PencilSyncConfig> {
  if (opts.verbose) setLogLevel("debug");

  try {
    const config = await loadConfig(opts.config);
    setLogLevel(config.settings.logLevel);
    if (opts.verbose) setLogLevel("debug"); // verbose flag overrides config
    return config;
  } catch (err) {
    log.error(extractErrorMessage(err));
    process.exit(1);
  }
}

function timeSince(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

program.parse();
