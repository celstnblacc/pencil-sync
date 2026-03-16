import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LockManager, STALE_LOCK_MS } from "../lock-manager.js";

/**
 * TDD: Lock state machine robustness
 * - Anti-spin: prevent rapid-fire acquire attempts
 * - Echo suppression fix: ensure reverse-direction triggers are correctly suppressed
 * - Long-sync safety: locks held beyond normal debounce but within stale threshold
 */
describe("LockManager — State Machine Robustness", () => {
  let lm: LockManager;

  beforeEach(() => {
    vi.useFakeTimers();
    lm = new LockManager(2000);
  });

  afterEach(() => {
    lm.releaseAll();
    vi.useRealTimers();
  });

  describe("anti-spin: prevent rapid acquire retries", () => {
    it("rejects rapid acquire attempts on locked mapping", () => {
      expect(lm.acquire("m1")).toBe(true);

      // Simulate rapid retry loop
      for (let i = 0; i < 100; i++) {
        expect(lm.acquire("m1")).toBe(false);
        vi.advanceTimersByTime(10); // 10ms between retries
      }

      expect(lm.isLocked("m1")).toBe(true);
    });

    it("allows acquire after grace period expires", () => {
      lm.acquire("m1");
      lm.release("m1");

      // Rapid retries during grace period
      for (let i = 0; i < 10; i++) {
        expect(lm.acquire("m1")).toBe(false);
        vi.advanceTimersByTime(100);
      }

      // After grace period ends
      vi.advanceTimersByTime(2500);
      expect(lm.acquire("m1")).toBe(true);
    });

    it("does not accumulate state from failed acquire attempts", () => {
      lm.acquire("m1");

      // 50 failed acquire attempts
      for (let i = 0; i < 50; i++) {
        lm.acquire("m1");
      }

      lm.release("m1");
      vi.advanceTimersByTime(2500);

      // Should cleanly acquire after grace period
      expect(lm.acquire("m1")).toBe(true);
      expect(lm.isLocked("m1")).toBe(true);
    });
  });

  describe("echo suppression: reverse-direction trigger filtering", () => {
    it("suppresses code-changed immediately after pen-to-code sync", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");
      vi.advanceTimersByTime(50);
      expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(true);
    });

    it("suppresses pen-changed immediately after code-to-pen sync", () => {
      lm.setLastSyncDirection("m1", "code-to-pen");
      vi.advanceTimersByTime(50);
      expect(lm.shouldSuppressTrigger("m1", "pen-changed")).toBe(true);
    });

    it("suppresses trigger within entire grace period window", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");

      // Test at multiple points within grace period (2500ms)
      for (let elapsed = 100; elapsed <= 2400; elapsed += 500) {
        vi.advanceTimersByTime(500);
        expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(true);
      }
    });

    it("stops suppressing trigger after grace period expires", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");
      vi.advanceTimersByTime(2501);
      expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(false);
    });

    it("does NOT suppress same-direction triggers", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");
      expect(lm.shouldSuppressTrigger("m1", "pen-changed")).toBe(false);

      lm.setLastSyncDirection("m2", "code-to-pen");
      expect(lm.shouldSuppressTrigger("m2", "code-changed")).toBe(false);
    });

    it("handles rapid direction switches correctly", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");
      expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(true);

      vi.advanceTimersByTime(500);
      lm.setLastSyncDirection("m1", "code-to-pen");

      // Now should suppress pen-changed, not code-changed
      expect(lm.shouldSuppressTrigger("m1", "pen-changed")).toBe(true);
      expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(false);
    });

    it("tracks echo suppression independently per mapping", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");
      lm.setLastSyncDirection("m2", "code-to-pen");

      expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(true);
      expect(lm.shouldSuppressTrigger("m1", "pen-changed")).toBe(false);

      expect(lm.shouldSuppressTrigger("m2", "pen-changed")).toBe(true);
      expect(lm.shouldSuppressTrigger("m2", "code-changed")).toBe(false);
    });
  });

  describe("long-sync safety: locks held beyond debounce but within stale threshold", () => {
    it("keeps lock active during long sync (5 minutes)", () => {
      lm.acquire("m1");

      // Simulate 5-minute sync (below 6-minute stale threshold)
      vi.advanceTimersByTime(5 * 60 * 1000);

      expect(lm.isLocked("m1")).toBe(true);
      expect(lm.acquire("m1")).toBe(false);
    });

    it("auto-releases stale lock after 6 minutes", () => {
      lm.acquire("m1");

      vi.advanceTimersByTime(STALE_LOCK_MS + 1);

      expect(lm.isLocked("m1")).toBe(false);
      expect(lm.acquire("m1")).toBe(true);
    });

    it("allows long sync without triggering anti-spin", () => {
      lm.acquire("m1");

      // Simulate periodic acquire checks during 4-minute sync
      for (let minute = 0; minute < 4; minute++) {
        vi.advanceTimersByTime(60 * 1000);
        expect(lm.acquire("m1")).toBe(false); // Still locked
      }

      lm.release("m1");
      vi.advanceTimersByTime(2500);

      expect(lm.acquire("m1")).toBe(true);
    });

    it("grace period still applies after long sync", () => {
      lm.acquire("m1");

      // Hold for 3 minutes
      vi.advanceTimersByTime(3 * 60 * 1000);

      lm.release("m1");

      // Grace period still enforced
      vi.advanceTimersByTime(2000);
      expect(lm.isLocked("m1")).toBe(true);

      vi.advanceTimersByTime(500);
      expect(lm.isLocked("m1")).toBe(false);
    });

    it("stale lock detection does not interfere with grace period", () => {
      lm.acquire("m1");
      lm.release("m1");

      // Within grace period, but far from stale threshold
      vi.advanceTimersByTime(1000);
      expect(lm.isLocked("m1")).toBe(true);

      // Grace period expires
      vi.advanceTimersByTime(1500);
      expect(lm.isLocked("m1")).toBe(false);
    });
  });

  describe("edge cases: state machine transitions", () => {
    it("forceRelease during grace period clears all state", () => {
      lm.acquire("m1");
      lm.release("m1");

      expect(lm.isLocked("m1")).toBe(true);

      lm.forceRelease("m1");

      expect(lm.isLocked("m1")).toBe(false);
      expect(lm.acquire("m1")).toBe(true);
    });

    it("multiple release calls on same mapping are safe", () => {
      lm.acquire("m1");

      lm.release("m1");
      lm.release("m1");
      lm.release("m1");

      vi.advanceTimersByTime(2500);

      expect(lm.isLocked("m1")).toBe(false);
    });

    it("release without acquire is a no-op", () => {
      lm.release("m1");

      expect(lm.isLocked("m1")).toBe(false);
      expect(lm.acquire("m1")).toBe(true);
    });

    it("acquire after release but before grace expires returns false", () => {
      lm.acquire("m1");
      lm.release("m1");

      vi.advanceTimersByTime(1000);

      expect(lm.acquire("m1")).toBe(false);
      expect(lm.isLocked("m1")).toBe(true);
    });

    it("stale lock clears timestamp and grace timer", () => {
      lm.acquire("m1");

      vi.advanceTimersByTime(STALE_LOCK_MS + 1);

      // isLocked() should auto-clear
      expect(lm.isLocked("m1")).toBe(false);

      // New acquire should succeed
      expect(lm.acquire("m1")).toBe(true);
      expect(lm.isLocked("m1")).toBe(true);
    });

    it("releaseAll clears all locks and timers", () => {
      lm.acquire("m1");
      lm.acquire("m2");
      lm.release("m3"); // grace timer, no lock

      lm.releaseAll();

      expect(lm.isLocked("m1")).toBe(false);
      expect(lm.isLocked("m2")).toBe(false);
      expect(lm.isLocked("m3")).toBe(false);

      // All should be acquirable
      expect(lm.acquire("m1")).toBe(true);
      expect(lm.acquire("m2")).toBe(true);
      expect(lm.acquire("m3")).toBe(true);
    });
  });

  describe("concurrent mappings: isolation", () => {
    it("locks for different mappings are independent", () => {
      lm.acquire("m1");
      expect(lm.acquire("m2")).toBe(true);

      lm.release("m1");

      expect(lm.isLocked("m1")).toBe(true); // grace period
      expect(lm.isLocked("m2")).toBe(true); // still held

      vi.advanceTimersByTime(2500);

      expect(lm.isLocked("m1")).toBe(false);
      expect(lm.isLocked("m2")).toBe(true);
    });

    it("echo suppression for different mappings is independent", () => {
      lm.setLastSyncDirection("m1", "pen-to-code");
      lm.setLastSyncDirection("m2", "code-to-pen");

      expect(lm.shouldSuppressTrigger("m1", "code-changed")).toBe(true);
      expect(lm.shouldSuppressTrigger("m2", "code-changed")).toBe(false);

      expect(lm.shouldSuppressTrigger("m1", "pen-changed")).toBe(false);
      expect(lm.shouldSuppressTrigger("m2", "pen-changed")).toBe(true);
    });

    it("stale lock detection for one mapping does not affect others", () => {
      lm.acquire("m1");

      // Acquire m2 later
      vi.advanceTimersByTime(60 * 1000);
      lm.acquire("m2");

      // Advance time so m1 goes stale but m2 doesn't
      vi.advanceTimersByTime(STALE_LOCK_MS - 60 * 1000 + 1);

      // m1 goes stale
      expect(lm.isLocked("m1")).toBe(false);

      // m2 still locked (hasn't reached stale threshold)
      expect(lm.isLocked("m2")).toBe(true);
    });
  });

  describe("grace period configuration", () => {
    it("adapts grace period to debounce setting", () => {
      const lm500 = new LockManager(500);
      expect(lm500.getGracePeriodMs()).toBe(1000); // 500 + 500 buffer

      const lm5000 = new LockManager(5000);
      expect(lm5000.getGracePeriodMs()).toBe(5500); // 5000 + 500 buffer
    });

    it("grace period scales with debounce for echo suppression", () => {
      const lm500 = new LockManager(500);
      lm500.setLastSyncDirection("m1", "pen-to-code");

      vi.advanceTimersByTime(999);
      expect(lm500.shouldSuppressTrigger("m1", "code-changed")).toBe(true);

      vi.advanceTimersByTime(2);
      expect(lm500.shouldSuppressTrigger("m1", "code-changed")).toBe(false);
    });

    it("grace period scales with debounce for lock release", () => {
      const lm1000 = new LockManager(1000);
      lm1000.acquire("m1");
      lm1000.release("m1");

      vi.advanceTimersByTime(1499);
      expect(lm1000.isLocked("m1")).toBe(true);

      vi.advanceTimersByTime(2);
      expect(lm1000.isLocked("m1")).toBe(false);
    });
  });
});
