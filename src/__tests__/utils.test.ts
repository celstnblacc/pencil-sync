import { describe, it, expect } from "vitest";

const { getCssStyleFile, validatePathWithin } = await import("../utils.js");

describe("getCssStyleFile", () => {
  it("returns first .css file from styleFiles", () => {
    const mapping = {
      id: "test",
      penFile: "/tmp/design.pen",
      codeDir: "/tmp/code",
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
      styleFiles: ["tailwind.config.js", "app/globals.css", "other.css"],
    };
    expect(getCssStyleFile(mapping)).toBe("app/globals.css");
  });

  it("returns undefined when no .css file exists", () => {
    const mapping = {
      id: "test",
      penFile: "/tmp/design.pen",
      codeDir: "/tmp/code",
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
      styleFiles: ["tailwind.config.js"],
    };
    expect(getCssStyleFile(mapping)).toBeUndefined();
  });

  it("returns undefined when styleFiles is not set", () => {
    const mapping = {
      id: "test",
      penFile: "/tmp/design.pen",
      codeDir: "/tmp/code",
      codeGlobs: ["**/*.tsx"],
      direction: "both" as const,
    };
    expect(getCssStyleFile(mapping)).toBeUndefined();
  });
});

describe("validatePathWithin", () => {
  it("returns resolved path for valid relative file", () => {
    const result = validatePathWithin("/tmp/code", "app/globals.css");
    expect(result).toBe("/tmp/code/app/globals.css");
  });

  it("throws on path traversal with ..", () => {
    expect(() => validatePathWithin("/tmp/code", "../../etc/passwd")).toThrow(
      "Path traversal detected",
    );
  });

  it("throws on path traversal with nested ..", () => {
    expect(() => validatePathWithin("/tmp/code", "app/../../secret.txt")).toThrow(
      "Path traversal detected",
    );
  });

  it("allows nested paths within base directory", () => {
    const result = validatePathWithin("/tmp/code", "src/components/Button.tsx");
    expect(result).toBe("/tmp/code/src/components/Button.tsx");
  });

  it("throws on absolute file path that resolves outside base", () => {
    expect(() => validatePathWithin("/tmp/code", "/etc/passwd")).toThrow("Path traversal detected");
  });

  it("allows directory names starting with dots (e.g. '..theme')", () => {
    // "..theme/globals.css" resolves inside base — must not be falsely rejected
    const result = validatePathWithin("/tmp/code", "..theme/globals.css");
    expect(result).toBe("/tmp/code/..theme/globals.css");
  });

  it("throws on exact '..' as relative path", () => {
    expect(() => validatePathWithin("/tmp/code/sub", "..")).toThrow("Path traversal detected");
  });
});
