import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ShutdownManager } from "../shutdown.js";

describe("ShutdownManager", () => {
  let shutdownManager: ShutdownManager;
  let mockCleanupFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    shutdownManager = new ShutdownManager();
    mockCleanupFn = vi.fn(async () => {}) as any;
  });

  afterEach(() => {
    shutdownManager.clearHandlers();
  });

  describe("registerCleanup", () => {
    it("should register a cleanup handler", () => {
      shutdownManager.registerCleanup("test-handler", mockCleanupFn);
      expect(mockCleanupFn).not.toHaveBeenCalled();
    });

    it("should allow multiple cleanup handlers", () => {
      const handler1 = vi.fn(async () => {}) as any;
      const handler2 = vi.fn(async () => {}) as any;

      shutdownManager.registerCleanup("handler1", handler1);
      shutdownManager.registerCleanup("handler2", handler2);

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it("should replace existing handler with same name", () => {
      const handler1 = vi.fn(async () => {}) as any;
      const handler2 = vi.fn(async () => {}) as any;

      shutdownManager.registerCleanup("test", handler1);
      shutdownManager.registerCleanup("test", handler2);

      // Only the second handler should be registered
      expect(shutdownManager["cleanupHandlers"].size).toBe(1);
    });
  });

  describe("unregisterCleanup", () => {
    it("should remove a registered cleanup handler", () => {
      shutdownManager.registerCleanup("test-handler", mockCleanupFn);
      shutdownManager.unregisterCleanup("test-handler");

      expect(shutdownManager["cleanupHandlers"].size).toBe(0);
    });

    it("should not throw if handler does not exist", () => {
      expect(() => shutdownManager.unregisterCleanup("non-existent")).not.toThrow();
    });
  });

  describe("shutdown", () => {
    it("should execute all cleanup handlers in order", async () => {
      const execOrder: string[] = [];
      const handler1 = vi.fn(async () => {
        execOrder.push("handler1");
      }) as any;
      const handler2 = vi.fn(async () => {
        execOrder.push("handler2");
      }) as any;

      shutdownManager.registerCleanup("handler1", handler1);
      shutdownManager.registerCleanup("handler2", handler2);

      await shutdownManager.shutdown();

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
      expect(execOrder).toEqual(["handler1", "handler2"]);
    });

    it("should only run shutdown once (idempotent)", async () => {
      shutdownManager.registerCleanup("test", mockCleanupFn);

      await shutdownManager.shutdown();
      await shutdownManager.shutdown();
      await shutdownManager.shutdown();

      expect(mockCleanupFn).toHaveBeenCalledOnce();
    });

    it("should continue executing handlers even if one throws", async () => {
      const handler1 = vi.fn(async () => {
        throw new Error("handler1 failed");
      }) as any;
      const handler2 = vi.fn(async () => {}) as any;
      const handler3 = vi.fn(async () => {}) as any;

      shutdownManager.registerCleanup("handler1", handler1);
      shutdownManager.registerCleanup("handler2", handler2);
      shutdownManager.registerCleanup("handler3", handler3);

      await shutdownManager.shutdown();

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
      expect(handler3).toHaveBeenCalledOnce();
    });

    it("should execute handlers with a timeout", async () => {
      const slowHandler = vi.fn(
        async () => new Promise((resolve) => setTimeout(resolve, 10000)),
      ) as any;

      shutdownManager.registerCleanup("slow", slowHandler);

      const start = Date.now();
      await shutdownManager.shutdown(500); // 500ms timeout
      const elapsed = Date.now() - start;

      expect(slowHandler).toHaveBeenCalledOnce();
      expect(elapsed).toBeLessThan(1000); // Should timeout, not wait 10s
    });
  });

  describe("installSignalHandlers", () => {
    let originalListeners: {
      SIGINT: NodeJS.SignalsListener[];
      SIGTERM: NodeJS.SignalsListener[];
    };

    beforeEach(() => {
      // Save original listeners
      originalListeners = {
        SIGINT: process.listeners("SIGINT") as NodeJS.SignalsListener[],
        SIGTERM: process.listeners("SIGTERM") as NodeJS.SignalsListener[],
      };

      // Remove all existing listeners
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
    });

    afterEach(() => {
      // Restore original listeners
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      originalListeners.SIGINT.forEach((l) => process.on("SIGINT", l));
      originalListeners.SIGTERM.forEach((l) => process.on("SIGTERM", l));
    });

    it("should install SIGINT and SIGTERM handlers", () => {
      shutdownManager.installSignalHandlers();

      expect(process.listenerCount("SIGINT")).toBe(1);
      expect(process.listenerCount("SIGTERM")).toBe(1);
    });

    it("should execute cleanup handlers on SIGINT", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      shutdownManager.registerCleanup("test", mockCleanupFn);
      shutdownManager.installSignalHandlers();

      process.emit("SIGINT", "SIGINT");

      // Wait for async cleanup
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(mockCleanupFn).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(0);

      exitSpy.mockRestore();
    });

    it("should execute cleanup handlers on SIGTERM", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      shutdownManager.registerCleanup("test", mockCleanupFn);
      shutdownManager.installSignalHandlers();

      process.emit("SIGTERM", "SIGTERM");

      // Wait for async cleanup
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(mockCleanupFn).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(0);

      exitSpy.mockRestore();
    });

    it("should exit with code 1 if cleanup fails", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
      const failingHandler = vi.fn(async () => {
        throw new Error("cleanup failed");
      }) as any;

      shutdownManager.registerCleanup("failing", failingHandler);
      shutdownManager.installSignalHandlers();

      process.emit("SIGINT", "SIGINT");

      // Wait for async cleanup
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(failingHandler).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });
  });

  describe("installUnhandledRejectionHandler", () => {
    let originalListeners: NodeJS.UnhandledRejectionListener[];

    beforeEach(() => {
      originalListeners = process.listeners("unhandledRejection") as NodeJS.UnhandledRejectionListener[];
      process.removeAllListeners("unhandledRejection");
    });

    afterEach(() => {
      process.removeAllListeners("unhandledRejection");
      originalListeners.forEach((l) => process.on("unhandledRejection", l));
    });

    it("should install unhandledRejection handler", () => {
      shutdownManager.installUnhandledRejectionHandler();
      expect(process.listenerCount("unhandledRejection")).toBe(1);
    });

    it("should execute cleanup and exit on unhandledRejection", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      shutdownManager.registerCleanup("test", mockCleanupFn);
      shutdownManager.installUnhandledRejectionHandler();

      const testError = new Error("unhandled rejection");
      process.emit("unhandledRejection", testError, Promise.reject(testError));

      // Wait for async cleanup
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(mockCleanupFn).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });

    it("should handle unhandledRejection with non-Error values", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      shutdownManager.registerCleanup("test", mockCleanupFn);
      shutdownManager.installUnhandledRejectionHandler();

      process.emit("unhandledRejection", "string error", Promise.reject("string error"));

      // Wait for async cleanup
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(mockCleanupFn).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });
  });

  describe("installUncaughtExceptionHandler", () => {
    let originalListeners: NodeJS.UncaughtExceptionListener[];

    beforeEach(() => {
      originalListeners = process.listeners("uncaughtException") as NodeJS.UncaughtExceptionListener[];
      process.removeAllListeners("uncaughtException");
    });

    afterEach(() => {
      process.removeAllListeners("uncaughtException");
      originalListeners.forEach((l) => process.on("uncaughtException", l));
    });

    it("should install uncaughtException handler", () => {
      shutdownManager.installUncaughtExceptionHandler();
      expect(process.listenerCount("uncaughtException")).toBe(1);
    });

    it("should execute cleanup and exit on uncaughtException", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

      shutdownManager.registerCleanup("test", mockCleanupFn);
      shutdownManager.installUncaughtExceptionHandler();

      const testError = new Error("uncaught exception");
      process.emit("uncaughtException", testError);

      // Wait for async cleanup
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(mockCleanupFn).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });
  });
});
