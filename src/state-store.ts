import { readFile, writeFile, unlink, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readdir, rename } from "node:fs/promises";
import { join, relative } from "node:path";
import { log } from "./logger.js";
import { extractErrorMessage } from "./utils.js";
import type { SyncState, MappingState, MappingConfig, SyncDirection, PenNodeSnapshot } from "./types.js";

function createEmptyState(): SyncState {
  return { version: 1, mappings: {} };
}

interface PersistedState extends SyncState {
  _checksum?: string;
}

export class StateStore {
  private state: SyncState = createEmptyState();

  constructor(private stateFilePath: string) {}

  async load(): Promise<void> {
    // Clean up orphaned .tmp file from previous crash
    await this.cleanupOrphanedTmp();

    try {
      const raw = await readFile(this.stateFilePath, "utf-8");
      const parsed = JSON.parse(raw) as PersistedState;

      // Validate structure
      if (!this.isValidState(parsed)) {
        log.warn("State file structure invalid, falling back to empty state");
        this.state = createEmptyState();
        return;
      }

      // Verify checksum if present
      if (parsed._checksum) {
        const { _checksum, ...dataOnly } = parsed;
        const computed = this.computeChecksum(dataOnly);
        if (computed !== _checksum) {
          log.warn("State file checksum mismatch (possible corruption or tampering), falling back to empty state");
          this.state = createEmptyState();
          return;
        }
      }

      // Strip checksum before storing in memory
      const { _checksum, ...stateData } = parsed;
      this.state = stateData;
      log.debug(`Loaded state with ${Object.keys(this.state.mappings).length} mappings`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log.debug("No existing state file, starting fresh");
      } else {
        log.warn(`Failed to parse state file (${extractErrorMessage(err)}), falling back to empty state`);
      }
      this.state = createEmptyState();
    }
  }

  // Atomic write: write to .tmp then rename to avoid corrupted state if process is killed mid-write
  async save(): Promise<void> {
    // Create backup before overwriting (if state file exists)
    await this.createBackup();

    const tmp = this.stateFilePath + ".tmp";

    // Add checksum to detect corruption/tampering
    const checksum = this.computeChecksum(this.state);
    const persistedState: PersistedState = { ...this.state, _checksum: checksum };

    await writeFile(tmp, JSON.stringify(persistedState, null, 2));
    await rename(tmp, this.stateFilePath);
    log.debug("State saved");
  }

  getMappingState(mappingId: string): MappingState | undefined {
    return this.state.mappings[mappingId];
  }

  async updateMappingState(
    mapping: MappingConfig,
    direction: SyncDirection,
    penSnapshot?: PenNodeSnapshot,
  ): Promise<void> {
    const penHash = await hashFile(mapping.penFile);
    const codeHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);

    this.state.mappings[mapping.id] = {
      mappingId: mapping.id,
      penHash,
      codeHashes,
      lastSyncTimestamp: Date.now(),
      lastSyncDirection: direction,
      penSnapshot,
    };

    await this.save();
  }

  async initMappingState(mapping: MappingConfig): Promise<void> {
    if (this.state.mappings[mapping.id]) return;
    await this.updateMappingState(mapping, mapping.direction === "both" ? "pen-to-code" : mapping.direction);
  }

  private isValidState(obj: unknown): obj is PersistedState {
    if (typeof obj !== "object" || obj === null) return false;
    const state = obj as Partial<PersistedState>;
    if (typeof state.version !== "number") return false;
    if (typeof state.mappings !== "object" || state.mappings === null) return false;
    return true;
  }

  private computeChecksum(data: SyncState): string {
    // Use deterministic JSON serialization (sorted keys at all levels)
    const serialized = JSON.stringify(data, (key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.keys(value)
          .sort()
          .reduce((sorted: Record<string, unknown>, k) => {
            sorted[k] = value[k];
            return sorted;
          }, {});
      }
      return value;
    });
    return createHash("sha256").update(serialized).digest("hex");
  }

  private async cleanupOrphanedTmp(): Promise<void> {
    const tmpFile = this.stateFilePath + ".tmp";
    try {
      await unlink(tmpFile);
      log.debug("Cleaned up orphaned .tmp file");
    } catch {
      // No orphaned tmp file — OK
    }
  }

  private async createBackup(): Promise<void> {
    try {
      const backupPath = this.stateFilePath + ".backup";
      await copyFile(this.stateFilePath, backupPath);
      log.debug("Created state backup");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log.debug("No existing state to backup");
      } else {
        log.warn(`Failed to create state backup: ${extractErrorMessage(err)}`);
      }
    }
  }

}

export async function hashFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}

export async function hashCodeDir(
  codeDir: string,
  globs: string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const files = await collectFiles(codeDir, globs);

  for (const file of files) {
    const relPath = normalizePathForGlob(relative(codeDir, file));
    hashes[relPath] = await hashFile(file);
  }

  return hashes;
}

async function collectFiles(
  dir: string,
  globs: string[],
): Promise<string[]> {
  const results: string[] = [];

  const patterns = globs.map((g) => globToRegex(g));

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = normalizePathForGlob(relative(dir, fullPath));
        if (patterns.some((p) => p.test(relPath))) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dir);
  return results.sort();
}

export function diffHashes(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const changed: string[] = [];

  for (const [file, hash] of Object.entries(after)) {
    if (before[file] !== hash) {
      changed.push(file);
    }
  }
  for (const file of Object.keys(before)) {
    if (!(file in after)) {
      changed.push(file);
    }
  }

  return changed.sort();
}

function normalizePathForGlob(path: string): string {
  return path.replaceAll("\\", "/");
}

// Convert a file glob pattern (e.g. "**\/*.tsx") to an anchored RegExp.
export function globToRegex(glob: string): RegExp {
  let regex = glob
    .replace(/\?/g, "[^/]")
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "\0DIRGLOB\0")   // park **/ before * handling
    .replace(/\*\*/g, "\0ANYGLOB\0")     // park ** before * handling
    .replace(/\*/g, "[^/]*")             // single * matches non-slash chars
    .replace(/\0DIRGLOB\0/g, "(.+/)?")   // **/ matches zero or more directories
    .replace(/\0ANYGLOB\0/g, ".*");       // ** matches anything
  return new RegExp(`^${regex}$`);
}
