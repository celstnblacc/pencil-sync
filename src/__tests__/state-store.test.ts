import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore, hashFile, hashCodeDir, diffHashes } from "../state-store.js";

describe("hashFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns SHA-256 hex hash of file", async () => {
    const file = join(dir, "test.txt");
    await writeFile(file, "hello world");
    const hash = await hashFile(file);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns same hash for same content", async () => {
    const file1 = join(dir, "a.txt");
    const file2 = join(dir, "b.txt");
    await writeFile(file1, "same content");
    await writeFile(file2, "same content");
    expect(await hashFile(file1)).toBe(await hashFile(file2));
  });

  it("returns different hash for different content", async () => {
    const file1 = join(dir, "a.txt");
    const file2 = join(dir, "b.txt");
    await writeFile(file1, "content a");
    await writeFile(file2, "content b");
    expect(await hashFile(file1)).not.toBe(await hashFile(file2));
  });

  it("returns empty string for non-existent file", async () => {
    expect(await hashFile(join(dir, "nope.txt"))).toBe("");
  });
});

describe("hashCodeDir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collects matching files with relative paths", async () => {
    await writeFile(join(dir, "app.tsx"), "export default function App() {}");
    await writeFile(join(dir, "style.css"), "body {}");

    const hashes = await hashCodeDir(dir, ["**/*.tsx"]);
    expect(Object.keys(hashes)).toEqual(["app.tsx"]);
    expect(hashes["app.tsx"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches multiple glob patterns", async () => {
    await writeFile(join(dir, "a.tsx"), "a");
    await writeFile(join(dir, "b.css"), "b");
    await writeFile(join(dir, "c.txt"), "c");

    const hashes = await hashCodeDir(dir, ["**/*.tsx", "**/*.css"]);
    const keys = Object.keys(hashes).sort();
    expect(keys).toEqual(["a.tsx", "b.css"]);
  });

  it("recurses into subdirectories", async () => {
    await mkdir(join(dir, "components"), { recursive: true });
    await writeFile(join(dir, "components", "Button.tsx"), "button");
    const hashes = await hashCodeDir(dir, ["**/*.tsx"]);
    expect(Object.keys(hashes)).toContain("components/Button.tsx");
  });

  it("ignores node_modules", async () => {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "index.tsx"), "nope");
    const hashes = await hashCodeDir(dir, ["**/*.tsx"]);
    expect(Object.keys(hashes)).toEqual([]);
  });
});

describe("diffHashes", () => {
  it("detects new files", () => {
    const before: Record<string, string> = {};
    const after: Record<string, string> = { "new.tsx": "abc123" };
    expect(diffHashes(before, after)).toEqual(["new.tsx"]);
  });

  it("detects modified files", () => {
    const before = { "app.tsx": "hash1" };
    const after = { "app.tsx": "hash2" };
    expect(diffHashes(before, after)).toEqual(["app.tsx"]);
  });

  it("detects deleted files", () => {
    const before = { "old.tsx": "hash1" };
    const after: Record<string, string> = {};
    expect(diffHashes(before, after)).toEqual(["old.tsx"]);
  });

  it("returns empty for identical hashes", () => {
    const hashes = { "a.tsx": "h1", "b.tsx": "h2" };
    expect(diffHashes(hashes, { ...hashes })).toEqual([]);
  });

  it("handles mixed changes", () => {
    const before = { "kept.tsx": "same", "modified.tsx": "old", "deleted.tsx": "d" };
    const after = { "kept.tsx": "same", "modified.tsx": "new", "added.tsx": "a" };
    const changed = diffHashes(before, after);
    expect(changed).toContain("modified.tsx");
    expect(changed).toContain("deleted.tsx");
    expect(changed).toContain("added.tsx");
    expect(changed).not.toContain("kept.tsx");
  });
});

describe("StateStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads from empty state when file does not exist", async () => {
    const store = new StateStore(join(dir, "state.json"));
    await store.load();
    expect(store.getMappingState("nope")).toBeUndefined();
  });

  it("saves and reloads state", async () => {
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

    const state = store.getMappingState("test");
    expect(state).toBeDefined();
    expect(state!.mappingId).toBe("test");
    expect(state!.penHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state!.lastSyncDirection).toBe("pen-to-code");

    // Reload from disk
    const store2 = new StateStore(stateFile);
    await store2.load();
    const reloaded = store2.getMappingState("test");
    expect(reloaded).toEqual(state);
  });

  it("initMappingState only initializes once", async () => {
    const stateFile = join(dir, "state.json");
    const codeDir = join(dir, "code");
    await mkdir(codeDir);
    await writeFile(join(codeDir, "a.tsx"), "v1");
    const penFile = join(dir, "d.pen");
    await writeFile(penFile, "pen");

    const store = new StateStore(stateFile);
    await store.load();

    const mapping = {
      id: "m1",
      penFile,
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
    };

    await store.initMappingState(mapping);
    const first = store.getMappingState("m1");

    // Modify file and re-init — should NOT update
    await writeFile(join(codeDir, "a.tsx"), "v2");
    await store.initMappingState(mapping);
    const second = store.getMappingState("m1");

    expect(second!.codeHashes).toEqual(first!.codeHashes);
  });
});
