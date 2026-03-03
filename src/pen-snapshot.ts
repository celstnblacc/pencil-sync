import { log } from "./logger.js";
import type { PenNodeSnapshot, PenDiffEntry } from "./types.js";

interface PenNode {
  id?: string;
  name?: string;
  type?: string;
  fill?: string;
  content?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  cornerRadius?: number;
  children?: PenNode[];
  [key: string]: unknown;
}

const TRACKED_PROPS = ["fill", "content", "fontSize", "fontWeight", "fontFamily", "cornerRadius"] as const;

function flattenPenNodes(node: PenNode, snapshot: PenNodeSnapshot): void {
  if (node.id) {
    const props: Record<string, string | number> = {};
    if (node.name) props.name = node.name;
    if (node.type) props.type = node.type;
    for (const prop of TRACKED_PROPS) {
      if (node[prop] !== undefined && node[prop] !== null) {
        props[prop] = node[prop] as string | number;
      }
    }
    // Require at least name/type + one visual property to be worth tracking
    if (Object.keys(props).length > 1) {
      snapshot[node.id] = props;
    }
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      flattenPenNodes(child, snapshot);
    }
  }
}

/**
 * Returns a snapshot of tracked visual properties, or null if the file couldn't be parsed.
 * An empty object {} means "valid file, no tracked nodes" — distinct from null (corruption).
 */
export function snapshotPenFile(penFile: string, raw: string): PenNodeSnapshot | null {
  try {
    const pen = JSON.parse(raw);
    const snapshot: PenNodeSnapshot = {};
    for (const child of (pen.children ?? [])) {
      flattenPenNodes(child, snapshot);
    }
    return snapshot;
  } catch (err) {
    log.error(`Failed to parse .pen file: ${err}`);
    return null;
  }
}

export function diffPenSnapshots(
  oldSnap: PenNodeSnapshot,
  newSnap: PenNodeSnapshot,
): PenDiffEntry[] {
  const diffs: PenDiffEntry[] = [];

  for (const [nodeId, newProps] of Object.entries(newSnap)) {
    const oldProps = oldSnap[nodeId];
    if (!oldProps) continue; // new node — skip for now

    for (const prop of TRACKED_PROPS) {
      const oldVal = oldProps[prop];
      const newVal = newProps[prop];
      if (oldVal !== undefined && newVal !== undefined && String(oldVal) !== String(newVal)) {
        diffs.push({
          nodeId,
          nodeName: String(newProps.name ?? nodeId),
          prop,
          oldValue: oldVal,
          newValue: newVal,
        });
      }
    }
  }

  return diffs;
}

export function formatDiffForPrompt(diffs: PenDiffEntry[]): string {
  if (diffs.length === 0) return "";

  const lines = diffs.map(d =>
    `- **${d.nodeName}** (${d.nodeId}): \`${d.prop}\` changed from \`${d.oldValue}\` → \`${d.newValue}\``
  );

  return `\n## Design Changes Detected\n\n${lines.join("\n")}\n`;
}

