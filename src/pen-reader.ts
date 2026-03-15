import { readFile } from "node:fs/promises";
import { snapshotPenFile } from "./pen-snapshot.js";
import type { PenNodeSnapshot } from "./types.js";

export interface PenReader {
  readSnapshot(penFile: string): Promise<PenNodeSnapshot | null>;
}

export class JsonPenReader implements PenReader {
  async readSnapshot(penFile: string): Promise<PenNodeSnapshot | null> {
    const raw = await readFile(penFile, "utf-8");
    return snapshotPenFile(penFile, raw);
  }
}
