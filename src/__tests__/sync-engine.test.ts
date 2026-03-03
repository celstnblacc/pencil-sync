import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PencilSyncConfig, MappingConfig } from "../types.js";

vi.mock("../claude-runner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../claude-runner.js")>();
  return {
    ...original,
    runClaude: vi.fn().mockResolvedValue({
      success: true,
      stdout: "Done",
      stderr: "",
      exitCode: 0,
      tokenUsage: { input: 1000, output: 200 },
    }),
  };
});

// Mock prompt-builder
vi.mock("../prompt-builder.js", () => ({
  buildPenToCodePrompt: vi.fn().mockResolvedValue("pen-to-code prompt"),
  buildCodeToPenPrompt: vi.fn().mockResolvedValue("code-to-pen prompt"),
  buildConflictPrompt: vi.fn().mockResolvedValue("conflict prompt"),
}));

// Mock pen-snapshot (used directly by pen-to-code.ts and code-to-pen.ts)
// Return a non-fill diff so Claude CLI gets called for pen-to-code syncs
vi.mock("../pen-snapshot.js", () => ({
  snapshotPenFile: vi.fn().mockReturnValue({}),
  diffPenSnapshots: vi.fn().mockReturnValue([
    { nodeId: "t1", nodeName: "title", prop: "content", oldValue: "old", newValue: "new" },
  ]),
  formatDiffForPrompt: vi.fn().mockReturnValue(""),
}));

vi.mock("../utils.js", () => ({
  getCssStyleFile: vi.fn().mockReturnValue(undefined),
  validatePathWithin: vi.fn().mockImplementation((_base: string, file: string) => file),
}));

const { SyncEngine } = await import("../sync-engine.js");
const { runClaude } = await import("../claude-runner.js");

const mockedRunClaude = vi.mocked(runClaude);

describe("SyncEngine", () => {
  let dir: string;
  let mapping: MappingConfig;
  let config: PencilSyncConfig;
  let engine: InstanceType<typeof SyncEngine>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
    await mkdir(join(dir, "code"));
    await writeFile(join(dir, "code", "app.tsx"), "content");
    await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));

    mapping = {
      id: "test",
      penFile: join(dir, "design.pen"),
      codeDir: join(dir, "code"),
      codeGlobs: ["**/*.tsx"],
      direction: "both",
    };

    config = {
      version: 1,
      mappings: [mapping],
      settings: {
        debounceMs: 2000,
        model: "claude-sonnet-4-6",
        maxBudgetUsd: 0.5,
        conflictStrategy: "prompt",
        stateFile: join(dir, ".state.json"),
        logLevel: "error",
      },
    };

    engine = new SyncEngine(config);
    await engine.initialize();
  });

  afterEach(async () => {
    engine.shutdown();
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe("syncMapping", () => {
    it("syncs pen-to-code on pen-changed trigger", async () => {
      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });

    it("syncs code-to-pen on code-changed trigger", async () => {
      // Change code file so conflict detector sees a code change
      await writeFile(join(dir, "code", "app.tsx"), "modified");
      const result = await engine.syncMapping(mapping, "code-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("code-to-pen");
    });

    it("rejects when lock is held", async () => {
      engine.getLockManager().acquire("test");
      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("locked");
      engine.getLockManager().forceRelease("test");
    });

    it("ignores pen-changed for code-to-pen mapping", async () => {
      const codeOnly = { ...mapping, direction: "code-to-pen" as const };
      const result = await engine.syncMapping(codeOnly, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual([]);
      expect(mockedRunClaude).not.toHaveBeenCalled();
    });

    it("ignores code-changed for pen-to-code mapping", async () => {
      const penOnly = { ...mapping, direction: "pen-to-code" as const };
      const result = await engine.syncMapping(penOnly, "code-changed");
      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual([]);
      expect(mockedRunClaude).not.toHaveBeenCalled();
    });

    it("respects manual direction override", async () => {
      const result = await engine.syncMapping(mapping, "manual", "pen-to-code");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });
  });

  describe("budget enforcement", () => {
    it("tracks cumulative spend", async () => {
      expect(engine.getCumulativeSpendUsd()).toBe(0);

      await engine.syncMapping(mapping, "pen-changed");
      // 1000 input * $3/MTok + 200 output * $15/MTok = $0.003 + $0.003 = $0.006
      expect(engine.getCumulativeSpendUsd()).toBeGreaterThan(0);
    });

    it("blocks sync when budget exhausted", async () => {
      config.settings.maxBudgetUsd = 0.0001;
      const lowBudgetEngine = new SyncEngine(config);
      await lowBudgetEngine.initialize();

      mockedRunClaude.mockResolvedValueOnce({
        success: true,
        stdout: "Done",
        stderr: "",
        exitCode: 0,
        tokenUsage: { input: 100_000, output: 50_000 },
      });
      await lowBudgetEngine.syncMapping(mapping, "pen-changed");

      // Force-release lock so second sync isn't blocked by grace period
      lowBudgetEngine.getLockManager().forceRelease(mapping.id);

      // Second sync should be blocked by budget, not lock
      const result = await lowBudgetEngine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Budget");

      lowBudgetEngine.shutdown();
    });

    it("reports remaining budget", () => {
      expect(engine.getRemainingBudgetUsd()).toBe(0.5);
    });
  });

  describe("lock manager integration", () => {
    it("sets lastSyncDirection after successful sync", async () => {
      await engine.syncMapping(mapping, "pen-changed");

      const lm = engine.getLockManager();
      // After pen-to-code sync, code-changed should be suppressed
      expect(lm.shouldSuppressTrigger("test", "code-changed")).toBe(true);
    });
  });

  // Rebuild engine with a non-interactive conflict strategy to avoid stdin blocking
  async function withStrategy(strategy: "pen-wins" | "code-wins" | "auto-merge") {
    config.settings.conflictStrategy = strategy;
    engine = new SyncEngine(config);
    await engine.initialize();
  }

  describe("conflict resolution", () => {
    // For conflict tests we need both pen AND code to have changed since last state.
    // We initialize state, then change both files before triggering sync.
    async function setupConflict() {
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "changed" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "modified code");
    }

    it("pen-wins strategy syncs pen-to-code on conflict", async () => {
      await withStrategy("pen-wins");
      await setupConflict();

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });

    it("code-wins strategy syncs code-to-pen on conflict", async () => {
      await withStrategy("code-wins");
      await setupConflict();

      const result = await engine.syncMapping(mapping, "code-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("code-to-pen");
    });

    it("auto-merge strategy calls Claude with conflict prompt", async () => {
      await withStrategy("auto-merge");
      await setupConflict();

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("both");
      expect(result.filesChanged.length).toBeGreaterThan(0);
      expect(mockedRunClaude).toHaveBeenCalled();
    });

    it("auto-merge returns error when Claude fails", async () => {
      await withStrategy("auto-merge");

      mockedRunClaude.mockResolvedValueOnce({
        success: true, stdout: "Done", stderr: "", exitCode: 0,
        tokenUsage: { input: 1000, output: 200 },
      });
      mockedRunClaude.mockResolvedValueOnce({
        success: false, stdout: "", stderr: "API overloaded", exitCode: 1,
        tokenUsage: { input: 500, output: 0 },
      });

      await setupConflict();

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Auto-merge failed");
    });

    it("conflict is only triggered for direction=both mappings", async () => {
      const penOnlyMapping = { ...mapping, direction: "pen-to-code" as const };
      config.mappings = [penOnlyMapping];
      await withStrategy("pen-wins");

      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "x" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "new code");

      const result = await engine.syncMapping(penOnlyMapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });
  });

  describe("manual trigger with auto direction", () => {
    it("syncs pen-to-code when only pen changed", async () => {
      await withStrategy("pen-wins");

      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "new" }] }));

      const result = await engine.syncMapping(mapping, "manual");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });

    it("syncs code-to-pen when only code changed", async () => {
      await withStrategy("code-wins");

      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      await writeFile(join(dir, "code", "app.tsx"), "changed code");

      const result = await engine.syncMapping(mapping, "manual");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("code-to-pen");
    });

    it("defaults to pen-to-code when neither changed", async () => {
      await withStrategy("pen-wins");

      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      const result = await engine.syncMapping(mapping, "manual");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });
  });

  describe("pre-flight budget estimate", () => {
    it("blocks sync when estimated input cost exceeds remaining budget", async () => {
      config.settings.maxBudgetUsd = 0.001;
      await withStrategy("pen-wins");

      mockedRunClaude.mockResolvedValueOnce({
        success: true, stdout: "Done", stderr: "", exitCode: 0,
        tokenUsage: { input: 50_000, output: 10_000 },
      });
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Budget");
    });
  });

  describe("non-interactive mode", () => {
    it("skips user prompt and defaults to skip when stdin is not a TTY", async () => {
      // Use "prompt" strategy (default) which triggers askUser
      config.settings.conflictStrategy = "prompt";
      engine = new SyncEngine(config);
      await engine.initialize();

      // Setup conflict
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "changed" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "modified code");

      // Mock stdin.isTTY = false (non-interactive)
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

      try {
        const result = await engine.syncMapping(mapping, "pen-changed");
        // Should succeed (skip) without hanging on readline
        expect(result.success).toBe(true);
        expect(result.filesChanged).toEqual([]);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      }
    });
  });
});
