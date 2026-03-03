import { describe, it, expect } from "vitest";

const {
  snapshotPenFile, diffPenSnapshots,
} = await import("../pen-snapshot.js");

// ── snapshotPenFile (moved from prompt-builder.test.ts) ──

describe("snapshotPenFile", () => {
  it("extracts tracked properties from .pen JSON", () => {
    const pen = JSON.stringify({
      children: [
        {
          id: "btn1",
          name: "submitBtn",
          type: "frame",
          fill: "#ff0000",
          cornerRadius: 8,
          width: 200,
          height: 48,
        },
      ],
    });

    const snapshot = snapshotPenFile("/tmp/test.pen", pen);

    expect(snapshot["btn1"]).toBeDefined();
    expect(snapshot["btn1"].name).toBe("submitBtn");
    expect(snapshot["btn1"].fill).toBe("#ff0000");
    expect(snapshot["btn1"].cornerRadius).toBe(8);
    // width/height are NOT tracked
    expect(snapshot["btn1"].width).toBeUndefined();
  });

  it("flattens nested children", () => {
    const pen = JSON.stringify({
      children: [
        {
          id: "page",
          name: "HomePage",
          type: "frame",
          fill: "#272822",
          children: [
            {
              id: "header",
              name: "headerBar",
              type: "frame",
              fill: "#1e1f1c",
              children: [
                { id: "logo", name: "logoText", type: "text", content: "viddocs", fontSize: 24 },
              ],
            },
          ],
        },
      ],
    });

    const snapshot = snapshotPenFile("/tmp/test.pen", pen);

    expect(snapshot["page"]).toBeDefined();
    expect(snapshot["header"]).toBeDefined();
    expect(snapshot["logo"]).toBeDefined();
    expect(snapshot["logo"].content).toBe("viddocs");
    expect(snapshot["logo"].fontSize).toBe(24);
  });

  it("returns empty snapshot for invalid JSON", () => {
    const snapshot = snapshotPenFile("/tmp/bad.pen", "not valid json {{{");
    expect(snapshot).toEqual({});
  });

  it("returns empty snapshot for .pen with no children", () => {
    const snapshot = snapshotPenFile("/tmp/empty.pen", JSON.stringify({}));
    expect(snapshot).toEqual({});
  });
});

// ── diffPenSnapshots (moved from prompt-builder.test.ts) ──

describe("diffPenSnapshots", () => {
  it("detects fill changes", () => {
    const oldSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#00ff00" } };
    const newSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#ff0000" } };

    const diffs = diffPenSnapshots(oldSnap, newSnap);

    expect(diffs).toHaveLength(1);
    expect(diffs[0].nodeId).toBe("btn1");
    expect(diffs[0].prop).toBe("fill");
    expect(diffs[0].oldValue).toBe("#00ff00");
    expect(diffs[0].newValue).toBe("#ff0000");
  });

  it("detects text content changes", () => {
    const oldSnap = { t1: { name: "title", type: "text", content: "hello" } };
    const newSnap = { t1: { name: "title", type: "text", content: "world" } };

    const diffs = diffPenSnapshots(oldSnap, newSnap);

    expect(diffs).toHaveLength(1);
    expect(diffs[0].prop).toBe("content");
    expect(diffs[0].oldValue).toBe("hello");
    expect(diffs[0].newValue).toBe("world");
  });

  it("detects typography changes (fontSize, fontWeight)", () => {
    const oldSnap = { t1: { name: "heading", type: "text", fontSize: 16, fontWeight: "400" } };
    const newSnap = { t1: { name: "heading", type: "text", fontSize: 24, fontWeight: "700" } };

    const diffs = diffPenSnapshots(oldSnap, newSnap);

    expect(diffs).toHaveLength(2);
    const fontSizeDiff = diffs.find((d) => d.prop === "fontSize");
    const fontWeightDiff = diffs.find((d) => d.prop === "fontWeight");
    expect(fontSizeDiff!.oldValue).toBe(16);
    expect(fontSizeDiff!.newValue).toBe(24);
    expect(fontWeightDiff!.oldValue).toBe("400");
    expect(fontWeightDiff!.newValue).toBe("700");
  });

  it("ignores unchanged properties", () => {
    const oldSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#ff0000", cornerRadius: 8 } };
    const newSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#ff0000", cornerRadius: 8 } };

    const diffs = diffPenSnapshots(oldSnap, newSnap);
    expect(diffs).toHaveLength(0);
  });

  it("skips new nodes (not in old snapshot)", () => {
    const oldSnap = { btn1: { name: "submitBtn", type: "frame", fill: "#ff0000" } };
    const newSnap = {
      btn1: { name: "submitBtn", type: "frame", fill: "#ff0000" },
      btn2: { name: "newBtn", type: "frame", fill: "#00ff00" },
    };

    const diffs = diffPenSnapshots(oldSnap, newSnap);
    expect(diffs).toHaveLength(0);
  });

  it("detects multiple changes across multiple nodes", () => {
    const oldSnap = {
      btn1: { name: "submitBtn", type: "frame", fill: "#00ff00" },
      t1: { name: "title", type: "text", content: "old", fontSize: 16 },
    };
    const newSnap = {
      btn1: { name: "submitBtn", type: "frame", fill: "#ff0000" },
      t1: { name: "title", type: "text", content: "new", fontSize: 24 },
    };

    const diffs = diffPenSnapshots(oldSnap, newSnap);

    expect(diffs).toHaveLength(3); // fill + content + fontSize
    expect(diffs.map((d) => d.prop).sort()).toEqual(["content", "fill", "fontSize"]);
  });

  it("returns empty array when both snapshots are empty", () => {
    const diffs = diffPenSnapshots({}, {});
    expect(diffs).toHaveLength(0);
  });
});

