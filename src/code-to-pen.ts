import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { log } from "./logger.js";
import { runClaude } from "./claude-runner.js";
import { buildCodeToPenPrompt } from "./prompt-builder.js";
import { hashFile } from "./state-store.js";
import type { PenReader } from "./pen-reader.js";
import { JsonPenReader } from "./pen-reader.js";
import type { MappingConfig, Settings, SyncResult } from "./types.js";

const defaultPenReader = new JsonPenReader();

export async function syncCodeToPen(
  mapping: MappingConfig,
  settings: Settings,
  changedFiles: string[],
  penReader: PenReader = defaultPenReader,
  dryRun = false,
): Promise<SyncResult> {
  log.sync("code-to-pen", mapping.id, `Starting code → design sync (${changedFiles.length} files changed)`);

  if (changedFiles.length === 0) {
    log.info("No changed code files to sync");
    return {
      success: true,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
    };
  }

  if (dryRun) {
    log.info(`[dry-run] Would sync ${changedFiles.length} code file(s) → .pen design`);
    log.info(`[dry-run] Would change: ${mapping.penFile}`);
    return {
      success: true,
      dryRun: true,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [mapping.penFile],
    };
  }

  const beforeHash = await hashFile(mapping.penFile);

  const prompt = await buildCodeToPenPrompt(mapping, changedFiles);
  log.debug(`Prompt length: ${prompt.length} chars`);

  const result = await runClaude({
    prompt,
    model: settings.model,
    cwd: mapping.codeDir,
    ...(settings.mcpConfigPath && {
      allowedTools: "Edit,Write,Read,Glob,Grep,mcp__pencil__batch_get,mcp__pencil__batch_design,mcp__pencil__set_variables,mcp__pencil__get_screenshot",
      mcpConfigPath: settings.mcpConfigPath,
    }),
  });

  if (!result.success) {
    const errorPrefix = result.mcpError
      ? `Code-to-pen sync failed (MCP error: ${result.mcpError}) for ${mapping.id}`
      : `Code-to-pen sync failed for ${mapping.id}`;
    log.error(`${errorPrefix}: ${result.stderr.slice(0, 200)}`);
    return {
      success: false,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
      error: result.stderr.slice(0, 500),
      tokenUsage: result.tokenUsage,
    };
  }

  let penChanged = false;
  let penSnapshot;
  try {
    const penRaw = await readFile(mapping.penFile, "utf-8");
    const afterHash = createHash("sha256").update(penRaw).digest("hex");
    penChanged = beforeHash !== afterHash;
    const snapshot = await penReader.readSnapshot(mapping.penFile);
    if (snapshot === null) {
      log.error("Pen file could not be parsed after sync");
      return {
        success: false,
        direction: "code-to-pen",
        mappingId: mapping.id,
        filesChanged: penChanged ? [mapping.penFile] : [],
        error: "Pen file contains invalid JSON after code-to-pen sync",
        tokenUsage: result.tokenUsage,
      };
    } else {
      penSnapshot = snapshot;
    }
  } catch (err) {
    const error = `Failed to read .pen file after code-to-pen sync: ${err}`;
    log.error(error);
    return {
      success: false,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
      error,
      tokenUsage: result.tokenUsage,
    };
  }

  log.success(`Code-to-pen sync complete for ${mapping.id}`);

  return {
    success: true,
    direction: "code-to-pen",
    mappingId: mapping.id,
    filesChanged: penChanged ? [mapping.penFile] : [],
    tokenUsage: result.tokenUsage,
    penSnapshot,
  };
}
