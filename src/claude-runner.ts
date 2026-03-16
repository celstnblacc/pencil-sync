import { spawn } from "node:child_process";
import { log } from "./logger.js";
import type { ClaudeRunResult, TokenUsage, McpErrorType } from "./types.js";

export interface ClaudeRunOptions {
  prompt: string;
  model: string;
  maxTokens?: number;
  cwd?: string;
  allowedTools?: string;
  mcpConfigPath?: string;
  maxRetries?: number;
  retryDelayMs?: number;
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

export function detectMcpError(stderr: string): McpErrorType | undefined {
  // Detect MCP-specific error patterns in stderr
  if (stderr.includes("malformed JSON") || stderr.includes("returned malformed")) {
    return "malformed_response";
  }
  if (stderr.includes("Failed to connect") || stderr.includes("ECONNREFUSED")) {
    return "server_unavailable";
  }
  if (stderr.includes("timed out")) {
    return "tool_timeout";
  }
  if (stderr.includes("exited unexpectedly")) {
    return "server_crash";
  }
  return undefined;
}

export function isTransientMcpError(mcpError: McpErrorType | undefined): boolean {
  // Transient errors that should be retried:
  // - server_unavailable: Server might come back up
  // - tool_timeout: Might succeed on retry
  // - server_crash: Server might restart and work
  // Non-transient errors:
  // - malformed_response: Indicates a bug, won't fix itself
  return mcpError === "server_unavailable" || mcpError === "tool_timeout" || mcpError === "server_crash";
}

const CLAUDE_TIMEOUT_MS = 300_000; // 5 min max
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

async function runOnce(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
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
        finish(1, true); // Pass timeout flag
        proc.kill("SIGTERM");
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* noop */ }
        }, 5000);
      }
    }, CLAUDE_TIMEOUT_MS);

    const finish = (exitCode: number, timeoutError = false) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);

      // Handle timeout error with explicit stderr message
      const finalStderr = timeoutError ? `Claude CLI timed out after ${CLAUDE_TIMEOUT_MS / 1000}s` : stderr;

      if (exitCode !== 0) {
        log.error(`Claude CLI exited with code ${exitCode}`);
        if (finalStderr) log.debug(`stderr: ${finalStderr.slice(0, 500)}`);
      }

      const tokenUsage = parseTokenUsage(finalStderr);
      const mcpError = detectMcpError(finalStderr);
      resolve({ success: exitCode === 0, stdout, stderr: finalStderr, exitCode, tokenUsage, mcpError });
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

export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // Only retry if MCP is enabled
  const shouldRetry = !!options.mcpConfigPath && maxRetries > 0;

  if (!shouldRetry) {
    return runOnce(options);
  }

  let lastResult: ClaudeRunResult | undefined;
  const totalAttempts = maxRetries + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) {
      const delay = retryDelayMs * Math.pow(2, attempt - 1);
      log.debug(`Retrying Claude CLI (attempt ${attempt + 1}/${totalAttempts}) after ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const result = await runOnce(options);

    if (result.success) {
      return result;
    }

    lastResult = result;

    // Check if error is transient and worth retrying
    const isLastAttempt = attempt === totalAttempts - 1;
    if (!isLastAttempt && isTransientMcpError(result.mcpError)) {
      log.debug(`Transient MCP error detected (${result.mcpError}), will retry...`);
      continue;
    }

    // Non-transient error or last attempt reached
    return result;
  }

  return lastResult!;
}
