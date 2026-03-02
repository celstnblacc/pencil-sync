import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { log } from "./logger.js";
import type { SyncState, MappingState, MappingConfig, SyncDirection } from "./types.js";

const EMPTY_STATE: SyncState = { version: 1, mappings: {} };

export class StateStore {
  private state: SyncState = { ...EMPTY_STATE };

  constructor(private stateFilePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.stateFilePath, "utf-8");
      this.state = JSON.parse(raw) as SyncState;
      log.debug(`Loaded state with ${Object.keys(this.state.mappings).length} mappings`);
    } catch {
      this.state = { ...EMPTY_STATE };
      log.debug("No existing state file, starting fresh");
    }
  }

  async save(): Promise<void> {
    await writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2));
    log.debug("State saved");
  }

  getMappingState(mappingId: string): MappingState | undefined {
    return this.state.mappings[mappingId];
  }

  async updateMappingState(
    mapping: MappingConfig,
    direction: SyncDirection,
  ): Promise<void> {
    const penHash = await hashFile(mapping.penFile);
    const codeHashes = await hashCodeDir(mapping.codeDir, mapping.codeGlobs);

    this.state.mappings[mapping.id] = {
      mappingId: mapping.id,
      penHash,
      codeHashes,
      lastSyncTimestamp: Date.now(),
      lastSyncDirection: direction,
    };

    await this.save();
  }

  async initMappingState(mapping: MappingConfig): Promise<void> {
    if (this.state.mappings[mapping.id]) return;
    await this.updateMappingState(mapping, mapping.direction === "both" ? "pen-to-code" : mapping.direction);
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
    const relPath = relative(codeDir, file);
    hashes[relPath] = await hashFile(file);
  }

  return hashes;
}

async function collectFiles(
  dir: string,
  globs: string[],
): Promise<string[]> {
  const results: string[] = [];

  // Convert globs to simple regex patterns for matching
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
        const relPath = relative(dir, fullPath);
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

  // New or modified files
  for (const [file, hash] of Object.entries(after)) {
    if (before[file] !== hash) {
      changed.push(file);
    }
  }
  // Deleted files
  for (const file of Object.keys(before)) {
    if (!(file in after)) {
      changed.push(file);
    }
  }

  return changed.sort();
}

export function globToRegex(glob: string): RegExp {
  let regex = glob
    .replace(/\?/g, "[^/]")          // ? matches single non-slash char (before ** handling)
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "(.+/)?")    // **/ matches zero or more directories
    .replace(/\*\*/g, ".*")          // ** at end matches anything
    .replace(/\*/g, "[^/]*");        // * matches non-slash chars
  return new RegExp(`^${regex}$`);
}
