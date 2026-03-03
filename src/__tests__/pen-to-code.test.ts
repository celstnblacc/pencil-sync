import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MappingConfig, MappingState, Settings, PenNodeSnapshot } from "../types.js";

// Mock claude-runner before importing the module under test
vi.mock("../claude-runner.js", () => ({
  runClaude: vi.fn(),
}));

vi.mock("../prompt-builder.js", () => ({
  buildPenToCodePrompt: vi.fn().mockResolvedValue("test prompt"),
}));

const { syncPenToCode } = await import("../pen-to-code.js");
const { runClaude } = await import("../claude-runner.js");

const mockedRunClaude = vi.mocked(runClaude);

function makePenJson(nodes: Record<string, unknown>[]): string {
  return JSON.stringify({ children: nodes });
}

function makeCssWithThemes(varName: string, rgb: string): string {
  return `:root {
  --color-primary: 255 132 0;
  --color-${varName}: ${rgb};
}

[data-theme="monokai"] {
  --color-primary: 166 226 46;
  --color-${varName}: ${rgb};
}

[data-theme="nord"] {
  --color-primary: 136 192 208;
  --color-${varName}: ${rgb};
}
`;
}

function makeSnapshot(nodeId: string, props: Record<string, string | number>): PenNodeSnapshot {
  return { [nodeId]: props };
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

describe("syncPenToCode", () => {
  let dir: string;
  let mapping: MappingConfig;
  let settings: Settings;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-p2c-"));
    await mkdir(join(dir, "code", "app"), { recursive: true });
    await writeFile(join(dir, "code", "app.tsx"), "original content");

    mapping = {
      id: "test",
      penFile: join(dir, "design.pen"),
      codeDir: join(dir, "code"),
      codeGlobs: ["**/*.tsx", "**/*.css"],
      direction: "both",
      styleFiles: ["app/globals.css"],
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

  describe("color fast path (direct CSS replacement)", () => {
    it("replaces fill color in ALL theme blocks", async () => {
      // .pen file with new color
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" }]),
      );

      // CSS file with old color in 3 theme blocks
      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        makeCssWithThemes("accent-submit", "172 255 204"),
      );

      const previousState = makePreviousState(
        makeSnapshot("btn1", { name: "submitBtn", type: "frame", fill: "#acffcc" }),
      );

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      expect(result.filesChanged).toContain("app/globals.css");

      // Verify ALL theme blocks were updated
      const css = await readFile(join(dir, "code", "app", "globals.css"), "utf-8");
      const matches = css.match(/255 0 0/g);
      expect(matches).toHaveLength(3); // :root + monokai + nord
      expect(css).not.toContain("172 255 204");
    });

    it("handles #RRGGBBAA format (strips alpha)", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "btn1", name: "submitBtn", type: "frame", fill: "#acffccff" }]),
      );

      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        makeCssWithThemes("accent-submit", "64 20 23"),
      );

      const previousState = makePreviousState(
        makeSnapshot("btn1", { name: "submitBtn", type: "frame", fill: "#401417ff" }),
      );

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      const css = await readFile(join(dir, "code", "app", "globals.css"), "utf-8");
      // #acffcc → 172 255 204
      expect(css).toContain("172 255 204");
      expect(css).not.toContain("64 20 23");
    });

    it("does NOT call Claude CLI for fill-only changes", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" }]),
      );

      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        makeCssWithThemes("accent-submit", "0 255 0"),
      );

      const previousState = makePreviousState(
        makeSnapshot("btn1", { name: "submitBtn", type: "frame", fill: "#00ff00" }),
      );

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      expect(mockedRunClaude).not.toHaveBeenCalled();
      expect(result.tokenUsage).toBeUndefined();
    });

    it("returns empty filesChanged when no CSS file in styleFiles", async () => {
      const mappingNoCss: MappingConfig = {
        ...mapping,
        styleFiles: ["tailwind.config.js"], // no .css file
      };

      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" }]),
      );

      const previousState = makePreviousState(
        makeSnapshot("btn1", { name: "submitBtn", type: "frame", fill: "#00ff00" }),
      );

      const result = await syncPenToCode(mappingNoCss, settings, previousState);

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual([]);
    });

    it("handles multiple fill changes in a single sync", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([
          { id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" },
          { id: "bg1", name: "pageBg", type: "frame", fill: "#0000ff" },
        ]),
      );

      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        `:root {
  --color-accent-submit: 0 255 0;
  --color-bg-dark: 17 17 17;
}
[data-theme="monokai"] {
  --color-accent-submit: 0 255 0;
  --color-bg-dark: 17 17 17;
}
`,
      );

      const previousState = makePreviousState({
        btn1: { name: "submitBtn", type: "frame", fill: "#00ff00" },
        bg1: { name: "pageBg", type: "frame", fill: "#111111" },
      });

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      const css = await readFile(join(dir, "code", "app", "globals.css"), "utf-8");
      // #ff0000 → 255 0 0 (replaced from 0 255 0)
      expect(css).toContain("255 0 0");
      expect(css).not.toContain("0 255 0");
      // #0000ff → 0 0 255 (replaced from 17 17 17)
      expect(css).toContain("0 0 255");
      expect(css).not.toContain("17 17 17");
    });
  });

  describe("Claude CLI sync (text, typography)", () => {
    it("sends text changes to Claude CLI", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "t1", name: "title", type: "text", content: "new title", fill: "#fff" }]),
      );

      const previousState = makePreviousState(
        makeSnapshot("t1", { name: "title", type: "text", content: "old title", fill: "#fff" }),
      );

      mockedRunClaude.mockResolvedValue({
        success: true,
        stdout: "Updated title text",
        stderr: "",
        exitCode: 0,
        tokenUsage: { input: 500, output: 100 },
      });

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      expect(mockedRunClaude).toHaveBeenCalledTimes(1);
      expect(result.tokenUsage).toEqual({ input: 500, output: 100 });
    });

    it("sends typography changes to Claude CLI", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "t1", name: "heading", type: "text", fontSize: 24, fontWeight: "700" }]),
      );

      const previousState = makePreviousState(
        makeSnapshot("t1", { name: "heading", type: "text", fontSize: 16, fontWeight: "400" }),
      );

      mockedRunClaude.mockResolvedValue({
        success: true,
        stdout: "Updated font size and weight",
        stderr: "",
        exitCode: 0,
      });

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      expect(mockedRunClaude).toHaveBeenCalledTimes(1);
    });

    it("returns error when Claude CLI fails for text changes", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "t1", name: "title", type: "text", content: "new" }]),
      );

      const previousState = makePreviousState(
        makeSnapshot("t1", { name: "title", type: "text", content: "old" }),
      );

      mockedRunClaude.mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "API error: rate limited",
        exitCode: 1,
      });

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Claude CLI failed");
    });
  });

  describe("mixed changes (fill + text)", () => {
    it("applies fill directly and sends text to Claude CLI", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([
          { id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" },
          { id: "t1", name: "btnText", type: "text", content: "submit", fill: "#fff" },
        ]),
      );

      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        makeCssWithThemes("accent-submit", "0 128 0"),
      );

      const previousState = makePreviousState({
        btn1: { name: "submitBtn", type: "frame", fill: "#008000" },
        t1: { name: "btnText", type: "text", content: "send", fill: "#fff" },
      });

      mockedRunClaude.mockResolvedValue({
        success: true,
        stdout: "Updated text",
        stderr: "",
        exitCode: 0,
        tokenUsage: { input: 300, output: 50 },
      });

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      // Fill change applied directly
      const css = await readFile(join(dir, "code", "app", "globals.css"), "utf-8");
      expect(css).toContain("255 0 0");
      expect(css).not.toContain("0 128 0");
      // Text change sent to Claude
      expect(mockedRunClaude).toHaveBeenCalledTimes(1);
      expect(result.filesChanged).toContain("app/globals.css");
    });

    it("reports partial success when fill succeeds but Claude fails", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([
          { id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" },
          { id: "t1", name: "title", type: "text", content: "new" },
        ]),
      );

      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        makeCssWithThemes("accent-submit", "0 128 0"),
      );

      const previousState = makePreviousState({
        btn1: { name: "submitBtn", type: "frame", fill: "#008000" },
        t1: { name: "title", type: "text", content: "old" },
      });

      mockedRunClaude.mockResolvedValue({
        success: false,
        stdout: "",
        stderr: "timeout",
        exitCode: 1,
      });

      const result = await syncPenToCode(mapping, settings, previousState);

      // Partial success: fill changed, but Claude failed
      expect(result.success).toBe(true); // fill succeeded
      expect(result.error).toContain("Claude CLI failed");
      expect(result.filesChanged).toContain("app/globals.css");

      // CSS was still updated
      const css = await readFile(join(dir, "code", "app", "globals.css"), "utf-8");
      expect(css).toContain("255 0 0");
    });
  });

  describe("snapshot diffing", () => {
    it("skips sync when no changes detected", async () => {
      const penContent = makePenJson([{ id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" }]);
      await writeFile(join(dir, "design.pen"), penContent);

      // Previous state has identical snapshot
      const previousState = makePreviousState(
        makeSnapshot("btn1", { name: "submitBtn", type: "frame", fill: "#ff0000" }),
      );

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual([]);
      expect(mockedRunClaude).not.toHaveBeenCalled();
    });

    it("returns penSnapshot in result for state persistence", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" }]),
      );

      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        makeCssWithThemes("accent-submit", "0 0 0"),
      );

      const previousState = makePreviousState(
        makeSnapshot("btn1", { name: "submitBtn", type: "frame", fill: "#000000" }),
      );

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.penSnapshot).toBeDefined();
      expect(result.penSnapshot!["btn1"]).toBeDefined();
      expect(result.penSnapshot!["btn1"].fill).toBe("#ff0000");
    });

    it("returns error when .pen file is missing", async () => {
      // Don't create the .pen file
      const result = await syncPenToCode(mapping, settings);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to read .pen file");
    });
  });

  describe("shorthand hex support", () => {
    it("expands #RGB shorthand to full hex for replacement", async () => {
      // .pen file with shorthand hex #f00 (red)
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "btn1", name: "submitBtn", type: "frame", fill: "#f00" }]),
      );

      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        makeCssWithThemes("accent-submit", "0 255 0"),
      );

      const previousState = makePreviousState(
        makeSnapshot("btn1", { name: "submitBtn", type: "frame", fill: "#0f0" }),
      );

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      const css = await readFile(join(dir, "code", "app", "globals.css"), "utf-8");
      // #f00 expands to #ff0000 → 255 0 0
      expect(css).toContain("255 0 0");
      expect(css).not.toContain("0 255 0");
    });
  });

  describe("color collision detection", () => {
    it("replaces all variables sharing the same RGB value", async () => {
      // Two different design nodes that both had the same old fill color
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([
          { id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" },
          { id: "bg1", name: "pageBg", type: "frame", fill: "#aabbcc" },
        ]),
      );

      // CSS has TWO different variables with the SAME RGB value
      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        `:root {
  --color-accent: 0 255 0;
  --color-bg-main: 0 255 0;
}
`,
      );

      const previousState = makePreviousState({
        btn1: { name: "submitBtn", type: "frame", fill: "#00ff00" },
        bg1: { name: "pageBg", type: "frame", fill: "#aabbcc" },
      });

      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      const css = await readFile(join(dir, "code", "app", "globals.css"), "utf-8");
      // Both variables should have been replaced (collision)
      expect(css).toContain("255 0 0");
      expect(css).not.toContain("0 255 0");
    });
  });

  describe("fill change error handling", () => {
    it("succeeds gracefully when old RGB is not found in CSS", async () => {
      await writeFile(
        join(dir, "design.pen"),
        makePenJson([{ id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000" }]),
      );

      // CSS does NOT contain the old RGB value
      await mkdir(join(dir, "code", "app"), { recursive: true });
      await writeFile(
        join(dir, "code", "app", "globals.css"),
        `:root {
  --color-accent: 99 99 99;
}
`,
      );

      const previousState = makePreviousState(
        makeSnapshot("btn1", { name: "submitBtn", type: "frame", fill: "#00ff00" }),
      );

      // Should succeed (non-blocking) even though the old RGB is not in the CSS
      const result = await syncPenToCode(mapping, settings, previousState);

      expect(result.success).toBe(true);
      // No files changed since old RGB wasn't found
      expect(result.filesChanged).toEqual([]);
    });
  });
});
