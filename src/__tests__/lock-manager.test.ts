import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LockManager } from "../lock-manager.js";

describe("LockManager", () => {
  let lm: LockManager;

  beforeEach(() => {
    vi.useFakeTimers();
    lm = new LockManager(2000);
  });

  afterEach(() => {
    lm.releaseAll();
    vi.useRealTimers();
  });

  describe("acquire/release", () => {
    it("acquires a free lock", () => {
      expect(lm.acquire("m1")).toBe(true);
      expect(lm.isLocked("m1")).toBe(true);
    });

    it("rejects a second acquire on the same mapping", () => {
      lm.acquire("m1");
      expect(lm.acquire("m1")).toBe(false);
    });

    it("allows acquiring different mappings", () => {
      expect(lm.acquire("m1")).toBe(true);
      expect(lm.acquire("m2")).toBe(true);
    });

    it("releases lock after grace period", () => {
      lm.acquire("m1");
      lm.release("m1");

      // Still locked during grace period
      expect(lm.isLocked("m1")).toBe(true);

      // Grace period = debounceMs(2000) + buffer(500) = 2500ms
      vi.advanceTimersByTime(2500);
      expect(lm.isLocked("m1")).toBe(false);
    });

    it("does not release before grace period ends", () => {
      lm.acquire("m1");
      lm.release("m1");

      vi.advanceTimersByTime(2000);
      expect(lm.isLocked("m1")).toBe(true);

      vi.advanceTimersByTime(500);
      expect(lm.isLocked("m1")).toBe(false);
    });
  });

  describe("forceRelease", () => {
    it("releases immediately", () => {
      lm.acquire("m1");
      lm.forceRelease("m1");
      expect(lm.isLocked("m1")).toBe(false);
    });

    it("cancels pending grace timer", () => {
      lm.acquire("m1");
      lm.release("m1");
      lm.forceRelease("m1");
      expect(lm.isLocked("m1")).toBe(false);
    });
  });

  describe("releaseAll", () => {
    it("releases all locks", () => {
      lm.acquire("m1");
      lm.acquire("m2");
      lm.releaseAll();
      expect(lm.isLocked("m1")).toBe(false);
      expect(lm.isLocked("m2")).toBe(false);
    });
  });

  describe("grace period is dynamic", () => {
    it("uses debounceMs + 500 buffer", () => {
      const lm3000 = new LockManager(3000);
      expect(lm3000.getGracePeriodMs()).toBe(3500);

      const lm1000 = new LockManager(1000);
      expect(lm1000.getGracePeriodMs()).toBe(1500);
    });
  });

  describe("stale lock detection", () => {
    it("auto-releases lock held longer than 6 minutes", () => {
      lm.acquire("m1");
      expect(lm.isLocked("m1")).toBe(true);

      // Advance past STALE_LOCK_MS (360_000ms = 6 min)
      vi.advanceTimersByTime(360_001);

      // isLocked should detect staleness and force-release
      expect(lm.isLocked("m1")).toBe(false);
      // Should now be acquirable again
      expect(lm.acquire("m1")).toBe(true);
    });

    it("does NOT auto-release lock within 6 minutes", () => {
      lm.acquire("m1");
      vi.advanceTimersByTime(359_999);
      expect(lm.isLocked("m1")).toBe(true);
    });

    it("stale lock allows new acquire", () => {
      lm.acquire("m1");
      vi.advanceTimersByTime(360_001);

      // acquire calls isLocked, which detects staleness
      expect(lm.acquire("m1")).toBe(true);
    });
  });

  describe("shouldSuppressTrigger", () => {
    it("suppresses code-changed after pen-to-code sync", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");
      expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(true);
    });

    it("suppresses pen-changed after code-to-pen sync", () => {
      lm.setLastSyncDirection("m1", "code-to-pen");
      expect(lm.shouldSuppressTrigger("m1", "pen-changed")).toBe(true);
    });

    it("does NOT suppress same-direction trigger", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");
      expect(lm.shouldSuppressTrigger("m1", "pen-changed")).toBe(false);
    });

    it("does NOT suppress after grace period expires", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");
      vi.advanceTimersByTime(3000); // past grace period
      expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(false);
    });

    it("does NOT suppress when no previous sync", () => {
      expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(false);
    });
  });
});
