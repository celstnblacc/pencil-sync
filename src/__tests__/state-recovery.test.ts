import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../state-store.js";
import { LockManager } from "../lock-manager.js";

describe("StateStore - corruption detection", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects and recovers from corrupted state file (invalid JSON)", async () => {
    const stateFile = join(dir, "state.json");
    await writeFile(stateFile, "{ invalid json ]");

    const store = new StateStore(stateFile);
    await store.load();

    // Should fall back to empty state
    expect(store.getMappingState("any")).toBeUndefined();
  });

  it("detects and recovers from corrupted state file (truncated JSON)", async () => {
    const stateFile = join(dir, "state.json");
    await writeFile(stateFile, '{"version":1,"mappings":{"test":{"mappingId":"test"');

    const store = new StateStore(stateFile);
    await store.load();

    // Should fall back to empty state
    expect(store.getMappingState("test")).toBeUndefined();
  });

  it("detects state file with wrong version", async () => {
    const stateFile = join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify({ version: 999, mappings: {} }));

    const store = new StateStore(stateFile);
    await store.load();

    // Should accept any version for now (forward compatibility)
    expect(store.getMappingState("any")).toBeUndefined();
  });

  it("detects state file with missing required fields", async () => {
    const stateFile = join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify({ mappings: {} })); // missing version

    const store = new StateStore(stateFile);
    await store.load();

    // Should fall back to empty state
    expect(store.getMappingState("any")).toBeUndefined();
  });

  it("verifies state file integrity with checksum", async () => {
    const stateFile = join(dir, "state.json");
    const codeDir = join(dir, "code");
    await mkdir(codeDir);
    await writeFile(join(codeDir, "app.tsx"), "content");
    const penFile = join(dir, "design.pen");
    await writeFile(penFile, "pen content");

    const store = new StateStore(stateFile);
    await store.load();

    const mapping = {
      id: "test",
      penFile,
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
    };

    await store.updateMappingState(mapping, "pen-to-code");

    // Verify checksum is written
    const raw = await readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed._checksum).toBeDefined();
    expect(typeof parsed._checksum).toBe("string");
  });

  it("detects tampered state file via checksum mismatch", async () => {
    const stateFile = join(dir, "state.json");
    const backupFile = stateFile + ".backup";
    const codeDir = join(dir, "code");
    await mkdir(codeDir);
    await writeFile(join(codeDir, "app.tsx"), "content");
    const penFile = join(dir, "design.pen");
    await writeFile(penFile, "pen content");

    const store = new StateStore(stateFile);
    await store.load();

    const mapping = {
      id: "test",
      penFile,
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
    };

    await store.updateMappingState(mapping, "pen-to-code");

    // Read the original state and save checksum
    const beforeTamperRaw = await readFile(stateFile, "utf-8");
    const beforeTamperParsed = JSON.parse(beforeTamperRaw);
    const savedChecksum = beforeTamperParsed._checksum;

    // Remove backup to ensure we test corruption detection (not backup fallback)
    try {
      await rm(backupFile);
    } catch {
      // Backup might not exist
    }

    // Tamper with state file (modify data but keep old checksum unchanged to cause mismatch)
    beforeTamperParsed.mappings.test.lastSyncDirection = "code-to-pen";
    beforeTamperParsed._checksum = savedChecksum; // old checksum won't match new data
    await writeFile(stateFile, JSON.stringify(beforeTamperParsed, null, 2));

    // Reload — should detect checksum mismatch and fall back to empty state
    const store2 = new StateStore(stateFile);
    await store2.load();
    expect(store2.getMappingState("test")).toBeUndefined();
  });

  it("atomic write survives process crash (tmp file rollback)", async () => {
    const stateFile = join(dir, "state.json");
    const codeDir = join(dir, "code");
    await mkdir(codeDir);
    await writeFile(join(codeDir, "app.tsx"), "original");
    const penFile = join(dir, "design.pen");
    await writeFile(penFile, "pen");

    const store = new StateStore(stateFile);
    await store.load();

    const mapping = {
      id: "test",
      penFile,
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
    };

    await store.updateMappingState(mapping, "pen-to-code");
    const originalState = store.getMappingState("test");

    // Simulate crash: write corrupt tmp file and leave it
    const tmpFile = stateFile + ".tmp";
    await writeFile(tmpFile, "{ corrupt }");

    // New instance should ignore .tmp and load original state
    const store2 = new StateStore(stateFile);
    await store2.load();
    const recovered = store2.getMappingState("test");

    expect(recovered).toEqual(originalState);
  });

  it("cleans up orphaned .tmp file on load", async () => {
    const stateFile = join(dir, "state.json");
    const tmpFile = stateFile + ".tmp";

    // Write valid state + orphaned tmp
    await writeFile(stateFile, JSON.stringify({ version: 1, mappings: {} }));
    await writeFile(tmpFile, "orphaned tmp");

    const store = new StateStore(stateFile);
    await store.load();

    // tmp should be cleaned up
    await expect(readFile(tmpFile, "utf-8")).rejects.toThrow();
  });
});

describe("LockManager - stale lock cleanup on startup", () => {
  it("detects stale lock on isLocked() check", () => {
    const lockMgr = new LockManager(2000);

    // Simulate stale lock by manually setting lock timestamp to ancient past
    lockMgr.acquire("mapping1");
    // @ts-expect-error - accessing private field for test
    lockMgr.lockTimestamps.set("mapping1", Date.now() - 400_000); // 6.6 min ago

    // Should auto-release stale lock
    expect(lockMgr.isLocked("mapping1")).toBe(false);
  });

  it("force-releases stale lock and allows re-acquisition", () => {
    const lockMgr = new LockManager(2000);

    lockMgr.acquire("mapping1");
    // @ts-expect-error - accessing private field for test
    lockMgr.lockTimestamps.set("mapping1", Date.now() - 400_000);

    // First check auto-releases
    expect(lockMgr.isLocked("mapping1")).toBe(false);

    // Should be re-acquirable
    expect(lockMgr.acquire("mapping1")).toBe(true);
  });

  it("cleanup method releases all stale locks", () => {
    const lockMgr = new LockManager(2000);

    lockMgr.acquire("m1");
    lockMgr.acquire("m2");
    lockMgr.acquire("m3");

    // Make m1 and m3 stale, m2 fresh
    // @ts-expect-error - accessing private field for test
    lockMgr.lockTimestamps.set("m1", Date.now() - 400_000);
    // @ts-expect-error - accessing private field for test
    lockMgr.lockTimestamps.set("m3", Date.now() - 400_000);

    lockMgr.cleanupStaleLocks();

    expect(lockMgr.isLocked("m1")).toBe(false); // cleaned
    expect(lockMgr.isLocked("m2")).toBe(true);  // still held
    expect(lockMgr.isLocked("m3")).toBe(false); // cleaned
  });

  it("cleanupStaleLocks() on fresh instance does nothing", () => {
    const lockMgr = new LockManager(2000);
    lockMgr.cleanupStaleLocks(); // should not throw
  });
});

describe("StateStore - backup and recovery", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates backup before overwriting state", async () => {
    const stateFile = join(dir, "state.json");
    const backupFile = stateFile + ".backup";
    const codeDir = join(dir, "code");
    await mkdir(codeDir);
    await writeFile(join(codeDir, "app.tsx"), "v1");
    const penFile = join(dir, "design.pen");
    await writeFile(penFile, "pen");

    const store = new StateStore(stateFile);
    await store.load();

    const mapping = {
      id: "test",
      penFile,
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
    };

    await store.updateMappingState(mapping, "pen-to-code");

    // Update again — should create backup
    await writeFile(join(codeDir, "app.tsx"), "v2");
    await store.updateMappingState(mapping, "code-to-pen");

    // Backup should exist and contain first state
    const backup = JSON.parse(await readFile(backupFile, "utf-8"));
    expect(backup.mappings.test.lastSyncDirection).toBe("pen-to-code");
  });

});
