import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PencilSyncConfig, MappingConfig } from "../types.js";

const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock("chokidar", () => ({
  watch: vi.fn().mockReturnValue(mockWatcher),
}));

let mockSyncMapping = vi.fn().mockResolvedValue({
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

describe("Watcher Resilience", () => {
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
    mockShouldSuppress.mockReturnValue(false);

    mockSyncMapping = vi.fn().mockResolvedValue({
      success: true,
      direction: "pen-to-code",
      mappingId: "test",
      filesChanged: ["app.tsx"],
    });

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
    await watcher.stop();
    vi.useRealTimers();
  });

  describe("chokidar error handling", () => {
    it("logs and continues watching on chokidar error events", async () => {
      await watcher.start();

      const errorCallbacks: Array<(err: Error) => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "error") errorCallbacks.push(call[1] as (err: Error) => void);
      }

      expect(errorCallbacks.length).toBeGreaterThanOrEqual(1);

      const errorHandler = errorCallbacks[0];
      const error = new Error("EACCES: permission denied");

      // Should not throw
      expect(() => errorHandler(error)).not.toThrow();

      // Watcher should still be functional after error
      const changeCallbacks: Array<() => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "change") changeCallbacks.push(call[1] as () => void);
      }

      changeCallbacks[0]();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);

      expect(mockSyncMapping).toHaveBeenCalledTimes(1);
    });

    it("logs critical errors when watching non-existent paths", async () => {
      await watcher.start();

      const errorCallbacks: Array<(err: Error) => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "error") errorCallbacks.push(call[1] as (err: Error) => void);
      }

      const errorHandler = errorCallbacks[0];
      const error = new Error("ENOENT: no such file or directory");

      expect(() => errorHandler(error)).not.toThrow();
    });
  });

  describe("change queueing during in-flight sync", () => {
    it("queues changes that arrive during an in-flight sync", async () => {
      // Make first sync slow
      let firstSyncResolve: () => void;
      const firstSyncPromise = new Promise<void>((resolve) => {
        firstSyncResolve = resolve;
      });

      mockSyncMapping.mockImplementation(async () => {
        await firstSyncPromise;
        return {
          success: true,
          direction: "pen-to-code",
          mappingId: "test",
          filesChanged: ["app.tsx"],
        };
      });

      await watcher.start();

      const changeCallbacks: Array<() => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "change") changeCallbacks.push(call[1] as () => void);
      }

      const penChangeHandler = changeCallbacks[0];

      // Trigger first change
      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);

      // First sync should be in-flight now
      expect(mockSyncMapping).toHaveBeenCalledTimes(1);

      // Trigger second change while first sync is in-flight
      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);

      // Second sync should not start yet (first still in-flight)
      expect(mockSyncMapping).toHaveBeenCalledTimes(1);

      // Complete first sync
      firstSyncResolve!();
      await vi.runAllTimersAsync();

      // Now second sync should execute (queued change)
      expect(mockSyncMapping).toHaveBeenCalledTimes(2);
    });

    it("coalesces multiple queued changes into one sync", async () => {
      let firstSyncResolve: () => void;
      const firstSyncPromise = new Promise<void>((resolve) => {
        firstSyncResolve = resolve;
      });

      mockSyncMapping.mockImplementation(async () => {
        await firstSyncPromise;
        return {
          success: true,
          direction: "pen-to-code",
          mappingId: "test",
          filesChanged: ["app.tsx"],
        };
      });

      await watcher.start();

      const changeCallbacks: Array<() => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "change") changeCallbacks.push(call[1] as () => void);
      }

      const penChangeHandler = changeCallbacks[0];

      // Trigger first change
      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);
      expect(mockSyncMapping).toHaveBeenCalledTimes(1);

      // Trigger multiple changes while first sync is in-flight
      penChangeHandler();
      penChangeHandler();
      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);

      // Still only first sync
      expect(mockSyncMapping).toHaveBeenCalledTimes(1);

      // Complete first sync
      firstSyncResolve!();
      await vi.runAllTimersAsync();

      // Should have exactly 2 syncs total (1 initial + 1 coalesced)
      expect(mockSyncMapping).toHaveBeenCalledTimes(2);
    });
  });

  describe("sync failure recovery", () => {
    it("continues watching after sync failure", async () => {
      mockSyncMapping.mockResolvedValueOnce({
        success: false,
        direction: "pen-to-code",
        mappingId: "test",
        filesChanged: [],
        error: "Claude CLI crashed",
      });

      await watcher.start();

      const changeCallbacks: Array<() => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "change") changeCallbacks.push(call[1] as () => void);
      }

      const penChangeHandler = changeCallbacks[0];

      // Trigger first change (will fail)
      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);
      expect(mockSyncMapping).toHaveBeenCalledTimes(1);

      // Reset mock to succeed
      mockSyncMapping.mockResolvedValueOnce({
        success: true,
        direction: "pen-to-code",
        mappingId: "test",
        filesChanged: ["app.tsx"],
      });

      // Trigger second change (should succeed)
      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);
      expect(mockSyncMapping).toHaveBeenCalledTimes(2);
    });

    it("continues watching after sync exception", async () => {
      mockSyncMapping.mockRejectedValueOnce(new Error("Unexpected crash"));

      await watcher.start();

      const changeCallbacks: Array<() => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "change") changeCallbacks.push(call[1] as () => void);
      }

      const penChangeHandler = changeCallbacks[0];

      // Trigger first change (will throw)
      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);
      expect(mockSyncMapping).toHaveBeenCalledTimes(1);

      // Reset mock to succeed
      mockSyncMapping.mockResolvedValueOnce({
        success: true,
        direction: "pen-to-code",
        mappingId: "test",
        filesChanged: ["app.tsx"],
      });

      // Trigger second change (should succeed)
      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);
      expect(mockSyncMapping).toHaveBeenCalledTimes(2);
    });

    it("handles rapid sync failures without crashing", async () => {
      mockSyncMapping.mockRejectedValue(new Error("Persistent failure"));

      await watcher.start();

      const changeCallbacks: Array<() => void> = [];
      for (const call of mockWatcher.on.mock.calls) {
        if (call[0] === "change") changeCallbacks.push(call[1] as () => void);
      }

      const penChangeHandler = changeCallbacks[0];

      // Trigger 5 rapid failures
      for (let i = 0; i < 5; i++) {
        penChangeHandler();
        await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);
      }

      expect(mockSyncMapping).toHaveBeenCalledTimes(5);

      // Watcher should still be alive
      mockSyncMapping.mockResolvedValueOnce({
        success: true,
        direction: "pen-to-code",
        mappingId: "test",
        filesChanged: ["app.tsx"],
      });

      penChangeHandler();
      await vi.advanceTimersByTimeAsync(config.settings.debounceMs + 50);
      expect(mockSyncMapping).toHaveBeenCalledTimes(6);
    });
  });
});
