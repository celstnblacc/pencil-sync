import { watch, type FSWatcher } from "chokidar";
import { join } from "node:path";
import { log } from "./logger.js";
import { SyncEngine } from "./sync-engine.js";
import { getCssStyleFile, extractErrorMessage } from "./utils.js";
import type { MappingConfig, PencilSyncConfig } from "./types.js";

export class Watcher {
  private watchers: FSWatcher[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private engine: SyncEngine;
  private pendingChanges = new Map<string, NodeJS.Timeout>();
  private inFlightSyncs = new Set<string>();

  constructor(
    private config: PencilSyncConfig,
    engine: SyncEngine,
  ) {
    this.engine = engine;
  }

  async start(mappingFilter?: string): Promise<void> {
    const mappings = mappingFilter
      ? this.config.mappings.filter((m) => m.id === mappingFilter)
      : this.config.mappings;

    if (mappings.length === 0) {
      throw new Error(
        mappingFilter
          ? `Mapping "${mappingFilter}" not found`
          : "No mappings configured",
      );
    }

    for (const mapping of mappings) {
      this.watchMapping(mapping);
      this.printMappingInfo(mapping);
    }

    log.info(`Watching ${mappings.length} mapping(s). Press Ctrl+C to stop.`);
  }

  private printMappingInfo(mapping: MappingConfig): void {
    const cssFile = getCssStyleFile(mapping);
    const hasFastPath = !!cssFile;

    log.info("");
    log.info(`── Mapping: ${mapping.id} ──`);
    log.info(`  .pen file:  ${mapping.penFile}`);
    log.info(`  Code dir:   ${mapping.codeDir}`);
    log.info(`  Direction:  ${mapping.direction}`);
    log.info(`  Framework:  ${mapping.framework ?? "auto-detect"}`);
    log.info(`  Styling:    ${mapping.styling ?? "auto-detect"}`);

    if (hasFastPath) {
      log.info(`  Color sync: direct replacement in ${cssFile} (instant, all theme blocks)`);
      log.info(`  Other sync: text, typography → Claude CLI`);
    } else {
      log.info(`  Color sync: via Claude CLI (add .css to "styleFiles" for direct replacement)`);
      log.info(`  Other sync: text, typography → Claude CLI`);
    }

    if (mapping.styleFiles && mapping.styleFiles.length > 0) {
      log.info(`  Style files: ${mapping.styleFiles.join(", ")}`);
    }
    log.info("");
  }

  private watchMapping(mapping: MappingConfig): void {
    const { direction, debounceMs } = {
      direction: mapping.direction,
      debounceMs: this.config.settings.debounceMs,
    };

    if (direction === "pen-to-code" || direction === "both") {
      const penWatcher = watch(mapping.penFile, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500 },
      });

      penWatcher.on("change", () => {
        this.debouncedSync(mapping, "pen-changed", debounceMs);
      });
      penWatcher.on("add", () => {
        this.debouncedSync(mapping, "pen-changed", debounceMs);
      });
      penWatcher.on("unlink", () => {
        this.debouncedSync(mapping, "pen-changed", debounceMs);
      });
      penWatcher.on("error", (error) => {
        log.error(`Watcher error for ${mapping.penFile}: ${error instanceof Error ? error.message : String(error)}`);
      });

      this.watchers.push(penWatcher);
      log.info(`Watching .pen file: ${mapping.penFile}`);
    }

    if (direction === "code-to-pen" || direction === "both") {
      const watchPaths = mapping.codeGlobs.map((g) =>
        join(mapping.codeDir, g),
      );

      const codeWatcher = watch(watchPaths, {
        ignoreInitial: true,
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/dist/**",
          "**/.next/**",
        ],
        awaitWriteFinish: { stabilityThreshold: 300 },
      });

      codeWatcher.on("change", (path) => {
        log.debug(`Code file changed: ${path}`);
        this.debouncedSync(mapping, "code-changed", debounceMs);
      });

      codeWatcher.on("add", (path) => {
        log.debug(`Code file added: ${path}`);
        this.debouncedSync(mapping, "code-changed", debounceMs);
      });
      codeWatcher.on("unlink", (path) => {
        log.debug(`Code file deleted: ${path}`);
        this.debouncedSync(mapping, "code-changed", debounceMs);
      });
      codeWatcher.on("error", (error) => {
        log.error(`Watcher error for ${watchPaths.join(", ")}: ${error instanceof Error ? error.message : String(error)}`);
      });

      this.watchers.push(codeWatcher);
      log.info(`Watching code: ${watchPaths.join(", ")}`);
    }
  }

  private debouncedSync(
    mapping: MappingConfig,
    trigger: "pen-changed" | "code-changed",
    debounceMs: number,
  ): void {
    const key = `${mapping.id}:${trigger}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(key);

      // Check if this trigger is an echo from a recent sync in the opposite direction
      if (this.engine.getLockManager().shouldSuppressTrigger(mapping.id, trigger)) {
        return;
      }

      // If a sync is already in-flight for this mapping, queue this change
      if (this.inFlightSyncs.has(mapping.id)) {
        const existingPending = this.pendingChanges.get(key);
        if (existingPending) clearTimeout(existingPending);

        const pendingTimer = setTimeout(() => {
          this.pendingChanges.delete(key);
          this.debouncedSync(mapping, trigger, debounceMs);
        }, debounceMs);

        this.pendingChanges.set(key, pendingTimer);
        return;
      }

      log.info(`Change detected (${trigger}) for mapping "${mapping.id}"`);

      this.inFlightSyncs.add(mapping.id);

      try {
        const result = await this.engine.syncMapping(mapping, trigger);
        if (result.success) {
          if (result.filesChanged.length > 0) {
            log.success(
              `Sync complete: ${result.filesChanged.length} files updated`,
            );
          } else {
            log.info("Sync complete: no changes needed");
          }
        } else {
          log.error(`Sync failed: ${result.error ?? "unknown error"}`);
        }
      } catch (err) {
        log.error(`Sync error: ${extractErrorMessage(err)}`);
      } finally {
        this.inFlightSyncs.delete(mapping.id);
      }
    }, debounceMs);

    this.debounceTimers.set(key, timer);
  }

  async stop(): Promise<void> {
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const [, timer] of this.pendingChanges) {
      clearTimeout(timer);
    }
    this.pendingChanges.clear();

    await Promise.all(this.watchers.map((w) => w.close()));
    this.watchers = [];
    this.inFlightSyncs.clear();
    this.engine.shutdown();
    log.info("Watcher stopped");
  }
}
