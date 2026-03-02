import { log } from "./logger.js";
import { hashFile, hashCodeDir } from "./state-store.js";
import type { MappingConfig, MappingState, ConflictInfo } from "./types.js";

export async function detectConflict(
  mapping: MappingConfig,
  previousState: MappingState | undefined,
): Promise<ConflictInfo> {
  if (!previousState) {
    // No previous state = first sync, no conflict
    return {
      mappingId: mapping.id,
      penChanged: false,
      codeChanged: false,
      changedCodeFiles: [],
    };
  }

  const currentPenHash = await hashFile(mapping.penFile);
  const currentCodeHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);

  const penChanged = currentPenHash !== previousState.penHash;

  const changedCodeFiles: string[] = [];
  // Check for changed or new files
  for (const [file, hash] of Object.entries(currentCodeHashes)) {
    if (previousState.codeHashes[file] !== hash) {
      changedCodeFiles.push(file);
    }
  }
  // Check for deleted files
  for (const file of Object.keys(previousState.codeHashes)) {
    if (!(file in currentCodeHashes)) {
      changedCodeFiles.push(file);
    }
  }

  const codeChanged = changedCodeFiles.length > 0;

  if (penChanged && codeChanged) {
    log.warn(
      `Conflict detected for ${mapping.id}: both .pen and ${changedCodeFiles.length} code files changed`,
    );
  }

  return {
    mappingId: mapping.id,
    penChanged,
    codeChanged,
    changedCodeFiles,
  };
}

export function isConflict(info: ConflictInfo): boolean {
  return info.penChanged && info.codeChanged;
}
