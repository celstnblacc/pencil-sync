import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MappingConfig, Settings } from "../types.js";

vi.mock("../claude-runner.js", () => ({
  runClaude: vi.fn(),
}));

vi.mock("../prompt-builder.js", () => ({
  buildCodeToPenPrompt: vi.fn().mockResolvedValue("test prompt"),
}));

const { syncCodeToPen } = await import("../code-to-pen.js");
const { runClaude } = await import("../claude-runner.js");

const mockedRunClaude = vi.mocked(runClaude);

describe("syncCodeToPen", () => {
  let dir: string;
  let mapping: MappingConfig;
  let settings: Settings;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
    await mkdir(join(dir, "code"));
    await writeFile(join(dir, "design.pen"), JSON.stringify({ children: [] }));

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

  it("short-circuits when no changed files", async () => {
    const result = await syncCodeToPen(mapping, settings, []);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
    expect(mockedRunClaude).not.toHaveBeenCalled();
  });

  it("detects .pen file changed via hash diff", async () => {
    mockedRunClaude.mockImplementation(async () => {
      // Simulate Claude modifying the .pen file
      await writeFile(join(dir, "design.pen"), JSON.stringify({
        children: [{ id: "n1", name: "title", type: "text", content: "hello" }],
      }));
      return { success: true, stdout: "Done", stderr: "", exitCode: 0 };
    });

    const result = await syncCodeToPen(mapping, settings, ["app.tsx"]);

    expect(result.success).toBe(true);
    expect(result.direction).toBe("code-to-pen");
    expect(result.filesChanged).toEqual([mapping.penFile]);
  });

  it("returns error when .pen file is invalid after Claude run", async () => {
    mockedRunClaude.mockImplementation(async () => {
      await writeFile(join(dir, "design.pen"), "modified pen content");
      return { success: true, stdout: "Done", stderr: "", exitCode: 0 };
    });

    const result = await syncCodeToPen(mapping, settings, ["app.tsx"]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid JSON");
    expect(result.filesChanged).toEqual([mapping.penFile]);
  });

  it("returns empty filesChanged when .pen file unchanged", async () => {
    mockedRunClaude.mockResolvedValue({
      success: true,
      stdout: "No changes",
      stderr: "",
      exitCode: 0,
    });

    const result = await syncCodeToPen(mapping, settings, ["app.tsx"]);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
  });

  it("returns error on Claude failure", async () => {
    mockedRunClaude.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "error occurred",
      exitCode: 1,
    });

    const result = await syncCodeToPen(mapping, settings, ["app.tsx"]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("error occurred");
  });

  it("propagates tokenUsage", async () => {
    mockedRunClaude.mockResolvedValue({
      success: true,
      stdout: "Done",
      stderr: "",
      exitCode: 0,
      tokenUsage: { input: 500, output: 100 },
    });

    const result = await syncCodeToPen(mapping, settings, ["app.tsx"]);
    expect(result.tokenUsage).toEqual({ input: 500, output: 100 });
  });

  it("passes MCP tools to runClaude when mcpConfigPath is set", async () => {
    const mcpSettings = { ...settings, mcpConfigPath: "/path/to/mcp.json" };

    mockedRunClaude.mockResolvedValue({
      success: true,
      stdout: "Done",
      stderr: "",
      exitCode: 0,
    });

    await syncCodeToPen(mapping, mcpSettings, ["app.tsx"]);

    const call = mockedRunClaude.mock.calls[0][0];
    expect(call.allowedTools).toContain("mcp__pencil__batch_get");
    expect(call.allowedTools).toContain("mcp__pencil__batch_design");
    expect(call.allowedTools).toContain("mcp__pencil__set_variables");
    expect(call.allowedTools).toContain("mcp__pencil__get_screenshot");
    expect(call.mcpConfigPath).toBe("/path/to/mcp.json");
  });

  it("does not pass MCP tools when mcpConfigPath is not set", async () => {
    mockedRunClaude.mockResolvedValue({
      success: true,
      stdout: "Done",
      stderr: "",
      exitCode: 0,
    });

    await syncCodeToPen(mapping, settings, ["app.tsx"]);

    const call = mockedRunClaude.mock.calls[0][0];
    expect(call.allowedTools).toBeUndefined();
    expect(call.mcpConfigPath).toBeUndefined();
  });

  it("returns penSnapshot after successful sync", async () => {
    // Write a valid .pen file with nodes
    const penContent = JSON.stringify({
      children: [
        { id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000", cornerRadius: 8 },
      ],
    });
    await writeFile(join(dir, "design.pen"), penContent);

    mockedRunClaude.mockResolvedValue({
      success: true,
      stdout: "Done",
      stderr: "",
      exitCode: 0,
    });

    const result = await syncCodeToPen(mapping, settings, ["app.tsx"]);

    expect(result.success).toBe(true);
    expect(result.penSnapshot).toBeDefined();
    expect(result.penSnapshot!["btn1"]).toBeDefined();
    expect(result.penSnapshot!["btn1"].fill).toBe("#ff0000");
  });
});
