import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectConflict, isConflict } from "../conflict-detector.js";
import { hashFile, hashCodeDir } from "../state-store.js";
import type { MappingConfig, MappingState } from "../types.js";

describe("conflict-detector", () => {
  let dir: string;
  let mapping: MappingConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
    await mkdir(join(dir, "code"));
    await writeFile(join(dir, "design.pen"), "pen-content");
    await writeFile(join(dir, "code", "app.tsx"), "code-content");

    mapping = {
      id: "test",
      penFile: join(dir, "design.pen"),
      codeDir: join(dir, "code"),
      codeGlobs: ["**/*.tsx"],
      direction: "both",
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns no conflict when no previous state", async () => {
    const info = await detectConflict(mapping, undefined);
    expect(info.penChanged).toBe(false);
    expect(info.codeChanged).toBe(false);
    expect(isConflict(info)).toBe(false);
  });

  it("detects pen change only", async () => {
    const state: MappingState = {
      mappingId: "test",
      penHash: "old-hash",
      codeHashes: await hashCodeDir(join(dir, "code"), ["**/*.tsx"]),
      lastSyncTimestamp: Date.now(),
      lastSyncDirection: "pen-to-code",
    };

    // Pen file has changed (different from "old-hash")
    const info = await detectConflict(mapping, state);
    expect(info.penChanged).toBe(true);
    expect(info.codeChanged).toBe(false);
    expect(isConflict(info)).toBe(false);
  });

  it("detects code change only", async () => {
    const state: MappingState = {
      mappingId: "test",
      penHash: await hashFile(join(dir, "design.pen")),
      codeHashes: { "app.tsx": "old-code-hash" },
      lastSyncTimestamp: Date.now(),
      lastSyncDirection: "pen-to-code",
    };

    const info = await detectConflict(mapping, state);
    expect(info.penChanged).toBe(false);
    expect(info.codeChanged).toBe(true);
    expect(info.changedCodeFiles).toContain("app.tsx");
    expect(isConflict(info)).toBe(false);
  });

  it("detects conflict when both changed", async () => {
    const state: MappingState = {
      mappingId: "test",
      penHash: "old-pen-hash",
      codeHashes: { "app.tsx": "old-code-hash" },
      lastSyncTimestamp: Date.now(),
      lastSyncDirection: "pen-to-code",
    };

    const info = await detectConflict(mapping, state);
    expect(info.penChanged).toBe(true);
    expect(info.codeChanged).toBe(true);
    expect(isConflict(info)).toBe(true);
  });

  it("detects deleted code files", async () => {
    const state: MappingState = {
      mappingId: "test",
      penHash: await hashFile(join(dir, "design.pen")),
      codeHashes: {
        "app.tsx": await hashFile(join(dir, "code", "app.tsx")),
        "deleted.tsx": "some-hash",
      },
      lastSyncTimestamp: Date.now(),
      lastSyncDirection: "pen-to-code",
    };

    const info = await detectConflict(mapping, state);
    expect(info.changedCodeFiles).toContain("deleted.tsx");
  });

  it("detects new code files", async () => {
    await writeFile(join(dir, "code", "new.tsx"), "new file");

    const state: MappingState = {
      mappingId: "test",
      penHash: await hashFile(join(dir, "design.pen")),
      codeHashes: { "app.tsx": await hashFile(join(dir, "code", "app.tsx")) },
      lastSyncTimestamp: Date.now(),
      lastSyncDirection: "pen-to-code",
    };

    const info = await detectConflict(mapping, state);
    expect(info.changedCodeFiles).toContain("new.tsx");
  });

  it("reports no changes when nothing changed", async () => {
    const state: MappingState = {
      mappingId: "test",
      penHash: await hashFile(join(dir, "design.pen")),
      codeHashes: await hashCodeDir(join(dir, "code"), ["**/*.tsx"]),
      lastSyncTimestamp: Date.now(),
      lastSyncDirection: "pen-to-code",
    };

    const info = await detectConflict(mapping, state);
    expect(info.penChanged).toBe(false);
    expect(info.codeChanged).toBe(false);
    expect(isConflict(info)).toBe(false);
  });
});
