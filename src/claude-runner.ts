import { spawn } from "node:child_process";
import { log } from "./logger.js";
import type { ClaudeRunResult, TokenUsage } from "./types.js";

export interface ClaudeRunOptions {
  prompt: string;
  model: string;
  maxTokens?: number;
  cwd?: string;
}

// Model pricing per million tokens (input/output USD)
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
  "claude-opus-4-6": { input: 15, output: 75 },
};

export function estimateCost(model: string, tokenUsage: TokenUsage): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4-6"];
  return (tokenUsage.input / 1_000_000) * pricing.input +
         (tokenUsage.output / 1_000_000) * pricing.output;
}

export function estimateInputTokens(prompt: string): number {
  // Rough heuristic: ~4 chars per token
  return Math.ceil(prompt.length / 4);
}

export function parseTokenUsage(stderr: string): TokenUsage | undefined {
  // Claude CLI --verbose outputs token stats in various formats.
  // Common patterns:
  //   "input_tokens": 1234   or   input tokens: 1234
  //   "output_tokens": 5678  or   output tokens: 5678
  const inputMatch = stderr.match(/input[_\s]tokens["\s:]*(\d+)/i);
  const outputMatch = stderr.match(/output[_\s]tokens["\s:]*(\d+)/i);

  if (inputMatch || outputMatch) {
    return {
      input: inputMatch ? parseInt(inputMatch[1], 10) : 0,
      output: outputMatch ? parseInt(outputMatch[1], 10) : 0,
    };
  }
  return undefined;
}

export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const { prompt, model, cwd } = options;

  const args = [
    "-p",
    prompt,
    "--model",
    model,
    "--output-format",
    "text",
    "--verbose",
    "--max-turns",
    "1",
  ];

  log.debug(`Spawning: claude ${args.slice(0, 4).join(" ")}...`);

  return new Promise((resolve) => {
    const proc = spawn("claude", args, {
      cwd: cwd ?? process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000, // 5 min max
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        log.error(`Claude CLI exited with code ${exitCode}`);
        if (stderr) log.debug(`stderr: ${stderr.slice(0, 500)}`);
      }

      const tokenUsage = parseTokenUsage(stderr);
      resolve({ success: exitCode === 0, stdout, stderr, exitCode, tokenUsage });
    });

    proc.on("error", (err) => {
      log.error(`Failed to spawn claude CLI: ${err.message}`);
      resolve({
        success: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}
