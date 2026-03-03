import { readFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { MappingConfig, PenNodeSnapshot } from "./types.js";
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

async function loadStyleFiles(mapping: MappingConfig): Promise<string> {
  const files = mapping.styleFiles ?? [];
  if (files.length === 0) return "";

  const sections: string[] = [];
  for (const filePath of files) {
    const fullPath = join(mapping.codeDir, filePath);
    try {
      const content = await readFile(fullPath, "utf-8");
      const relPath = relative(mapping.codeDir, fullPath);
      sections.push(`### \`${relPath}\`\n\`\`\`\n${content}\n\`\`\``);
    } catch (err) {
      log.debug(`Could not read style file ${fullPath}: ${err}`);
    }
  }

  if (sections.length === 0) return "";
  return `\n## Current Style Files\n\n${sections.join("\n\n")}\n`;
}

// ── .pen file reading and diffing ──

interface PenNode {
  id?: string;
  name?: string;
  type?: string;
  fill?: string;
  content?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  cornerRadius?: number;
  children?: PenNode[];
  [key: string]: unknown;
}

const TRACKED_PROPS = ["fill", "content", "fontSize", "fontWeight", "fontFamily", "cornerRadius"] as const;

function flattenPenNodes(node: PenNode): PenNodeSnapshot {
  const snapshot: PenNodeSnapshot = {};

  if (node.id) {
    const props: Record<string, string | number> = {};
    if (node.name) props.name = node.name;
    if (node.type) props.type = node.type;
    for (const prop of TRACKED_PROPS) {
      if (node[prop] !== undefined && node[prop] !== null) {
        props[prop] = node[prop] as string | number;
      }
    }
    if (Object.keys(props).length > 1) { // at least name/type + one visual prop
      snapshot[node.id] = props;
    }
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      Object.assign(snapshot, flattenPenNodes(child));
    }
  }

  return snapshot;
}

export function snapshotPenFile(penFile: string, raw: string): PenNodeSnapshot {
  try {
    const pen = JSON.parse(raw);
    const snapshot: PenNodeSnapshot = {};
    for (const child of (pen.children ?? [])) {
      Object.assign(snapshot, flattenPenNodes(child));
    }
    return snapshot;
  } catch (err) {
    log.error(`Failed to parse .pen file: ${err}`);
    return {};
  }
}

export interface PenDiffEntry {
  nodeId: string;
  nodeName: string;
  prop: string;
  oldValue: string | number;
  newValue: string | number;
}

export function diffPenSnapshots(
  oldSnap: PenNodeSnapshot,
  newSnap: PenNodeSnapshot,
): PenDiffEntry[] {
  const diffs: PenDiffEntry[] = [];

  for (const [nodeId, newProps] of Object.entries(newSnap)) {
    const oldProps = oldSnap[nodeId];
    if (!oldProps) continue; // new node — skip for now

    for (const prop of TRACKED_PROPS) {
      const oldVal = oldProps[prop];
      const newVal = newProps[prop];
      if (oldVal !== undefined && newVal !== undefined && String(oldVal) !== String(newVal)) {
        diffs.push({
          nodeId,
          nodeName: String(newProps.name ?? nodeId),
          prop,
          oldValue: oldVal,
          newValue: newVal,
        });
      }
    }
  }

  return diffs;
}

function formatDiffForPrompt(diffs: PenDiffEntry[]): string {
  if (diffs.length === 0) return "";

  const lines = diffs.map(d =>
    `- **${d.nodeName}** (${d.nodeId}): \`${d.prop}\` changed from \`${d.oldValue}\` → \`${d.newValue}\``
  );

  return `\n## Design Changes Detected\n\n${lines.join("\n")}\n`;
}

// ── Prompt builders ──

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
