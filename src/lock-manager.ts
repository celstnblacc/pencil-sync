import { log } from "./logger.js";
import type { SyncDirection } from "./types.js";

const GRACE_BUFFER_MS = 500;
const STALE_LOCK_MS = 360_000; // 6 minutes — force release if held longer than this

export class LockManager {
  private locks = new Map<string, boolean>();
  private lockTimestamps = new Map<string, number>();
  private graceTimers = new Map<string, NodeJS.Timeout>();
  private lastSyncDirections = new Map<string, { direction: SyncDirection; timestamp: number }>();
  private gracePeriodMs: number;

  constructor(debounceMs: number = 2000) {
    // Grace period must exceed debounce to prevent ping-pong loops
    this.gracePeriodMs = debounceMs + GRACE_BUFFER_MS;
  }

  isLocked(mappingId: string): boolean {
    if (this.locks.get(mappingId) !== true) return false;

    // Check for stale lock — force release if held too long
    const acquiredAt = this.lockTimestamps.get(mappingId);
    if (acquiredAt && Date.now() - acquiredAt > STALE_LOCK_MS) {
      log.warn(`Stale lock detected for ${mappingId} (held for ${Math.round((Date.now() - acquiredAt) / 1000)}s), force releasing`);
      this.forceRelease(mappingId);
      return false;
    }

    return true;
  }

  acquire(mappingId: string): boolean {
    if (this.isLocked(mappingId)) {
      log.debug(`Lock already held for ${mappingId}, skipping`);
      return false;
    }

    this.locks.set(mappingId, true);
    this.lockTimestamps.set(mappingId, Date.now());
    log.debug(`Lock acquired for ${mappingId}`);
    return true;
  }

  release(mappingId: string): void {
    // Keep the lock during grace period to prevent loop triggers
    log.debug(`Starting ${this.gracePeriodMs}ms grace period for ${mappingId}`);

    const existing = this.graceTimers.get(mappingId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.locks.delete(mappingId);
      this.lockTimestamps.delete(mappingId);
      this.graceTimers.delete(mappingId);
      log.debug(`Lock released for ${mappingId}`);
    }, this.gracePeriodMs);

    this.graceTimers.set(mappingId, timer);
  }

  forceRelease(mappingId: string): void {
    const timer = this.graceTimers.get(mappingId);
    if (timer) clearTimeout(timer);
    this.locks.delete(mappingId);
    this.lockTimestamps.delete(mappingId);
    this.graceTimers.delete(mappingId);
    log.debug(`Lock force-released for ${mappingId}`);
  }

  releaseAll(): void {
    for (const [id] of this.locks) {
      this.forceRelease(id);
    }
  }

  setLastSyncDirection(mappingId: string, direction: SyncDirection): void {
    this.lastSyncDirections.set(mappingId, {
      direction,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if a triggered sync should be suppressed because it's the
   * reverse-direction echo of a recent sync. Returns true if the trigger
   * should be skipped.
   */
  shouldSuppressTrigger(
    mappingId: string,
    trigger: "pen-changed" | "code-changed",
  ): boolean {
    const last = this.lastSyncDirections.get(mappingId);
    if (!last) return false;

    const elapsed = Date.now() - last.timestamp;
    // Only suppress within the grace window
    if (elapsed > this.gracePeriodMs) return false;

    // pen-to-code sync writes code files → suppress code-changed trigger
    // code-to-pen sync writes .pen file → suppress pen-changed trigger
    if (last.direction === "pen-to-code" && trigger === "code-changed") {
      log.debug(`Suppressing code-changed trigger for ${mappingId} (echo of recent pen-to-code sync)`);
      return true;
    }
    if (last.direction === "code-to-pen" && trigger === "pen-changed") {
      log.debug(`Suppressing pen-changed trigger for ${mappingId} (echo of recent code-to-pen sync)`);
      return true;
    }

    return false;
  }

  getGracePeriodMs(): number {
    return this.gracePeriodMs;
  }
}
