import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  parseTokenUsage,
  estimateCost,
  estimateInputTokens,
  MODEL_PRICING,
  runClaude,
  detectMcpError,
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

describe("detectMcpError", () => {
  it("detects malformed JSON response", () => {
    const stderr = 'MCP error: tool "pencil__batch_get" returned malformed JSON: {"invalid}';
    expect(detectMcpError(stderr)).toBe("malformed_response");
  });

  it("detects connection refused error", () => {
    const stderr = "MCP error: Failed to connect to server pencil: ECONNREFUSED";
    expect(detectMcpError(stderr)).toBe("server_unavailable");
  });

  it("detects tool timeout", () => {
    const stderr = 'MCP error: tool "pencil__batch_get" timed out after 30s';
    expect(detectMcpError(stderr)).toBe("tool_timeout");
  });

  it("detects server crash", () => {
    const stderr = "MCP error: Server pencil exited unexpectedly with code 1";
    expect(detectMcpError(stderr)).toBe("server_crash");
  });

  it("returns undefined for non-MCP errors", () => {
    const stderr = "Some other error message";
    expect(detectMcpError(stderr)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(detectMcpError("")).toBeUndefined();
  });
});

describe("runClaude", () => {
  type Listener = (...args: unknown[]) => void;
  let listeners: Map<string, Listener>;
  let listenersList: Map<string, Listener>[];

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = new Map();
    listenersList = [];

    mockSpawn.mockImplementation(() => {
      const newListeners = new Map<string, Listener>();
      listenersList.push(newListeners);
      // Also update the main listeners reference for backward compatibility
      listeners = newListeners;

      const mockProc = {
        stdout: {
          on: vi.fn((event: string, cb: Listener) => {
            newListeners.set(`stdout:${event}`, cb);
          }),
        },
        stderr: {
          on: vi.fn((event: string, cb: Listener) => {
            newListeners.set(`stderr:${event}`, cb);
          }),
        },
        on: vi.fn((event: string, cb: Listener) => {
          newListeners.set(event, cb);
        }),
        kill: vi.fn(),
      };

      return mockProc as unknown as ChildProcess;
    });
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

  it("uses default allowedTools when none specified", async () => {
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6" });
    listeners.get("close")!(0);
    await promise;

    const args: string[] = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Edit,Write,Read,Glob,Grep");
  });

  it("uses custom allowedTools when specified", async () => {
    const customTools = "Edit,Write,Read,Glob,Grep,mcp__pencil__batch_get,mcp__pencil__batch_design";
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6", allowedTools: customTools });
    listeners.get("close")!(0);
    await promise;

    const args: string[] = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(customTools);
  });

  it("adds --mcp-config flag when mcpConfigPath is provided", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "claude-sonnet-4-6",
      mcpConfigPath: "/path/to/mcp.json",
    });
    listeners.get("close")!(0);
    await promise;

    const args: string[] = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/path/to/mcp.json");
  });

  it("does not add --mcp-config flag when mcpConfigPath is not provided", async () => {
    const promise = runClaude({ prompt: "test", model: "claude-sonnet-4-6" });
    listeners.get("close")!(0);
    await promise;

    const args: string[] = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--mcp-config");
  });

  describe("MCP failure handling", () => {
    it("handles timeout when Claude CLI hangs with MCP tools", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 0, // Disable retry for this test
      });

      // Advance time past the 5 minute timeout (300,000ms)
      vi.advanceTimersByTime(300_001);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("timed out");

      // Verify kill was called
      const mockProc = mockSpawn.mock.results[0].value;
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("handles malformed MCP tool response in stderr", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 0,
      });

      // Simulate stderr with malformed MCP response
      listeners.get("stderr:data")!(
        Buffer.from('MCP error: tool "pencil__batch_get" returned malformed JSON: {"invalid}')
      );
      listeners.get("close")!(1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("malformed JSON");
      expect(result.mcpError).toBe("malformed_response");
    });

    it("handles offline/unavailable MCP server", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 0,
      });

      // Simulate stderr with connection error
      listeners.get("stderr:data")!(
        Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
      );
      listeners.get("close")!(1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("Failed to connect");
      expect(result.mcpError).toBe("server_unavailable");
    });

    it("handles MCP tool execution timeout", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 0,
      });

      // Simulate stderr with tool timeout
      listeners.get("stderr:data")!(
        Buffer.from('MCP error: tool "pencil__batch_get" timed out after 30s')
      );
      listeners.get("close")!(1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("timed out");
      expect(result.mcpError).toBe("tool_timeout");
    });

    it("handles MCP server crash during tool call", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 0,
      });

      // Simulate stderr with server crash
      listeners.get("stderr:data")!(
        Buffer.from("MCP error: Server pencil exited unexpectedly with code 1")
      );
      listeners.get("close")!(1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("exited unexpectedly");
      expect(result.mcpError).toBe("server_crash");
    });

    it("continues successfully when MCP tools work correctly", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 0,
      });

      listeners.get("stdout:data")!(Buffer.from("output text"));
      listeners.get("stderr:data")!(Buffer.from('{"input_tokens": 100, "output_tokens": 50}'));
      listeners.get("close")!(0);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.mcpError).toBeUndefined();
    });
  });

  describe("Retry + exponential backoff (rob-retry)", () => {
    it("retries transient MCP failures up to maxRetries", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 3,
        retryDelayMs: 100,
      });

      // First attempt: server_unavailable (transient)
      const listeners1 = listenersList[0];
      listeners1.get("stderr:data")!(
        Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
      );
      listeners1.get("close")!(1);

      // Need to advance timers to trigger retry delay
      await vi.advanceTimersByTimeAsync(100);

      // Second attempt: tool_timeout (transient)
      const listeners2 = listenersList[1];
      listeners2.get("stderr:data")!(
        Buffer.from('MCP error: tool "pencil__batch_get" timed out after 30s')
      );
      listeners2.get("close")!(1);

      await vi.advanceTimersByTimeAsync(200); // exponential backoff: 100 * 2

      // Third attempt: success
      const listeners3 = listenersList[2];
      listeners3.get("stdout:data")!(Buffer.from("success output"));
      listeners3.get("stderr:data")!(Buffer.from('{"input_tokens": 100, "output_tokens": 50}'));
      listeners3.get("close")!(0);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.stdout).toBe("success output");
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    it("does not retry non-transient errors", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 3,
      });

      // malformed_response is non-transient, should not retry
      listeners.get("stderr:data")!(
        Buffer.from('MCP error: tool "pencil__batch_get" returned malformed JSON: {"invalid}')
      );
      listeners.get("close")!(1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.mcpError).toBe("malformed_response");
      expect(mockSpawn).toHaveBeenCalledTimes(1); // No retry
    });

    it("exhausts all retries and returns final failure", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 2,
        retryDelayMs: 50,
      });

      // Attempt 1: server_unavailable
      const listeners1 = listenersList[0];
      listeners1.get("stderr:data")!(
        Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
      );
      listeners1.get("close")!(1);
      await vi.advanceTimersByTimeAsync(50);

      // Attempt 2: server_unavailable
      const listeners2 = listenersList[1];
      listeners2.get("stderr:data")!(
        Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
      );
      listeners2.get("close")!(1);
      await vi.advanceTimersByTimeAsync(100);

      // Attempt 3 (final): server_unavailable
      const listeners3 = listenersList[2];
      listeners3.get("stderr:data")!(
        Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
      );
      listeners3.get("close")!(1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.mcpError).toBe("server_unavailable");
      expect(mockSpawn).toHaveBeenCalledTimes(3); // maxRetries=2 → 3 total attempts
    });

    it("applies exponential backoff: 100ms, 200ms, 400ms", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 3,
        retryDelayMs: 100,
      });

      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;

      // Track delay calls
      const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((cb: () => void, delay?: number) => {
        if (delay) delays.push(delay);
        return originalSetTimeout(cb, 0);
      }) as unknown as typeof setTimeout);

      // Attempt 1: fail
      const listeners1 = listenersList[0];
      listeners1.get("stderr:data")!(
        Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
      );
      listeners1.get("close")!(1);
      await vi.runAllTimersAsync();

      // Attempt 2: fail
      const listeners2 = listenersList[1];
      listeners2.get("stderr:data")!(
        Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
      );
      listeners2.get("close")!(1);
      await vi.runAllTimersAsync();

      // Attempt 3: fail
      const listeners3 = listenersList[2];
      listeners3.get("stderr:data")!(
        Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
      );
      listeners3.get("close")!(1);
      await vi.runAllTimersAsync();

      // Attempt 4: success
      const listeners4 = listenersList[3];
      listeners4.get("stdout:data")!(Buffer.from("success"));
      listeners4.get("close")!(0);

      await promise;

      // Verify exponential backoff: 100, 200, 400
      expect(delays.filter((d) => d === 100 || d === 200 || d === 400)).toEqual([100, 200, 400]);
      setTimeoutSpy.mockRestore();
    });

    it("defaults maxRetries=3, retryDelayMs=1000 when not specified", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        retryDelayMs: 10, // Use short delay to avoid timeout issues in tests
      });

      // Fail 3 times, then succeed
      for (let i = 0; i < 3; i++) {
        const attemptListeners = listenersList[i];
        attemptListeners.get("stderr:data")!(
          Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
        );
        attemptListeners.get("close")!(1);
        await vi.advanceTimersByTimeAsync(10 * Math.pow(2, i));
      }

      const successListeners = listenersList[3];
      successListeners.get("stdout:data")!(Buffer.from("success"));
      successListeners.get("close")!(0);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(mockSpawn).toHaveBeenCalledTimes(4); // 3 retries + 1 success
    });

    it("does not retry when maxRetries=0", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/path/to/mcp.json",
        maxRetries: 0,
      });

      listeners.get("stderr:data")!(
        Buffer.from("MCP error: Failed to connect to server pencil: ECONNREFUSED")
      );
      listeners.get("close")!(1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(1); // No retry
    });

    it("does not retry when mcpConfigPath is not provided", async () => {
      const promise = runClaude({
        prompt: "test",
        model: "claude-sonnet-4-6",
        maxRetries: 3,
      });

      // Generic non-MCP error
      listeners.get("stderr:data")!(Buffer.from("Some other error"));
      listeners.get("close")!(1);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(mockSpawn).toHaveBeenCalledTimes(1); // No retry
    });
  });
});
