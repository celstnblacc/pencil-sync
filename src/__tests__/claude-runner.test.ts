import { describe, it, expect } from "vitest";
import {
  parseTokenUsage,
  estimateCost,
  estimateInputTokens,
  MODEL_PRICING,
} from "../claude-runner.js";

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
    // $3 input + $15 output = $18
    expect(cost).toBe(18);
  });

  it("estimates cost for haiku", () => {
    const cost = estimateCost("claude-haiku-4-5-20251001", { input: 1_000_000, output: 1_000_000 });
    // $0.25 input + $1.25 output = $1.50
    expect(cost).toBe(1.50);
  });

  it("estimates cost for opus", () => {
    const cost = estimateCost("claude-opus-4-6", { input: 1_000_000, output: 1_000_000 });
    // $15 input + $75 output = $90
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
