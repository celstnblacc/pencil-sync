import { readFile, writeFile } from "node:fs/promises";
import { log } from "./logger.js";
import { runClaude } from "./claude-runner.js";
import { buildPenToCodePrompt } from "./prompt-builder.js";
import { snapshotPenFile, diffPenSnapshots } from "./pen-snapshot.js";
import { getCssStyleFile, validatePathWithin } from "./utils.js";
import type { PenDiffEntry, FillChangeResult, MappingConfig, Settings, SyncResult, MappingState } from "./types.js";
import { hashCodeDir, diffHashes } from "./state-store.js";

/**
 * Convert a hex color (#RRGGBB, #RRGGBBAA, or shorthand #RGB/#RGBA) to space-separated RGB channels.
 * Returns e.g. "34 72 70" for "#224846", or "" if invalid.
 */
function hexToRgbChannels(hex: string): string {
  let clean = hex.replace(/^#/, "");

  // Expand shorthand: #RGB → #RRGGBB, #RGBA → #RRGGBBAA
  if (clean.length === 3 || clean.length === 4) {
    clean = clean.split("").map(c => c + c).join("");
  }

  // Take first 6 chars (ignore alpha if present)
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return "";
  return `${r} ${g} ${b}`;
}

/**
 * Apply fill (color) changes directly to CSS files by replacing variable values.
 * This is a deterministic fast path that doesn't need Claude CLI.
 *
 * Strategy: For each fill change, find all CSS variable declarations whose value
 * matches the OLD RGB and replace with the NEW RGB. This updates ALL theme blocks.
 *
 * Returns structured FillChangeResult with both filesChanged and errors.
 */
function recordError(result: FillChangeResult, msg: string, level: "warn" | "error" = "warn"): void {
  result.errors.push(msg);
  log[level](msg);
}

async function applyFillChanges(
  mapping: MappingConfig,
  fillDiffs: PenDiffEntry[],
): Promise<FillChangeResult> {
  const result: FillChangeResult = { filesChanged: [], errors: [] };

  const cssFile = getCssStyleFile(mapping);
  if (!cssFile) {
    recordError(result, "No CSS file in styleFiles — cannot apply fill changes directly");
    return result;
  }

  let cssPath: string;
  try {
    cssPath = validatePathWithin(mapping.codeDir, cssFile);
  } catch (err) {
    recordError(result, `Invalid CSS file path: ${err}`);
    return result;
  }

  let css: string;
  try {
    css = await readFile(cssPath, "utf-8");
  } catch (err) {
    recordError(result, `Failed to read CSS file ${cssPath}: ${err}`, "error");
    return result;
  }

  let modified = false;

  for (const diff of fillDiffs) {
    const oldRgb = hexToRgbChannels(String(diff.oldValue));
    const newRgb = hexToRgbChannels(String(diff.newValue));

    if (!oldRgb || !newRgb) {
      recordError(result, `Could not convert hex values for ${diff.nodeName}.fill: ${diff.oldValue} → ${diff.newValue}`);
      continue;
    }

    if (oldRgb === newRgb) continue;

    // Replace ALL occurrences of the old RGB value in CSS variable declarations.
    // Pattern: "--color-SOMETHING: <oldRgb>;" → "--color-SOMETHING: <newRgb>;"
    // This catches the value in :root, [data-theme="monokai"], [data-theme="nord"], etc.
    const pattern = new RegExp(
      `(--color-[\\w-]+:\\s*)${escapeRegex(oldRgb)}(\\s*;)`,
      "g",
    );

    // Detect color collision — multiple distinct variable names sharing the same RGB value
    const allMatches = [...css.matchAll(pattern)];
    const matchedVarNames = new Set(
      allMatches.map(m => {
        // Extract the variable name from the captured group (e.g. "--color-foo: ")
        const varDecl = m[1].trim();
        return varDecl.replace(/:\s*$/, "");
      }),
    );

    if (matchedVarNames.size > 1) {
      log.warn(
        `Color collision: RGB "${oldRgb}" matches ${matchedVarNames.size} different variables: ${[...matchedVarNames].join(", ")}. All will be replaced with "${newRgb}".`,
      );
    }

    const newCss = css.replace(pattern, `$1${newRgb}$2`);

    if (newCss !== css) {
      const matchCount = allMatches.length;
      const varList = [...matchedVarNames].join(", ");
      log.info(`  ✓ ${diff.nodeName}.fill: replaced "${oldRgb}" → "${newRgb}" in ${matchCount} declaration(s) [${varList}]`);
      css = newCss;
      modified = true;
    } else {
      recordError(result, `${diff.nodeName}.fill: old RGB "${oldRgb}" not found in ${cssFile}`);
    }
  }

  if (modified) {
    await writeFile(cssPath, css);
    log.success(`Updated ${cssFile} with color changes`);
    result.filesChanged.push(cssFile);
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function syncPenToCode(
  mapping: MappingConfig,
  settings: Settings,
  previousState?: MappingState,
): Promise<SyncResult> {
  log.sync("pen-to-code", mapping.id, "Starting design → code sync");

  // Read the .pen file and compute diff against previous snapshot
  let penRaw: string;
  try {
    penRaw = await readFile(mapping.penFile, "utf-8");
  } catch (err) {
    return {
      success: false,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: [],
      error: `Failed to read .pen file: ${err}`,
    };
  }

  const newSnapshot = snapshotPenFile(mapping.penFile, penRaw);
  const oldSnapshot = previousState?.penSnapshot ?? {};
  const diffs = diffPenSnapshots(oldSnapshot, newSnapshot);

  if (diffs.length === 0 && Object.keys(oldSnapshot).length > 0) {
    log.info("No visual property changes detected in .pen file, skipping sync");
    return {
      success: true,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: [],
      penSnapshot: newSnapshot,
    };
  }

  log.info(`Detected ${diffs.length} property change(s) in .pen design`);
  for (const d of diffs) {
    log.info(`  ${d.nodeName}.${d.prop}: ${d.oldValue} → ${d.newValue}`);
  }

  // Split diffs: fill changes get fast path, everything else goes to Claude
  const fillDiffs = diffs.filter((d) => d.prop === "fill");
  const otherDiffs = diffs.filter((d) => d.prop !== "fill");

  const allFilesChanged: string[] = [];

  // ── Fast path: apply fill/color changes directly ──
  if (fillDiffs.length > 0) {
    log.info(`Applying ${fillDiffs.length} color change(s) directly (no Claude CLI needed)`);
    const fillResult = await applyFillChanges(mapping, fillDiffs);
    allFilesChanged.push(...fillResult.filesChanged);
    // Log fill errors as warnings (non-blocking)
    for (const err of fillResult.errors) {
      log.warn(`Fill change issue: ${err}`);
    }
  }

  // ── Slow path: delegate non-fill changes to Claude CLI ──
  if (otherDiffs.length > 0) {
    log.info(`Sending ${otherDiffs.length} non-color change(s) to Claude CLI`);

    const beforeHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);
    const prompt = await buildPenToCodePrompt(mapping, undefined, otherDiffs);
    log.debug(`Prompt length: ${prompt.length} chars`);

    const result = await runClaude({
      prompt,
      model: settings.model,
      cwd: mapping.codeDir,
    });

    if (!result.success) {
      log.error(`Claude sync failed for non-color changes: ${result.stderr.slice(0, 200)}`);
      // Color changes already applied, so partial success
      return {
        success: allFilesChanged.length > 0,
        direction: "pen-to-code",
        mappingId: mapping.id,
        filesChanged: allFilesChanged,
        error: `Claude CLI failed for text/typography changes: ${result.stderr.slice(0, 300)}`,
        tokenUsage: result.tokenUsage,
        penSnapshot: newSnapshot,
      };
    }

    const afterHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);
    const claudeFiles = diffHashes(beforeHashes, afterHashes);
    allFilesChanged.push(...claudeFiles);

    log.success(`Pen-to-code sync complete: ${allFilesChanged.length} file(s) updated`);

    return {
      success: true,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: [...new Set(allFilesChanged)],
      tokenUsage: result.tokenUsage,
      penSnapshot: newSnapshot,
    };
  }

  // Only fill changes — no Claude needed
  log.success(`Pen-to-code sync complete (fast path): ${allFilesChanged.length} file(s) updated`);

  return {
    success: true,
    direction: "pen-to-code",
    mappingId: mapping.id,
    filesChanged: [...new Set(allFilesChanged)],
    penSnapshot: newSnapshot,
  };
}
