import { resolve, relative } from "node:path";
import type { MappingConfig } from "./types.js";

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

  if (rel.startsWith("..")) {
    throw new Error(`Path traversal detected: "${filePath}" resolves outside of "${basePath}"`);
  }

  return resolvedFull;
}
