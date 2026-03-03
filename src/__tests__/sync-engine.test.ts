import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PencilSyncConfig, MappingConfig } from "../types.js";

// Mock claude-runner
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

// Mock prompt-builder (include snapshot/diff exports used by pen-to-code)
// Return a non-fill diff so Claude CLI gets called for pen-to-code syncs
vi.mock("../prompt-builder.js", () => ({
  buildPenToCodePrompt: vi.fn().mockResolvedValue("pen-to-code prompt"),
  buildCodeToPenPrompt: vi.fn().mockResolvedValue("code-to-pen prompt"),
  buildConflictPrompt: vi.fn().mockResolvedValue("conflict prompt"),
  snapshotPenFile: vi.fn().mockReturnValue({}),
  diffPenSnapshots: vi.fn().mockReturnValue([
    { nodeId: "t1", nodeName: "title", prop: "content", oldValue: "old", newValue: "new" },
  ]),
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
      // Set a very low budget
      config.settings.maxBudgetUsd = 0.0001;
      const lowBudgetEngine = new SyncEngine(config);
      await lowBudgetEngine.initialize();

      // First sync uses some budget
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

  describe("conflict resolution", () => {
    // For conflict tests we need both pen AND code to have changed since last state.
    // We initialize state, then change both files before triggering sync.
    async function setupConflict() {
      // First sync to establish baseline state
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      // Now change both .pen and code files so conflict detector sees a conflict
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "changed" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "modified code");
    }

    it("pen-wins strategy syncs pen-to-code on conflict", async () => {
      config.settings.conflictStrategy = "pen-wins";
      engine = new SyncEngine(config);
      await engine.initialize();

      await setupConflict();

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });

    it("code-wins strategy syncs code-to-pen on conflict", async () => {
      config.settings.conflictStrategy = "code-wins";
      engine = new SyncEngine(config);
      await engine.initialize();

      await setupConflict();

      const result = await engine.syncMapping(mapping, "code-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("code-to-pen");
    });

    it("auto-merge strategy calls Claude with conflict prompt", async () => {
      config.settings.conflictStrategy = "auto-merge";
      engine = new SyncEngine(config);
      await engine.initialize();

      await setupConflict();

      const result = await engine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("both");
      expect(result.filesChanged.length).toBeGreaterThan(0);
      // auto-merge uses runClaude directly (via buildConflictPrompt)
      expect(mockedRunClaude).toHaveBeenCalled();
    });

    it("auto-merge returns error when Claude fails", async () => {
      config.settings.conflictStrategy = "auto-merge";
      engine = new SyncEngine(config);
      await engine.initialize();

      mockedRunClaude.mockResolvedValueOnce({
        success: true, stdout: "Done", stderr: "", exitCode: 0,
        tokenUsage: { input: 1000, output: 200 },
      }); // for initial pen-to-code sync
      // For the auto-merge call, Claude fails
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
      // pen-to-code mapping ignores conflicts (just does pen-to-code)
      const penOnlyMapping = { ...mapping, direction: "pen-to-code" as const };
      config.settings.conflictStrategy = "pen-wins";
      config.mappings = [penOnlyMapping];
      engine = new SyncEngine(config);
      await engine.initialize();

      // Change both files
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "x" }] }));
      await writeFile(join(dir, "code", "app.tsx"), "new code");

      const result = await engine.syncMapping(penOnlyMapping, "pen-changed");
      // Should succeed without conflict handling because direction is not "both"
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });
  });

  describe("manual trigger with auto direction", () => {
    it("syncs pen-to-code when only pen changed", async () => {
      // Use non-interactive strategy to avoid stdin blocking if conflict is detected
      config.settings.conflictStrategy = "pen-wins";
      engine = new SyncEngine(config);
      await engine.initialize();

      // Establish baseline
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      // Only change .pen file
      await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [{ id: "new" }] }));

      const result = await engine.syncMapping(mapping, "manual");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });

    it("syncs code-to-pen when only code changed", async () => {
      config.settings.conflictStrategy = "code-wins";
      engine = new SyncEngine(config);
      await engine.initialize();

      // Establish baseline
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      // Only change code file
      await writeFile(join(dir, "code", "app.tsx"), "changed code");

      const result = await engine.syncMapping(mapping, "manual");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("code-to-pen");
    });

    it("defaults to pen-to-code when neither changed", async () => {
      config.settings.conflictStrategy = "pen-wins";
      engine = new SyncEngine(config);
      await engine.initialize();

      // Establish baseline — nothing changes after
      await engine.syncMapping(mapping, "pen-changed");
      engine.getLockManager().forceRelease(mapping.id);

      const result = await engine.syncMapping(mapping, "manual");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("pen-to-code");
    });
  });

  describe("pre-flight budget estimate", () => {
    it("blocks sync when estimated input cost exceeds remaining budget", async () => {
      // Set a tiny budget and exhaust most of it
      config.settings.maxBudgetUsd = 0.001;
      config.settings.conflictStrategy = "pen-wins";
      const tinyEngine = new SyncEngine(config);
      await tinyEngine.initialize();

      // First sync to use some budget
      mockedRunClaude.mockResolvedValueOnce({
        success: true, stdout: "Done", stderr: "", exitCode: 0,
        tokenUsage: { input: 50_000, output: 10_000 },
      });
      await tinyEngine.syncMapping(mapping, "pen-changed");
      tinyEngine.getLockManager().forceRelease(mapping.id);

      // Budget should now be exhausted
      const result = await tinyEngine.syncMapping(mapping, "pen-changed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Budget");

      tinyEngine.shutdown();
    });
  });
});
