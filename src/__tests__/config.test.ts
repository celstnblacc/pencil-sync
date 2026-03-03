import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectFramework, detectStyling, loadConfig } from "../config.js";

describe("detectFramework", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects Next.js from config file", async () => {
    await writeFile(join(dir, "next.config.js"), "module.exports = {}");
    expect(await detectFramework(dir)).toBe("nextjs");
  });

  it("detects Svelte from config file", async () => {
    await writeFile(join(dir, "svelte.config.js"), "export default {}");
    expect(await detectFramework(dir)).toBe("svelte");
  });

  it("detects Astro from config file", async () => {
    await writeFile(join(dir, "astro.config.mjs"), "export default {}");
    expect(await detectFramework(dir)).toBe("astro");
  });

  it("detects React from package.json deps", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { react: "^18.0.0" },
    }));
    expect(await detectFramework(dir)).toBe("react");
  });

  it("detects Vue from package.json deps", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { vue: "^3.0.0" },
    }));
    expect(await detectFramework(dir)).toBe("vue");
  });

  it("returns unknown when nothing detected", async () => {
    expect(await detectFramework(dir)).toBe("unknown");
  });

  it("prefers config file over package.json", async () => {
    await writeFile(join(dir, "next.config.js"), "");
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { vue: "^3.0.0" },
    }));
    expect(await detectFramework(dir)).toBe("nextjs");
  });
});

describe("detectStyling", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects tailwind from config file", async () => {
    await writeFile(join(dir, "tailwind.config.js"), "module.exports = {}");
    expect(await detectStyling(dir)).toBe("tailwind");
  });

  it("detects tailwind from package.json", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      devDependencies: { tailwindcss: "^4.0.0" },
    }));
    expect(await detectStyling(dir)).toBe("tailwind");
  });

  it("detects styled-components from package.json", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: { "styled-components": "^6.0.0" },
    }));
    expect(await detectStyling(dir)).toBe("styled-components");
  });

  it("returns unknown when nothing detected", async () => {
    expect(await detectStyling(dir)).toBe("unknown");
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-test-"));
    await mkdir(join(dir, "code"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads valid JSON config", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      mappings: [{
        id: "main",
        penFile: "design.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
    }));

    const config = await loadConfig(configPath);
    expect(config.version).toBe(1);
    expect(config.mappings).toHaveLength(1);
    expect(config.mappings[0].id).toBe("main");
    expect(config.mappings[0].penFile).toContain(dir);
  });

  it("strips JSONC comments", async () => {
    const configPath = join(dir, "pencil-sync.config.jsonc");
    await writeFile(configPath, `{
      // This is a comment
      "version": 1,
      /* block comment */
      "mappings": [{
        "id": "main",
        "penFile": "design.pen",
        "codeDir": "code",
        "codeGlobs": ["**/*.tsx"],
        "direction": "both"
      }]
    }`);

    const config = await loadConfig(configPath);
    expect(config.version).toBe(1);
  });

  it("strips JSONC comments without corrupting glob patterns", async () => {
    const configPath = join(dir, "pencil-sync.config.jsonc");
    await writeFile(configPath, `{
      // line comment
      "version": 1,
      /* block comment */
      "mappings": [{
        "id": "main",
        "penFile": "design.pen",
        "codeDir": "code",
        "codeGlobs": ["**/*.tsx", "**/*.css"],
        "direction": "both"
      }]
    }`);

    const config = await loadConfig(configPath);
    expect(config.mappings[0].codeGlobs).toEqual(["**/*.tsx", "**/*.css"]);
  });

  it("merges with default settings", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "test",
        penFile: "d.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
      settings: { model: "claude-haiku-4-5-20251001" },
    }));

    const config = await loadConfig(configPath);
    expect(config.settings.model).toBe("claude-haiku-4-5-20251001");
    expect(config.settings.debounceMs).toBe(2000); // default
    expect(config.settings.maxBudgetUsd).toBe(0.5); // default
  });

  it("throws when no mappings", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({ mappings: [] }));

    await expect(loadConfig(configPath)).rejects.toThrow("at least one mapping");
  });

  it("throws when config file not found", async () => {
    await expect(loadConfig(join(dir, "nope.json"))).rejects.toThrow();
  });

  it("blocks __proto__ keys in settings (prototype pollution)", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    const malicious = {
      mappings: [{
        id: "test",
        penFile: "d.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
      settings: {
        model: "claude-haiku-4-5-20251001",
        "__proto__": { polluted: true },
        "constructor": { polluted: true },
        "prototype": { polluted: true },
      },
    };
    await writeFile(configPath, JSON.stringify(malicious));

    const config = await loadConfig(configPath);
    // Settings should have the safe model value
    expect(config.settings.model).toBe("claude-haiku-4-5-20251001");
    // Prototype chain should not be polluted
    const plain = {} as Record<string, unknown>;
    expect(plain["polluted"]).toBeUndefined();
    // Dangerous keys should not exist as own properties on the result
    expect(Object.getOwnPropertyDescriptor(config.settings, "__proto__")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(config.settings, "prototype")).toBeUndefined();
  });

  it("rejects duplicate mapping ids", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [
        { id: "app", penFile: "a.pen", codeDir: "code", codeGlobs: ["**/*.tsx"], direction: "both" },
        { id: "app", penFile: "b.pen", codeDir: "code", codeGlobs: ["**/*.tsx"], direction: "both" },
      ],
    }));

    await expect(loadConfig(configPath)).rejects.toThrow("Duplicate mapping id(s): app");
  });

  it("merges settings with no overrides", async () => {
    const configPath = join(dir, "pencil-sync.config.json");
    await writeFile(configPath, JSON.stringify({
      mappings: [{
        id: "test",
        penFile: "d.pen",
        codeDir: "code",
        codeGlobs: ["**/*.tsx"],
        direction: "both",
      }],
    }));

    const config = await loadConfig(configPath);
    expect(config.settings.model).toBe("claude-sonnet-4-6");
    expect(config.settings.debounceMs).toBe(2000);
  });
});
