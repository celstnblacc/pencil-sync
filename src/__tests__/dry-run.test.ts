import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MappingConfig, MappingState, Settings, PenNodeSnapshot } from "../types.js";

vi.mock("../claude-runner.js", () => ({
  runClaude: vi.fn(),
}));

vi.mock("../prompt-builder.js", () => ({
  buildPenToCodePrompt: vi.fn().mockResolvedValue("test prompt"),
  buildCodeToPenPrompt: vi.fn().mockResolvedValue("test prompt"),
}));

const { syncPenToCode } = await import("../pen-to-code.js");
const { syncCodeToPen } = await import("../code-to-pen.js");
const { runClaude } = await import("../claude-runner.js");

const mockedRunClaude = vi.mocked(runClaude);

const baseSettings: Settings = {
  debounceMs: 500,
  model: "claude-sonnet-4-6",
  maxBudgetUsd: 1,
  conflictStrategy: "prompt",
  stateFile: ".state.json",
  logLevel: "error",
};

function makePenJson(nodes: Record<string, unknown>[]): string {
  return JSON.stringify({ children: nodes });
}

function makePreviousState(penSnapshot: PenNodeSnapshot): MappingState {
  return {
    mappingId: "test",
    penHash: "old",
    codeHashes: {},
    lastSyncTimestamp: Date.now(),
    lastSyncDirection: "pen-to-code",
    penSnapshot,
  };
}

describe("syncPenToCode -- dry-run mode", () => {
  let dir: string;
  let mapping: MappingConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-dry-run-"));
    const codeDir = join(dir, "src");
    await mkdir(codeDir);
    await writeFile(join(codeDir, "app.tsx"), "<App />");

    const cssPath = join(codeDir, "globals.css");
    await writeFile(cssPath, ":root {\n  --color-primary: 34 72 70;\n}\n");

    mapping = {
      id: "test",
      penFile: join(dir, "design.pen"),
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both",
      styleFiles: ["globals.css"],
    };
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns dryRun:true and does NOT write the CSS file when fill changes detected", async () => {
    const pen = makePenJson([{
      id: "node1",
      name: "PrimaryButton",
      fill: "#000000",   // new value
    }]);
    await writeFile(mapping.penFile, pen);

    const previousState = makePreviousState({
      node1: { name: "PrimaryButton", fill: "#224846" },  // old value
    });

    const result = await syncPenToCode(mapping, baseSettings, previousState, true);

    // Must declare dryRun
    expect(result.dryRun).toBe(true);

    // Must list the CSS file that WOULD have changed
    expect(result.filesChanged).toContain("globals.css");

    // Must NOT have actually written the CSS file
    const cssContent = await readFile(join(mapping.codeDir, "globals.css"), "utf-8");
    expect(cssContent).toContain("34 72 70");   // old value still present
    expect(cssContent).not.toContain("0 0 0");  // new value not applied

    // Claude must not have been called
    expect(mockedRunClaude).not.toHaveBeenCalled();
  });

  it("returns dryRun:true and does NOT call Claude for non-fill diffs", async () => {
    const pen = makePenJson([{
      id: "node1",
      name: "Title",
      content: "New Title",
    }]);
    await writeFile(mapping.penFile, pen);

    const previousState = makePreviousState({
      node1: { name: "Title", content: "Old Title" },
    });

    const result = await syncPenToCode(mapping, baseSettings, previousState, true);

    expect(result.dryRun).toBe(true);
    expect(result.success).toBe(true);
    expect(mockedRunClaude).not.toHaveBeenCalled();
  });
});

describe("syncCodeToPen -- dry-run mode", () => {
  let dir: string;
  let mapping: MappingConfig;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-dry-run-"));
    const codeDir = join(dir, "src");
    await mkdir(codeDir);
    await writeFile(join(codeDir, "Button.tsx"), "export function Button() {}");
    await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));

    mapping = {
      id: "test",
      penFile: join(dir, "design.pen"),
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both",
    };
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns dryRun:true and does NOT call Claude", async () => {
    const result = await syncCodeToPen(
      mapping,
      baseSettings,
      [join(mapping.codeDir, "Button.tsx")],
      undefined,
      true,
    );

    expect(result.dryRun).toBe(true);
    expect(result.success).toBe(true);
    expect(mockedRunClaude).not.toHaveBeenCalled();
  });

  it("still returns filesChanged listing what would sync", async () => {
    const changedFile = join(mapping.codeDir, "Button.tsx");
    const result = await syncCodeToPen(
      mapping,
      baseSettings,
      [changedFile],
      undefined,
      true,
    );

    expect(result.dryRun).toBe(true);
    expect(result.filesChanged.length).toBeGreaterThan(0);
  });
});
