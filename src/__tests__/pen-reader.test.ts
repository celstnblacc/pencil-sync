import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonPenReader } from "../pen-reader.js";

describe("JsonPenReader", () => {
  let dir: string;
  let reader: JsonPenReader;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pencil-pen-reader-"));
    reader = new JsonPenReader();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a snapshot for a valid .pen file", async () => {
    const penFile = join(dir, "test.pen");
    await writeFile(penFile, JSON.stringify({
      children: [
        { id: "btn1", name: "submitBtn", type: "frame", fill: "#ff0000", cornerRadius: 8 },
        { id: "txt1", name: "heading", type: "text", content: "Hello", fontSize: 24 },
      ],
    }));

    const snapshot = await reader.readSnapshot(penFile);

    expect(snapshot).not.toBeNull();
    expect(snapshot!["btn1"]).toBeDefined();
    expect(snapshot!["btn1"].fill).toBe("#ff0000");
    expect(snapshot!["btn1"].cornerRadius).toBe(8);
    expect(snapshot!["txt1"]).toBeDefined();
    expect(snapshot!["txt1"].content).toBe("Hello");
    expect(snapshot!["txt1"].fontSize).toBe(24);
  });

  it("returns empty snapshot for a .pen file with no tracked nodes", async () => {
    const penFile = join(dir, "empty.pen");
    await writeFile(penFile, JSON.stringify({ children: [] }));

    const snapshot = await reader.readSnapshot(penFile);

    expect(snapshot).not.toBeNull();
    expect(snapshot).toEqual({});
  });

  it("returns null for a .pen file with invalid JSON", async () => {
    const penFile = join(dir, "invalid.pen");
    await writeFile(penFile, "not valid json{{{");

    const snapshot = await reader.readSnapshot(penFile);

    expect(snapshot).toBeNull();
  });

  it("throws when file does not exist", async () => {
    const penFile = join(dir, "missing.pen");

    await expect(reader.readSnapshot(penFile)).rejects.toThrow();
  });

  it("handles nested children", async () => {
    const penFile = join(dir, "nested.pen");
    await writeFile(penFile, JSON.stringify({
      children: [
        {
          id: "frame1",
          name: "container",
          type: "frame",
          fill: "#ffffff",
          children: [
            { id: "inner1", name: "label", type: "text", content: "Click me", fontSize: 14 },
          ],
        },
      ],
    }));

    const snapshot = await reader.readSnapshot(penFile);

    expect(snapshot).not.toBeNull();
    expect(snapshot!["frame1"]).toBeDefined();
    expect(snapshot!["inner1"]).toBeDefined();
    expect(snapshot!["inner1"].content).toBe("Click me");
  });
});
