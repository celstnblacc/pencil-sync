import { readFile, open } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MappingConfig, PenDiffEntry } from "./types.js";
import { formatDiffForPrompt } from "./pen-snapshot.js";
import { validatePathWithin } from "./utils.js";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

const MAX_STYLE_FILE_BYTES = 50 * 1024; // 50KB

async function loadTemplate(name: string): Promise<string> {
  const path = join(PROMPTS_DIR, `${name}.md`);
  return readFile(path, "utf-8");
}

function replacePlaceholders(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

async function loadStyleFiles(mapping: MappingConfig): Promise<string> {
  const files = mapping.styleFiles ?? [];
  if (files.length === 0) return "";

  const sections: string[] = [];
  for (const filePath of files) {
    let fullPath: string;
    try {
      fullPath = validatePathWithin(mapping.codeDir, filePath);
    } catch (err) {
      log.warn(`Skipping style file with invalid path: ${err}`);
      continue;
    }

    try {
      const fh = await open(fullPath, "r");
      let content: string;
      try {
        const { size } = await fh.stat();
        if (size > MAX_STYLE_FILE_BYTES) {
          const buf = Buffer.alloc(MAX_STYLE_FILE_BYTES);
          const { bytesRead } = await fh.read(buf, 0, MAX_STYLE_FILE_BYTES, 0);
          content = buf.subarray(0, bytesRead).toString("utf-8") + "\n/* ... truncated ... */";
          log.warn(`Style file ${filePath} exceeds 50KB, truncated for prompt`);
        } else {
          content = await fh.readFile("utf-8");
        }
      } finally {
        await fh.close();
      }

      const relPath = relative(mapping.codeDir, fullPath);
      sections.push(`### \`${relPath}\`\n\`\`\`\n${content}\n\`\`\``);
    } catch (err) {
      log.debug(`Could not read style file ${fullPath}: ${err}`);
    }
  }

  if (sections.length === 0) return "";
  return `\n## Current Style Files\n\n${sections.join("\n\n")}\n`;
}

export async function buildPenToCodePrompt(
  mapping: MappingConfig,
  changedScreens?: string[],
  penDiffs?: PenDiffEntry[],
): Promise<string> {
  const template = await loadTemplate("pen-to-code");
  const screens = changedScreens ?? mapping.penScreens ?? [];
  const styleContext = await loadStyleFiles(mapping);
  const diffContext = penDiffs ? formatDiffForPrompt(penDiffs) : "";

  return replacePlaceholders(template, {
    PEN_FILE: mapping.penFile,
    CODE_DIR: mapping.codeDir,
    FRAMEWORK: mapping.framework ?? "react",
    STYLING: mapping.styling ?? "tailwind",
    CODE_GLOBS: mapping.codeGlobs.join(", "),
    SCREENS: screens.length > 0 ? screens.join(", ") : "all screens",
    STYLE_FILES: styleContext,
    DESIGN_CHANGES: diffContext,
  });
}

export async function buildCodeToPenPrompt(
  mapping: MappingConfig,
  changedFiles: string[],
): Promise<string> {
  const template = await loadTemplate("code-to-pen");

  return replacePlaceholders(template, {
    PEN_FILE: mapping.penFile,
    CODE_DIR: mapping.codeDir,
    FRAMEWORK: mapping.framework ?? "react",
    STYLING: mapping.styling ?? "tailwind",
    CHANGED_FILES: changedFiles.join("\n- "),
  });
}

export async function buildConflictPrompt(
  mapping: MappingConfig,
  changedCodeFiles: string[],
): Promise<string> {
  const template = await loadTemplate("conflict-resolve");

  return replacePlaceholders(template, {
    PEN_FILE: mapping.penFile,
    CODE_DIR: mapping.codeDir,
    FRAMEWORK: mapping.framework ?? "react",
    STYLING: mapping.styling ?? "tailwind",
    CHANGED_CODE_FILES: changedCodeFiles.join("\n- "),
    SCREENS: (mapping.penScreens ?? []).join(", ") || "all screens",
  });
}
