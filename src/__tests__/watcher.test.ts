import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PencilSyncConfig, MappingConfig } from "../types.js";

// Mock chokidar
const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock("chokidar", () => ({
  watch: vi.fn().mockReturnValue(mockWatcher),
}));

// Mock sync-engine
const mockSyncMapping = vi.fn().mockResolvedValue({
  success: true,
  direction: "pen-to-code",
  mappingId: "test",
  filesChanged: ["app.tsx"],
});
const mockShouldSuppress = vi.fn().mockReturnValue(false);
const mockShutdown = vi.fn();

vi.mock("../sync-engine.js", () => ({
  SyncEngine: vi.fn().mockImplementation(() => ({
    syncMapping: mockSyncMapping,
    getLockManager: () => ({
      shouldSuppressTrigger: mockShouldSuppress,
    }),
    shutdown: mockShutdown,
  })),
}));

const { Watcher } = await import("../watcher.js");
const { watch: chokidarWatch } = await import("chokidar");

describe("Watcher", () => {
  let mapping: MappingConfig;
  let config: PencilSyncConfig;
  let watcher: InstanceType<typeof Watcher>;
  let mockEngine: ReturnType<typeof createMockEngine>;

  function createMockEngine() {
    return {
      syncMapping: mockSyncMapping,
      getLockManager: () => ({
        shouldSuppressTrigger: mockShouldSuppress,
      }),
      shutdown: mockShutdown,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockWatcher.on.mockReturnThis();

    mapping = {
      id: "test",
      penFile: "/project/design.pen",
      codeDir: "/project/src",
      codeGlobs: ["**/*.tsx"],
      direction: "both",
    };

    config = {
      version: 1,
      mappings: [mapping],
      settings: {
        debounceMs: 1000,
        model: "claude-sonnet-4-6",
        maxBudgetUsd: 0.5,
        conflictStrategy: "prompt",
        stateFile: "/tmp/.state.json",
        logLevel: "error",
      },
    };

    mockEngine = createMockEngine();
    watcher = new Watcher(config, mockEngine as never);
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  describe("start", () => {
    it("creates watchers for pen file and code dir when direction is both", async () => {
      await watcher.start();
      // Should call chokidar.watch twice: once for pen file, once for code globs
      expect(chokidarWatch).toHaveBeenCalledTimes(2);
    });

    it("only watches pen file for pen-to-code direction", async () => {
      config.mappings = [{ ...mapping, direction: "pen-to-code" }];
      watcher = new Watcher(config, mockEngine as never);
      await watcher.start();
      expect(chokidarWatch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(chokidarWatch).mock.calls[0][0]).toBe(mapping.penFile);
    });

    it("only watches code dir for code-to-pen direction", async () => {
      config.mappings = [{ ...mapping, direction: "code-to-pen" }];
      watcher = new Watcher(config, mockEngine as never);
      await watcher.start();
      expect(chokidarWatch).toHaveBeenCalledTimes(1);
    });

    it("throws if mapping filter matches nothing", async () => {
      await expect(watcher.start("nonexistent")).rejects.toThrow('Mapping "nonexistent" not found');
    });

    it("filters to specific mapping when filter is provided", async () => {
      config.mappings = [
        mapping,
        { ...mapping, id: "other", penFile: "/other/design.pen", codeDir: "/other/src" },
      ];
      watcher = new Watcher(config, mockEngine as never);
      await watcher.start("test");
      // Only the "test" mapping should be watched (2 watchers: pen + code)
      expect(chokidarWatch).toHaveBeenCalledTimes(2);
    });
  });

  describe("debounced sync", () => {
    it("debounces multiple rapid pen changes into one sync", async () => {
      await watcher.start();

      // Find the pen watcher "change" callback
      const changeCallbacks: Array<() => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "change") {
          changeCallbacks.push(call[1] as () => void);
        }
      }
      expect(changeCallbacks.length).toBeGreaterThan(0);

      const penChangeHandler = changeCallbacks[0];

      // Fire 3 rapid changes
      penChangeHandler();
      penChangeHandler();
      penChangeHandler();

      // Should not have synced yet (debounce hasn't fired)
      expect(mockSyncMapping).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);

      // Should have synced exactly once
      expect(mockSyncMapping).toHaveBeenCalledTimes(1);
      expect(mockSyncMapping).toHaveBeenCalledWith(mapping, "pen-changed");
    });

    it("suppresses echo triggers via shouldSuppressTrigger", async () => {
      mockShouldSuppress.mockReturnValue(true);

      await watcher.start();

      // Find the pen change handler
      const changeCallbacks: Array<() => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "change") changeCallbacks.push(call[1] as () => void);
      }
      const penChangeHandler = changeCallbacks[0];

      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);

      // syncMapping should NOT be called because trigger was suppressed
      expect(mockSyncMapping).not.toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("closes all watchers and clears timers", async () => {
      await watcher.start();
      await watcher.stop();

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(mockShutdown).toHaveBeenCalled();
    });
  });
});
