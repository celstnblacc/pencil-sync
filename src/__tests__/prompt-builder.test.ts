import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

describe("prompt-builder", () => {
  // Check that the prompts directory exists and templates are loadable
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PROMPTS_DIR = join(__dirname, "..", "..", "prompts");

  it("pen-to-code template exists", async () => {
    const { readFile } = await import("node:fs/promises");
    const template = await readFile(join(PROMPTS_DIR, "pen-to-code.md"), "utf-8");
    expect(template).toContain("{{PEN_FILE}}");
    expect(template).toContain("{{CODE_DIR}}");
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

const { buildPenToCodePrompt, buildCodeToPenPrompt, buildConflictPrompt } =
  await import("../prompt-builder.js");

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
    expect(prompt).toContain("/tmp/design.pen");
    expect(prompt).toContain("/tmp/code");
    expect(prompt).toContain("react");
    expect(prompt).toContain("tailwind");
    expect(prompt).not.toContain("{{PEN_FILE}}");
    expect(prompt).not.toContain("{{CODE_DIR}}");
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
});
