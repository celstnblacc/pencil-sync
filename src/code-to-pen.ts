import { readFile } from "node:fs/promises";
import { log } from "./logger.js";
import { runClaude } from "./claude-runner.js";
import { buildCodeToPenPrompt } from "./prompt-builder.js";
import { snapshotPenFile } from "./pen-snapshot.js";
import { hashFile } from "./state-store.js";
import type { MappingConfig, Settings, SyncResult } from "./types.js";

export async function syncCodeToPen(
  mapping: MappingConfig,
  settings: Settings,
  changedFiles: string[],
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

  // Snapshot .pen file hash before Claude runs
  const beforeHash = await hashFile(mapping.penFile);

  const prompt = await buildCodeToPenPrompt(mapping, changedFiles);
  log.debug(`Prompt length: ${prompt.length} chars`);

  const result = await runClaude({
    prompt,
    model: settings.model,
    cwd: mapping.codeDir,
  });

  if (!result.success) {
    log.error(`Code-to-pen sync failed for ${mapping.id}: ${result.stderr.slice(0, 200)}`);
    return {
      success: false,
      direction: "code-to-pen",
      mappingId: mapping.id,
      filesChanged: [],
      error: result.stderr.slice(0, 500),
      tokenUsage: result.tokenUsage,
    };
  }

  // Snapshot .pen file hash after Claude runs and diff
  const afterHash = await hashFile(mapping.penFile);
  const penChanged = beforeHash !== afterHash;

  // Read and snapshot the .pen file after sync for state persistence
  let penSnapshot;
  try {
    const penRaw = await readFile(mapping.penFile, "utf-8");
    penSnapshot = snapshotPenFile(mapping.penFile, penRaw);
  } catch (err) {
    log.warn(`Could not snapshot .pen file after code-to-pen sync: ${err}`);
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
