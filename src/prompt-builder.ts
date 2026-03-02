import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MappingConfig } from "./types.js";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

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

export async function buildPenToCodePrompt(
  mapping: MappingConfig,
  changedScreens?: string[],
): Promise<string> {
  const template = await loadTemplate("pen-to-code");
  const screens = changedScreens ?? mapping.penScreens ?? [];

  return replacePlaceholders(template, {
    PEN_FILE: mapping.penFile,
    CODE_DIR: mapping.codeDir,
    FRAMEWORK: mapping.framework ?? "react",
    STYLING: mapping.styling ?? "tailwind",
    CODE_GLOBS: mapping.codeGlobs.join(", "),
    SCREENS: screens.length > 0 ? screens.join(", ") : "all screens",
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
