import { resolve, relative, isAbsolute, sep } from "node:path";
import type { MappingConfig } from "./types.js";

export function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the first .css file in a mapping's styleFiles list.
 */
export function getCssStyleFile(mapping: MappingConfig): string | undefined {
  return (mapping.styleFiles ?? []).find((f) => f.endsWith(".css"));
}

/**
 * Validate that a resolved file path stays within the base directory.
 * Prevents path traversal attacks (e.g. "../../etc/passwd").
 * Returns the resolved absolute path, or throws if traversal detected.
 */
export function validatePathWithin(basePath: string, filePath: string): string {
  const resolvedBase = resolve(basePath);
  const resolvedFull = resolve(basePath, filePath);
  const rel = relative(resolvedBase, resolvedFull);

  // ".."+sep or exact ".." catches parent traversal; isAbsolute catches cross-drive escapes on Windows
  // Plain startsWith("..") is too broad — it rejects valid names like "..theme/"
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: "${filePath}" resolves outside of "${basePath}"`);
  }

  return resolvedFull;
}
