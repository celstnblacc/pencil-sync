import { createInterface } from "node:readline";
import { log } from "./logger.js";
import { LockManager } from "./lock-manager.js";
import { StateStore } from "./state-store.js";
import { detectConflict, isConflict } from "./conflict-detector.js";
import { syncPenToCode } from "./pen-to-code.js";
import { syncCodeToPen } from "./code-to-pen.js";
import { runClaude, estimateCost, estimateInputTokens, MODEL_PRICING } from "./claude-runner.js";
import { buildConflictPrompt } from "./prompt-builder.js";
import type {
  PencilSyncConfig,
  MappingConfig,
  MappingState,
  SyncResult,
  ConflictInfo,
  TokenUsage,
} from "./types.js";

const ASK_USER_TIMEOUT_MS = 30_000;

export class SyncEngine {
  private lockManager: LockManager;
  private stateStore: StateStore;
  private cumulativeSpendUsd = 0;

  constructor(private config: PencilSyncConfig) {
    this.stateStore = new StateStore(config.settings.stateFile);
    this.lockManager = new LockManager(config.settings.debounceMs);
  }

  async initialize(): Promise<void> {
    await this.stateStore.load();
    for (const mapping of this.config.mappings) {
      await this.stateStore.initMappingState(mapping);
    }
  }

  getCumulativeSpendUsd(): number {
    return this.cumulativeSpendUsd;
  }

  getRemainingBudgetUsd(): number {
    return this.config.settings.maxBudgetUsd - this.cumulativeSpendUsd;
  }

  private checkBudget(mapping: MappingConfig, prompt?: string): string | undefined {
    const remaining = this.getRemainingBudgetUsd();
    if (remaining <= 0) {
      return `Budget exhausted ($${this.cumulativeSpendUsd.toFixed(4)} spent of $${this.config.settings.maxBudgetUsd} limit)`;
    }

    // Pre-flight estimate: if we have a prompt, estimate input cost alone
    if (prompt) {
      const estimatedInput = estimateInputTokens(prompt);
      const pricing = MODEL_PRICING[this.config.settings.model] ?? MODEL_PRICING["claude-sonnet-4-6"];
      const estimatedInputCost = (estimatedInput / 1_000_000) * pricing.input;
      if (estimatedInputCost > remaining) {
        return `Estimated input cost ($${estimatedInputCost.toFixed(4)}) exceeds remaining budget ($${remaining.toFixed(4)})`;
      }
    }

    return undefined;
  }

  private trackSpend(tokenUsage?: TokenUsage): void {
    if (!tokenUsage) return;
    const cost = estimateCost(this.config.settings.model, tokenUsage);
    this.cumulativeSpendUsd += cost;
    log.debug(`Token usage: ${tokenUsage.input} in / ${tokenUsage.output} out, cost: $${cost.toFixed(4)}, cumulative: $${this.cumulativeSpendUsd.toFixed(4)}`);
  }

  async syncMapping(
    mapping: MappingConfig,
    triggerDirection: "pen-changed" | "code-changed" | "manual",
    manualDirection?: "pen-to-code" | "code-to-pen",
  ): Promise<SyncResult> {
    const budgetError = this.checkBudget(mapping);
    if (budgetError) {
      log.warn(`Budget limit reached for ${mapping.id}: ${budgetError}`);
      return {
        success: false,
        direction: mapping.direction,
        mappingId: mapping.id,
        filesChanged: [],
        error: budgetError,
      };
    }

    // Lock check
    if (!this.lockManager.acquire(mapping.id)) {
      return {
        success: false,
        direction: mapping.direction,
        mappingId: mapping.id,
        filesChanged: [],
        error: "Sync already in progress (locked)",
      };
    }

    try {
      const previousState = this.stateStore.getMappingState(mapping.id);
      const conflict = await detectConflict(mapping, previousState);

      if (isConflict(conflict) && mapping.direction === "both") {
        const result = await this.handleConflict(mapping, conflict, previousState);
        this.trackSpend(result.tokenUsage);
        if (result.success) {
          await this.stateStore.updateMappingState(mapping, result.direction, result.penSnapshot);
          this.lockManager.setLastSyncDirection(mapping.id, result.direction);
        }
        return result;
      }

      let result: SyncResult;

      if (manualDirection) {
        result = await this.executeSyncDirection(mapping, manualDirection, conflict, previousState);
      } else if (triggerDirection === "pen-changed") {
        if (mapping.direction === "code-to-pen") {
          log.debug(`Ignoring .pen change for code-to-pen mapping ${mapping.id}`);
          return { success: true, direction: "code-to-pen", mappingId: mapping.id, filesChanged: [] };
        }
        result = await this.executeSyncDirection(mapping, "pen-to-code", conflict, previousState);
      } else if (triggerDirection === "code-changed") {
        if (mapping.direction === "pen-to-code") {
          log.debug(`Ignoring code change for pen-to-code mapping ${mapping.id}`);
          return { success: true, direction: "pen-to-code", mappingId: mapping.id, filesChanged: [] };
        }
        result = await this.executeSyncDirection(mapping, "code-to-pen", conflict, previousState);
      } else {
        // Manual with auto direction
        if (conflict.penChanged && !conflict.codeChanged) {
          result = await this.executeSyncDirection(mapping, "pen-to-code", conflict, previousState);
        } else if (conflict.codeChanged && !conflict.penChanged) {
          result = await this.executeSyncDirection(mapping, "code-to-pen", conflict, previousState);
        } else {
          // Default to pen-to-code: design is the source of truth when both sides changed or neither changed
          result = await this.executeSyncDirection(mapping, "pen-to-code", conflict, previousState);
        }
      }

      this.trackSpend(result.tokenUsage);

      if (result.success) {
        await this.stateStore.updateMappingState(mapping, result.direction, result.penSnapshot);
        this.lockManager.setLastSyncDirection(mapping.id, result.direction);
      }

      return result;
    } finally {
      this.lockManager.release(mapping.id);
    }
  }

  private async executeSyncDirection(
    mapping: MappingConfig,
    direction: "pen-to-code" | "code-to-pen",
    conflict: ConflictInfo,
    previousState: MappingState | undefined,
  ): Promise<SyncResult> {
    if (direction === "pen-to-code") {
      return syncPenToCode(mapping, this.config.settings, previousState);
    } else {
      return syncCodeToPen(mapping, this.config.settings, conflict.changedCodeFiles);
    }
  }

  private async handleConflict(
    mapping: MappingConfig,
    conflict: ConflictInfo,
    previousState: MappingState | undefined,
  ): Promise<SyncResult> {
    const strategy = this.config.settings.conflictStrategy;

    log.warn(`Conflict in ${mapping.id} — strategy: ${strategy}`);

    switch (strategy) {
      case "pen-wins":
        return this.executeSyncDirection(mapping, "pen-to-code", conflict, previousState);

      case "code-wins":
        return this.executeSyncDirection(mapping, "code-to-pen", conflict, previousState);

      case "auto-merge":
        return this.autoMergeConflict(mapping, conflict);

      case "prompt":
      default:
        return this.promptUserForResolution(mapping, conflict, previousState);
    }
  }

  private async autoMergeConflict(
    mapping: MappingConfig,
    conflict: ConflictInfo,
  ): Promise<SyncResult> {
    log.info(`Auto-merging conflict for ${mapping.id} via Claude`);

    const prompt = await buildConflictPrompt(mapping, conflict.changedCodeFiles);
    const result = await runClaude({
      prompt,
      model: this.config.settings.model,
      cwd: mapping.codeDir,
    });

    if (!result.success) {
      return {
        success: false,
        direction: "both",
        mappingId: mapping.id,
        filesChanged: [],
        error: `Auto-merge failed: ${result.stderr.slice(0, 200)}`,
        tokenUsage: result.tokenUsage,
      };
    }

    return {
      success: true,
      direction: "both",
      mappingId: mapping.id,
      filesChanged: [mapping.penFile, ...conflict.changedCodeFiles],
      tokenUsage: result.tokenUsage,
    };
  }

  private async promptUserForResolution(
    mapping: MappingConfig,
    conflict: ConflictInfo,
    previousState: MappingState | undefined,
  ): Promise<SyncResult> {
    log.warn(`\nConflict detected for mapping "${mapping.id}":`);
    log.warn(`  .pen file changed: ${conflict.penChanged}`);
    log.warn(`  Code files changed: ${conflict.changedCodeFiles.join(", ")}`);
    log.info("How would you like to resolve this?");
    log.info("  [p] Design wins (pen-to-code)");
    log.info("  [c] Code wins (code-to-pen)");
    log.info("  [m] Auto-merge via Claude");
    log.info("  [s] Skip this sync");

    const answer = await askUser("Choose [p/c/m/s]: ");

    switch (answer.trim().toLowerCase()) {
      case "p":
        return this.executeSyncDirection(mapping, "pen-to-code", conflict, previousState);
      case "c":
        return this.executeSyncDirection(mapping, "code-to-pen", conflict, previousState);
      case "m":
        return this.autoMergeConflict(mapping, conflict);
      case "s":
      default:
        log.info("Skipping sync");
        return {
          success: true,
          direction: "both",
          mappingId: mapping.id,
          filesChanged: [],
        };
    }
  }

  getStateStore(): StateStore {
    return this.stateStore;
  }

  getLockManager(): LockManager {
    return this.lockManager;
  }

  shutdown(): void {
    this.lockManager.releaseAll();
  }
}

/**
 * C4: Non-interactive stdin guard + timeout.
 * Returns empty string if stdin is not a TTY (non-interactive mode) or on timeout.
 */
function askUser(question: string): Promise<string> {
  // Guard: non-interactive environments (CI, piped stdin, etc.)
  if (!process.stdin.isTTY) {
    log.warn("Non-interactive mode detected (stdin is not a TTY), skipping user prompt");
    return Promise.resolve("");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log.warn(`User prompt timed out after ${ASK_USER_TIMEOUT_MS / 1000}s, defaulting to skip`);
      rl.close();
      resolve("");
    }, ASK_USER_TIMEOUT_MS);

    rl.question(question, (answer) => {
      clearTimeout(timeout);
      rl.close();
      resolve(answer);
    });
  });
}
