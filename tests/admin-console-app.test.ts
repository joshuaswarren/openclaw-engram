import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class FakeElement {
  value = "";
  textContent = "";
  disabled = false;
  className = "";
  dataset: Record<string, string> = {};

  addEventListener(): void {}
  appendChild(): void {}
  removeChild(): void {}
  get firstChild(): null {
    return null;
  }
}

/** Minimal fake canvas context — records calls but does nothing. */
class FakeCanvasContext {
  calls: string[] = [];
  save() { this.calls.push("save"); }
  restore() { this.calls.push("restore"); }
  clearRect() { this.calls.push("clearRect"); }
  scale() {}
  beginPath() {}
  arc() {}
  fill() {}
  stroke() {}
  moveTo() {}
  lineTo() {}
  fillText() {}
  get fillStyle() { return ""; }
  set fillStyle(_v: string) {}
  get strokeStyle() { return ""; }
  set strokeStyle(_v: string) {}
  get lineWidth() { return 1; }
  set lineWidth(_v: number) {}
  get globalAlpha() { return 1; }
  set globalAlpha(_v: number) {}
  get font() { return ""; }
  set font(_v: string) {}
  get textAlign() { return ""; }
  set textAlign(_v: string) {}
}

class FakeCanvas extends FakeElement {
  width = 0;
  height = 0;
  offsetWidth = 800;
  offsetHeight = 520;
  _ctx = new FakeCanvasContext();
  getContext(_type: string) { return this._ctx; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 520 }; }
}

async function loadAdminConsoleContext(pageSizeValue: string, extraElements: Record<string, FakeElement> = {}) {
  const scriptPath = path.resolve("admin-console/public/app.js");
  const script = await readFile(scriptPath, "utf8");
  const elements = new Map<string, FakeElement>([
    ["memoryPrevButton", new FakeElement()],
    ["memoryNextButton", new FakeElement()],
    ["memoryPageStatus", new FakeElement()],
    ["memoryPageSize", Object.assign(new FakeElement(), { value: pageSizeValue })],
    ...Object.entries(extraElements),
  ]);
  const session = new Map<string, string>();
  const context = vm.createContext({
    console,
    URLSearchParams,
    requestAnimationFrame: (_fn: () => void) => 0,
    cancelAnimationFrame: (_id: number) => {},
    document: {
      getElementById(id: string) {
        return elements.get(id) ?? null;
      },
      createElement() {
        return new FakeElement();
      },
    },
    window: {
      devicePixelRatio: 1,
      sessionStorage: {
        getItem(key: string) {
          return session.get(key) ?? "";
        },
        setItem(key: string, value: string) {
          session.set(key, value);
        },
        removeItem(key: string) {
          session.delete(key);
        },
      },
    },
    navigator: {},
  });
  vm.runInContext(script, context, { filename: scriptPath });
  return {
    browserState: vm.runInContext("browserState", context) as { limit: number; offset: number; total: number },
    copyMemoryPath: vm.runInContext("copyMemoryPath", context) as () => void,
    renderQuality: vm.runInContext("renderQuality", context) as (response: unknown) => void,
    stepMemoryPage: vm.runInContext("stepMemoryPage", context) as (direction: number) => void,
    graphColorForCategory: vm.runInContext("graphColorForCategory", context) as (cat: string) => string,
    createForceSimulation: vm.runInContext("createForceSimulation", context) as (
      nodes: Array<{ id: string; score: number; kind: string; x?: number; y?: number; vx?: number; vy?: number }>,
      edges: Array<{ _srcNode: unknown; _tgtNode: unknown }>,
      width: number,
      height: number,
    ) => { start: (fn: () => void) => void; stop: () => void },
    drawGraph: vm.runInContext("drawGraph", context) as () => void,
    graphData: vm.runInContext("graphData", context),
    graphView: vm.runInContext("graphView", context) as { tx: number; ty: number; scale: number },
    resolveHighlights: vm.runInContext("resolveHighlights", context) as (
      nodes: Array<{ id: string }>,
      results: Array<{ id: string; path?: string }>,
    ) => Map<string, string>,
  };
}

test("admin console pagination step reads the current page size before advancing", async () => {
  const { browserState, stepMemoryPage } = await loadAdminConsoleContext("10");
  browserState.limit = 25;
  browserState.offset = 50;

  stepMemoryPage(1);

  assert.equal(browserState.limit, 10);
  assert.equal(browserState.offset, 60);
});

test("admin console pagination step reads the current page size before retreating", async () => {
  const { browserState, stepMemoryPage } = await loadAdminConsoleContext("10");
  browserState.limit = 25;
  browserState.offset = 50;

  stepMemoryPage(-1);

  assert.equal(browserState.limit, 10);
  assert.equal(browserState.offset, 40);
});

test("admin console quality renderer tolerates a missing JSON mount", async () => {
  const { renderQuality } = await loadAdminConsoleContext("25", {
    qualitySummary: new FakeElement(),
  });

  assert.doesNotThrow(() => {
    renderQuality({
      totalMemories: 2,
      archivePressure: { pendingReview: 1, archived: 0 },
      latestGovernanceRun: { qualityScore: { score: 90 } },
    });
  });
});

test("admin console copy path fails cleanly when no memory is selected", async () => {
  const detailStatus = new FakeElement();
  const { copyMemoryPath } = await loadAdminConsoleContext("25", {
    memoryDetailStatus: detailStatus,
    memoryRawPath: new FakeElement(),
  });

  copyMemoryPath();

  assert.equal(detailStatus.textContent, "No memory path to copy.");
  assert.equal(detailStatus.className, "status error");
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory Graph pane — issue #691 PR 3/5
// ─────────────────────────────────────────────────────────────────────────────

test("graph category colour palette returns a stable colour for known categories", async () => {
  const { graphColorForCategory } = await loadAdminConsoleContext("25");
  const c1 = graphColorForCategory("fact");
  const c2 = graphColorForCategory("fact");
  // Same category always yields the same colour.
  assert.equal(c1, c2);
  // Unknown / empty yields the grey fallback.
  assert.equal(graphColorForCategory("unknown"), "#aaa");
  assert.equal(graphColorForCategory(""), "#aaa");
});

test("graph category colour palette assigns different colours to distinct categories", async () => {
  const { graphColorForCategory } = await loadAdminConsoleContext("25");
  const factColor = graphColorForCategory("fact");
  const decisionColor = graphColorForCategory("decision");
  // Two distinct categories must not share the same colour
  // (palette has 8 entries; the first two are always different).
  assert.notEqual(factColor, decisionColor);
});

test("force simulation places all nodes with x/y after start", async () => {
  const { createForceSimulation } = await loadAdminConsoleContext("25");

  const nodes = [
    { id: "a", score: 0.9, kind: "fact" },
    { id: "b", score: 0.5, kind: "decision" },
    { id: "c", score: 0.3, kind: "fact" },
  ];
  const edges = [
    { _srcNode: nodes[0], _tgtNode: nodes[1] },
    { _srcNode: nodes[1], _tgtNode: nodes[2] },
  ];

  const sim = createForceSimulation(nodes, edges, 800, 520);
  // start with a no-op draw callback; raf is stubbed to 0 so no loop runs.
  sim.start(() => {});
  sim.stop();

  for (const n of nodes) {
    assert.ok(typeof (n as { x?: number }).x === "number", `node ${n.id} missing x`);
    assert.ok(typeof (n as { y?: number }).y === "number", `node ${n.id} missing y`);
    assert.ok(!Number.isNaN((n as { x?: number }).x));
    assert.ok(!Number.isNaN((n as { y?: number }).y));
  }
});

test("drawGraph is a no-op when graphData is null", async () => {
  const canvas = new FakeCanvas();
  const graphStatus = new FakeElement();
  const { drawGraph } = await loadAdminConsoleContext("25", {
    graphCanvas: canvas,
    graphStatus,
  });

  // graphData starts null; drawGraph must not throw.
  assert.doesNotThrow(() => drawGraph());
  // Canvas context must not have been touched (no save calls).
  assert.equal(canvas._ctx.calls.length, 0);
});

test("graph pane HTML elements are present in index.html", async () => {
  const htmlPath = path.resolve("admin-console/public/index.html");
  const html = await readFile(htmlPath, "utf8");

  assert.ok(html.includes('id="graphCanvas"'), "graphCanvas element missing");
  assert.ok(html.includes('id="graphTooltip"'), "graphTooltip element missing");
  assert.ok(html.includes('id="graphStatus"'), "graphStatus element missing");
  assert.ok(html.includes('id="graphLegend"'), "graphLegend element missing");
  assert.ok(html.includes('id="refreshGraphButton"'), "refreshGraphButton missing");
  assert.ok(html.includes('id="resetGraphViewButton"'), "resetGraphViewButton missing");
  assert.ok(html.includes('id="graphLimit"'), "graphLimit select missing");
  assert.ok(html.includes('id="graphFocusNodeId"'), "graphFocusNodeId input missing");
});

// ─────────────────────────────────────────────────────────────────────────────
// Semantic-search highlight + drill-through — issue #691 PR 4/5
// ─────────────────────────────────────────────────────────────────────────────

test("graph search highlight HTML elements are present in index.html", async () => {
  const htmlPath = path.resolve("admin-console/public/index.html");
  const html = await readFile(htmlPath, "utf8");

  assert.ok(html.includes('id="graphSearchQuery"'), "graphSearchQuery input missing");
  assert.ok(html.includes('id="graphSearchButton"'), "graphSearchButton missing");
  assert.ok(html.includes('id="graphClearSearchButton"'), "graphClearSearchButton missing");
  assert.ok(html.includes('id="graphNodePanel"'), "graphNodePanel missing");
  assert.ok(html.includes('id="graphNodeFrontmatter"'), "graphNodeFrontmatter missing");
  assert.ok(html.includes('id="graphNodeContent"'), "graphNodeContent missing");
  assert.ok(html.includes('id="graphNodeEdges"'), "graphNodeEdges missing");
});

test("resolveHighlights returns empty map when results array is empty", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "facts/foo.md" }, { id: "facts/bar.md" }];
  const result = resolveHighlights(nodes, []);
  assert.equal(result.size, 0);
});

test("resolveHighlights matches via result.path suffix against node.id (production case)", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  // Typical production: node.id is relative path, result carries absolute path + frontmatter id.
  const nodes = [
    { id: "facts/foo.md" },
    { id: "facts/bar.md" },
    { id: "decisions/baz.md" },
  ];
  const results = [
    { id: "fact-abc123", path: "/Users/me/.remnic/facts/foo.md" },
    { id: "decision-xyz", path: "/Users/me/.remnic/decisions/baz.md" },
  ];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 2);
  // Map keys are node IDs; values are frontmatter IDs for the detail endpoint.
  assert.ok(matched.has("facts/foo.md"));
  assert.equal(matched.get("facts/foo.md"), "fact-abc123");
  assert.ok(matched.has("decisions/baz.md"));
  assert.equal(matched.get("decisions/baz.md"), "decision-xyz");
  assert.ok(!matched.has("facts/bar.md"));
});

test("resolveHighlights falls back to frontmatter id match when path absent", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  // When result has no path, fall back to id-based suffix matching.
  const nodes = [{ id: "facts/foo.md" }];
  const results = [{ id: "facts/foo.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 1);
  assert.ok(matched.has("facts/foo.md"));
});

test("resolveHighlights matches when result id is a suffix of node id (no path)", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "/Users/me/.remnic/facts/foo.md" }];
  const results = [{ id: "facts/foo.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 1);
  assert.ok(matched.has("/Users/me/.remnic/facts/foo.md"));
});

test("resolveHighlights matches when node id is a suffix of result path", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "facts/foo.md" }];
  const results = [{ id: "fact-xyz", path: "/Users/me/.remnic/facts/foo.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 1);
  // Value is the frontmatter ID, not the path.
  assert.equal(matched.get("facts/foo.md"), "fact-xyz");
});

test("resolveHighlights does not match unrelated ids", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "facts/alpha.md" }, { id: "facts/beta.md" }];
  const results = [{ id: "decision-xyz", path: "/Users/me/.remnic/decisions/gamma.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 0);
});

test("resolveHighlights handles nodes with missing ids gracefully", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const nodes = [{ id: "" }, { id: "facts/foo.md" }] as Array<{ id: string }>;
  const results = [{ id: "fact-abc", path: "/Users/me/.remnic/facts/foo.md" }];
  const matched = resolveHighlights(nodes, results);
  assert.equal(matched.size, 1);
  assert.ok(matched.has("facts/foo.md"));
});

test("resolveHighlights returns empty map when nodes array is empty", async () => {
  const { resolveHighlights } = await loadAdminConsoleContext("25");
  const matched = resolveHighlights([], [{ id: "fact-abc", path: "/Users/me/.remnic/facts/foo.md" }]);
  assert.equal(matched.size, 0);
});
