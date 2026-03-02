import { log } from "./logger.js";
import { runClaude } from "./claude-runner.js";
import { buildPenToCodePrompt } from "./prompt-builder.js";
import { hashCodeDir, diffHashes } from "./state-store.js";
import type { MappingConfig, Settings, SyncResult } from "./types.js";

export async function syncPenToCode(
  mapping: MappingConfig,
  settings: Settings,
): Promise<SyncResult> {
  log.sync("pen-to-code", mapping.id, "Starting design → code sync");

  // Snapshot code hashes before Claude runs
  const beforeHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);

  const prompt = await buildPenToCodePrompt(mapping);
  log.debug(`Prompt length: ${prompt.length} chars`);

  const result = await runClaude({
    prompt,
    model: settings.model,
    cwd: mapping.codeDir,
  });

  if (!result.success) {
    log.error(`Pen-to-code sync failed for ${mapping.id}: ${result.stderr.slice(0, 200)}`);
    return {
      success: false,
      direction: "pen-to-code",
      mappingId: mapping.id,
      filesChanged: [],
      error: result.stderr.slice(0, 500),
      tokenUsage: result.tokenUsage,
    };
  }

  // Snapshot code hashes after Claude runs and diff
  const afterHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);
  const filesChanged = diffHashes(beforeHashes, afterHashes);

  log.success(
    `Pen-to-code sync complete for ${mapping.id}: ${filesChanged.length} files updated`,
  );

  return {
    success: true,
    direction: "pen-to-code",
    mappingId: mapping.id,
    filesChanged,
    tokenUsage: result.tokenUsage,
  };
}
