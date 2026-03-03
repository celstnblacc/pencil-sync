export type SyncDirection = "both" | "pen-to-code" | "code-to-pen";
export type ConflictStrategy = "prompt" | "pen-wins" | "code-wins" | "auto-merge";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type Framework = "nextjs" | "react" | "vue" | "svelte" | "astro" | "unknown";
export type Styling = "tailwind" | "css-modules" | "styled-components" | "css" | "unknown";

export interface MappingConfig {
  id: string;
  penFile: string;
  codeDir: string;
  codeGlobs: string[];
  penScreens?: string[];
  framework?: Framework;
  styling?: Styling;
  direction: SyncDirection;
  /** Files containing design tokens (CSS variables, Tailwind config) — inlined into prompts */
  styleFiles?: string[];
}

export interface Settings {
  debounceMs: number;
  model: string;
  maxBudgetUsd: number;
  conflictStrategy: ConflictStrategy;
  stateFile: string;
  logLevel: LogLevel;
}

export interface PencilSyncConfig {
  version: number;
  mappings: MappingConfig[];
  settings: Settings;
}

export interface PenNodeSnapshot {
  [nodeId: string]: Record<string, string | number>;
}

export interface MappingState {
  mappingId: string;
  penHash: string;
  codeHashes: Record<string, string>;
  lastSyncTimestamp: number;
  lastSyncDirection: SyncDirection;
  penSnapshot?: PenNodeSnapshot;
}

export interface SyncState {
  version: number;
  mappings: Record<string, MappingState>;
}

export interface SyncResult {
  success: boolean;
  direction: SyncDirection;
  mappingId: string;
  filesChanged: string[];
  error?: string;
  tokenUsage?: TokenUsage;
  penSnapshot?: PenNodeSnapshot;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ClaudeRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  tokenUsage?: TokenUsage;
}

export interface ConflictInfo {
  mappingId: string;
  penChanged: boolean;
  codeChanged: boolean;
  changedCodeFiles: string[];
}

export interface PenDiffEntry {
  nodeId: string;
  nodeName: string;
  prop: string;
  oldValue: string | number;
  newValue: string | number;
}

export interface FillChangeResult {
  filesChanged: string[];
  errors: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  debounceMs: 2000,
  model: "claude-sonnet-4-6",
  maxBudgetUsd: 0.5,
  conflictStrategy: "prompt",
  stateFile: ".pencil-sync-state.json",
  logLevel: "info",
};
