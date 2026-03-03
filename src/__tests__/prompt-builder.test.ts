import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PenDiffEntry } from "../types.js";

describe("prompt-builder", () => {
  // Check that the prompts directory exists and templates are loadable
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PROMPTS_DIR = join(__dirname, "..", "..", "prompts");

  it("pen-to-code template exists", async () => {
    const { readFile } = await import("node:fs/promises");
    const template = await readFile(join(PROMPTS_DIR, "pen-to-code.md"), "utf-8");
    expect(template).toContain("{{CODE_DIR}}");
    expect(template).toContain("{{DESIGN_CHANGES}}");
    expect(template).toContain("{{STYLE_FILES}}");
  });

  it("code-to-pen template exists", async () => {
    const { readFile } = await import("node:fs/promises");
    const template = await readFile(join(PROMPTS_DIR, "code-to-pen.md"), "utf-8");
    expect(template).toContain("{{PEN_FILE}}");
    expect(template).toContain("{{CHANGED_FILES}}");
  });

  it("conflict-resolve template exists", async () => {
    const { readFile } = await import("node:fs/promises");
    const template = await readFile(join(PROMPTS_DIR, "conflict-resolve.md"), "utf-8");
    expect(template).toContain("{{PEN_FILE}}");
  });
});

const {
  buildPenToCodePrompt, buildCodeToPenPrompt, buildConflictPrompt,
} = await import("../prompt-builder.js");

describe("prompt-builder functions", () => {

  const mapping = {
    id: "test",
    penFile: "/tmp/design.pen",
    codeDir: "/tmp/code",
    codeGlobs: ["**/*.tsx", "**/*.css"],
    direction: "both" as const,
    framework: "react" as const,
    styling: "tailwind" as const,
    penScreens: ["Home", "Settings"],
  };

  it("buildPenToCodePrompt fills placeholders", async () => {
    const prompt = await buildPenToCodePrompt(mapping);
    expect(prompt).toContain("/tmp/code");
    expect(prompt).toContain("react");
    expect(prompt).toContain("tailwind");
    expect(prompt).not.toContain("{{CODE_DIR}}");
    expect(prompt).not.toContain("{{FRAMEWORK}}");
  });

  it("buildCodeToPenPrompt fills placeholders", async () => {
    const prompt = await buildCodeToPenPrompt(mapping, ["Header.tsx", "Footer.tsx"]);
    expect(prompt).toContain("/tmp/design.pen");
    expect(prompt).toContain("Header.tsx");
    expect(prompt).toContain("Footer.tsx");
    expect(prompt).not.toContain("{{CHANGED_FILES}}");
  });

  it("buildConflictPrompt fills placeholders", async () => {
    const prompt = await buildConflictPrompt(mapping, ["app.tsx"]);
    expect(prompt).toContain("/tmp/design.pen");
    expect(prompt).toContain("app.tsx");
    expect(prompt).not.toContain("{{PEN_FILE}}");
  });

  it("uses default framework/styling when not set", async () => {
    const bare = {
      id: "bare",
      penFile: "/tmp/bare.pen",
      codeDir: "/tmp/code",
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
    };
    const prompt = await buildPenToCodePrompt(bare);
    // Should fall back to "react" and "tailwind"
    expect(prompt).toContain("react");
    expect(prompt).toContain("tailwind");
  });

  it("buildPenToCodePrompt includes design changes when diffs provided", async () => {
    const diffs: PenDiffEntry[] = [
      { nodeId: "btn1", nodeName: "submitBtn", prop: "content", oldValue: "old", newValue: "new" },
    ];
    const prompt = await buildPenToCodePrompt(mapping, undefined, diffs);
    expect(prompt).toContain("submitBtn");
    expect(prompt).toContain("content");
    expect(prompt).toContain("old");
    expect(prompt).toContain("new");
  });
});

// ── Style file truncation (M7) ──

describe("style file truncation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-prompt-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("truncates style files larger than 50KB", async () => {
    const codeDir = join(dir, "code");
    await mkdir(codeDir, { recursive: true });

    // Create a CSS file larger than 50KB
    const largeContent = ":root {\n" + "  --color-x: 0 0 0;\n".repeat(3000) + "}\n";
    expect(Buffer.byteLength(largeContent)).toBeGreaterThan(50 * 1024);
    await writeFile(join(codeDir, "globals.css"), largeContent);

    const mapping = {
      id: "test",
      penFile: join(dir, "design.pen"),
      codeDir,
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
      styleFiles: ["globals.css"],
    };

    const prompt = await buildPenToCodePrompt(mapping);
    expect(prompt).toContain("/* ... truncated ... */");
    // Should NOT contain the full content
    expect(prompt.length).toBeLessThan(largeContent.length);
  });
});
