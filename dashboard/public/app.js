async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(value);
}

function renderGraph(graph) {
  setText("nodes", graph?.stats?.nodes ?? 0);
  setText("edges", graph?.stats?.edges ?? 0);
  const graphEl = document.getElementById("graph");
  if (graphEl) graphEl.textContent = JSON.stringify(graph, null, 2);
}

function renderPatch(patch) {
  const patchEl = document.getElementById("patch");
  if (patchEl) patchEl.textContent = JSON.stringify(patch, null, 2);
}

async function bootstrap() {
  try {
    const [health, graph] = await Promise.all([fetchJson("/api/health"), fetchJson("/api/graph")]);
    setText("status", health?.ok ? "ok" : "degraded");
    setText("clients", health?.clients ?? 0);
    renderGraph(graph);
  } catch (err) {
    setText("status", `error: ${err?.message ?? String(err)}`);
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}`);
  ws.addEventListener("open", () => setText("status", "streaming"));
  ws.addEventListener("close", () => setText("status", "closed"));
  ws.addEventListener("error", () => setText("status", "error"));
  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "hello" && data.graph) {
        renderGraph(data.graph);
        return;
      }
      if (data.type === "graph_patch") {
        if (data.graph) renderGraph(data.graph);
        renderPatch(data.patch ?? data);
      }
    } catch {
      // ignore malformed messages
    }
  });
}

void bootstrap();

