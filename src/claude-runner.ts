import { spawn } from "node:child_process";
import { log } from "./logger.js";
import type { ClaudeRunResult, TokenUsage } from "./types.js";

export interface ClaudeRunOptions {
  prompt: string;
  model: string;
  maxTokens?: number;
  cwd?: string;
  allowedTools?: string;
  mcpConfigPath?: string;
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

const CLAUDE_TIMEOUT_MS = 300_000; // 5 min max

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
    "3",
    "--allowedTools",
    options.allowedTools ?? "Edit,Write,Read,Glob,Grep",
  ];

  if (options.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  log.debug(`Spawning: claude ${args.slice(0, 4).join(" ")}...`);

  // Strip env vars that prevent nested Claude CLI sessions
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_SESSION;

  return new Promise((resolve) => {
    let resolved = false;

    const proc = spawn("claude", args, {
      cwd: cwd ?? process.cwd(),
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB safety cap

    // Hard timeout: kill process if it hangs
    const timeoutTimer = setTimeout(() => {
      if (!resolved) {
        log.error(`Claude CLI timed out after ${CLAUDE_TIMEOUT_MS / 1000}s, killing process`);
        finish(1);
        proc.kill("SIGTERM");
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* noop */ }
        }, 5000);
      }
    }, CLAUDE_TIMEOUT_MS);

    const finish = (exitCode: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);

      if (exitCode !== 0) {
        log.error(`Claude CLI exited with code ${exitCode}`);
        if (stderr) log.debug(`stderr: ${stderr.slice(0, 500)}`);
      }

      const tokenUsage = parseTokenUsage(stderr);
      resolve({ success: exitCode === 0, stdout, stderr, exitCode, tokenUsage });
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      finish(code ?? 1);
    });

    proc.on("error", (err) => {
      log.error(`Failed to spawn claude CLI: ${err.message}`);
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      resolve({
        success: false,
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}
