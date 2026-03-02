import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MappingConfig, Settings } from "../types.js";

// Mock claude-runner before importing the module under test
vi.mock("../claude-runner.js", () => ({
  runClaude: vi.fn(),
}));

// Mock prompt-builder
vi.mock("../prompt-builder.js", () => ({
  buildPenToCodePrompt: vi.fn().mockResolvedValue("test prompt"),
}));

const { syncPenToCode } = await import("../pen-to-code.js");
const { runClaude } = await import("../claude-runner.js");

const mockedRunClaude = vi.mocked(runClaude);

describe("syncPenToCode", () => {
  let dir: string;
  let mapping: MappingConfig;
  let settings: Settings;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
    await mkdir(join(dir, "code"));
    await writeFile(join(dir, "code", "app.tsx"), "original content");
    await writeFile(join(dir, "design.pen"), "pen content");

    mapping = {
      id: "test",
      penFile: join(dir, "design.pen"),
      codeDir: join(dir, "code"),
      codeGlobs: ["**/*.tsx"],
      direction: "both",
    };

    settings = {
      debounceMs: 2000,
      model: "claude-sonnet-4-6",
      maxBudgetUsd: 0.5,
      conflictStrategy: "prompt",
      stateFile: join(dir, ".state.json"),
      logLevel: "error",
    };
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("detects files changed by Claude via filesystem diff", async () => {
    mockedRunClaude.mockImplementation(async () => {
      // Simulate Claude modifying a file and creating a new one
      await writeFile(join(dir, "code", "app.tsx"), "modified content");
      await writeFile(join(dir, "code", "new.tsx"), "new file");
      return { success: true, stdout: "Done", stderr: "", exitCode: 0 };
    });

    const result = await syncPenToCode(mapping, settings);

    expect(result.success).toBe(true);
    expect(result.direction).toBe("pen-to-code");
    expect(result.filesChanged).toContain("app.tsx");
    expect(result.filesChanged).toContain("new.tsx");
  });

  it("returns empty filesChanged when Claude makes no file changes", async () => {
    mockedRunClaude.mockResolvedValue({
      success: true,
      stdout: "No changes needed",
      stderr: "",
      exitCode: 0,
    });

    const result = await syncPenToCode(mapping, settings);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
  });

  it("returns error result on Claude failure", async () => {
    mockedRunClaude.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "API error: rate limited",
      exitCode: 1,
    });

    const result = await syncPenToCode(mapping, settings);

    expect(result.success).toBe(false);
    expect(result.error).toContain("API error");
    expect(result.filesChanged).toEqual([]);
  });

  it("propagates tokenUsage from Claude result", async () => {
    mockedRunClaude.mockResolvedValue({
      success: true,
      stdout: "Done",
      stderr: "",
      exitCode: 0,
      tokenUsage: { input: 1000, output: 200 },
    });

    const result = await syncPenToCode(mapping, settings);
    expect(result.tokenUsage).toEqual({ input: 1000, output: 200 });
  });
});
