import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  parseTokenUsage,
  estimateCost,
  estimateInputTokens,
  MODEL_PRICING,
  runClaude,
} from "../claude-runner.js";

// Mock child_process at module level so runClaude gets the mocked spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Import the mocked spawn to control its behavior per-test
import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

describe("parseTokenUsage", () => {
  it("parses input_tokens and output_tokens from JSON-style stderr", () => {
    const stderr = `{"input_tokens": 1500, "output_tokens": 300}`;
    const usage = parseTokenUsage(stderr);
    expect(usage).toEqual({ input: 1500, output: 300 });
  });

  it("parses space-separated format", () => {
    const stderr = `input tokens: 2000\noutput tokens: 500`;
    const usage = parseTokenUsage(stderr);
    expect(usage).toEqual({ input: 2000, output: 500 });
  });

  it("returns undefined for no token info", () => {
    expect(parseTokenUsage("some random error")).toBeUndefined();
  });

  it("handles partial — only input", () => {
    const stderr = `input_tokens: 1000`;
    const usage = parseTokenUsage(stderr);
    expect(usage).toEqual({ input: 1000, output: 0 });
  });

  it("handles partial — only output", () => {
    const stderr = `output_tokens: 500`;
    const usage = parseTokenUsage(stderr);
    expect(usage).toEqual({ input: 0, output: 500 });
  });
});

describe("estimateCost", () => {
  it("estimates cost for sonnet", () => {
    const cost = estimateCost("claude-sonnet-4-6", { input: 1_000_000, output: 1_000_000 });
    expect(cost).toBe(18);
  });

  it("estimates cost for haiku", () => {
    const cost = estimateCost("claude-haiku-4-5-20251001", { input: 1_000_000, output: 1_000_000 });
    expect(cost).toBe(1.50);
  });

  it("estimates cost for opus", () => {
    const cost = estimateCost("claude-opus-4-6", { input: 1_000_000, output: 1_000_000 });
    expect(cost).toBe(90);
  });

  it("falls back to sonnet pricing for unknown model", () => {
    const cost = estimateCost("unknown-model", { input: 1_000_000, output: 1_000_000 });
    expect(cost).toBe(18);
  });

  it("handles zero tokens", () => {
    expect(estimateCost("claude-sonnet-4-6", { input: 0, output: 0 })).toBe(0);
  });
});

describe("estimateInputTokens", () => {
  it("estimates ~4 chars per token", () => {
    const tokens = estimateInputTokens("a".repeat(400));
    expect(tokens).toBe(100);
  });

  it("rounds up", () => {
    const tokens = estimateInputTokens("abc");
    expect(tokens).toBe(1);
  });
});

describe("MODEL_PRICING", () => {
  it("has pricing for sonnet, haiku, and opus", () => {
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-haiku-4-5-20251001"]).toBeDefined();
    expect(MODEL_PRICING["claude-opus-4-6"]).toBeDefined();
  });
});

describe("runClaude", () => {
  type Listener = (...args: unknown[]) => void;
  let listeners: Map<string, Listener>;

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = new Map();

    const mockProc = {
      stdout: {
        on: vi.fn((event: string, cb: Listener) => {
          listeners.set(`stdout:${event}`, cb);
        }),
      },
      stderr: {
        on: vi.fn((event: string, cb: Listener) => {
          listeners.set(`stderr:${event}`, cb);
        }),
      },
      on: vi.fn((event: string, cb: Listener) => {
        listeners.set(event, cb);
      }),
      kill: vi.fn(),
    };

    mockSpawn.mockReturnValue(mockProc as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockSpawn.mockReset();
  });

  it("resolves with success on exit code 0", async () => {
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6" });

    listeners.get("stdout:data")!(Buffer.from("output text"));
    listeners.get("stderr:data")!(Buffer.from('{"input_tokens": 100, "output_tokens": 50}'));
    listeners.get("close")!(0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("output text");
    expect(result.exitCode).toBe(0);
    expect(result.tokenUsage).toEqual({ input: 100, output: 50 });
  });

  it("resolves with failure on non-zero exit code", async () => {
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6" });

    listeners.get("stderr:data")!(Buffer.from("API error"));
    listeners.get("close")!(1);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("API error");
  });

  it("handles spawn error (binary not found)", async () => {
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6" });

    listeners.get("error")!(new Error("spawn claude ENOENT"));

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.stderr).toBe("spawn claude ENOENT");
    expect(result.exitCode).toBe(1);
  });

  it("does not double-resolve when close fires after error", async () => {
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6" });

    listeners.get("error")!(new Error("spawn failed"));
    listeners.get("close")!(1);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.stderr).toBe("spawn failed");
  });

  it("strips CLAUDECODE and CLAUDE_CODE_SESSION from env", async () => {
    process.env.CLAUDECODE = "should-be-stripped";
    process.env.CLAUDE_CODE_SESSION = "should-be-stripped";

    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6" });
    listeners.get("close")!(0);
    await promise;

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall[2]!.env as Record<string, string | undefined>;
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION).toBeUndefined();

    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_SESSION;
  });

  it("passes cwd option to spawn", async () => {
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6", cwd: "/custom/dir" });
    listeners.get("close")!(0);
    await promise;

    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[2]!.cwd).toBe("/custom/dir");
  });

  it("includes required CLI flags", async () => {
    const promise = runClaude({ prompt: "test prompt", model: "claude-haiku-4-5-20251001" });
    listeners.get("close")!(0);
    await promise;

    const args: string[] = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--verbose");
    expect(args).toContain("--max-turns");
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
    expect(args[args.indexOf("-p") + 1]).toBe("test prompt");
  });

  it("accumulates chunked stdout and stderr", async () => {
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6" });

    listeners.get("stdout:data")!(Buffer.from("chunk1"));
    listeners.get("stdout:data")!(Buffer.from("chunk2"));
    listeners.get("stderr:data")!(Buffer.from("err1"));
    listeners.get("stderr:data")!(Buffer.from("err2"));
    listeners.get("close")!(0);

    const result = await promise;
    expect(result.stdout).toBe("chunk1chunk2");
    expect(result.stderr).toBe("err1err2");
  });

  it("defaults exit code to 1 when close provides null", async () => {
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6" });

    listeners.get("close")!(null);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
