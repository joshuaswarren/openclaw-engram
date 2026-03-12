const tokenKey = "engram.adminConsole.token";
const browserState = {
  sort: "updated_desc",
  limit: 25,
  offset: 0,
  total: 0,
};

function $(id) {
  return document.getElementById(id);
}

function readToken() {
  return window.sessionStorage.getItem(tokenKey) || "";
}

function writeToken(token) {
  if (token) {
    window.sessionStorage.setItem(tokenKey, token);
  } else {
    window.sessionStorage.removeItem(tokenKey);
  }
}

function setStatus(id, message, tone = "default") {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.className = tone === "default" ? "status" : `status ${tone}`;
}

function clearChildren(el) {
  if (!el) return;
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

function appendPill(container, value) {
  if (!container || !value) return;
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = value;
  container.appendChild(pill);
}

function renderEmptyState(container, message) {
  clearChildren(container);
  if (!container) return;
  const item = document.createElement("div");
  item.className = "item";
  const strong = document.createElement("strong");
  strong.textContent = message;
  item.appendChild(strong);
  container.appendChild(item);
}

function createItem() {
  const article = document.createElement("article");
  article.className = "item";
  return article;
}

async function fetchJson(url, options = {}) {
  const token = readToken();
  const headers = new Headers(options.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function syncBrowserControls() {
  const prevButton = $("memoryPrevButton");
  const nextButton = $("memoryNextButton");
  if (prevButton) prevButton.disabled = browserState.offset <= 0;
  if (nextButton) nextButton.disabled = browserState.offset + browserState.limit >= browserState.total;

  const pageStatus = $("memoryPageStatus");
  if (!pageStatus) return;
  if (browserState.total === 0) {
    pageStatus.textContent = "No results";
    return;
  }
  const pageOffset = Math.min(
    browserState.offset,
    Math.max(0, browserState.total - 1),
  );
  const start = pageOffset + 1;
  const end = Math.min(pageOffset + browserState.limit, browserState.total);
  pageStatus.textContent = `${start}-${end} of ${browserState.total}`;
}

function renderMemoryList(memories) {
  const list = $("memoryList");
  if (!list) return;
  if (!Array.isArray(memories) || memories.length === 0) {
    renderEmptyState(list, "No memories matched.");
    return;
  }
  clearChildren(list);
  memories.forEach((memory) => {
    const article = createItem();
    const meta = document.createElement("div");
    meta.className = "meta";
    appendPill(meta, memory.category);
    appendPill(meta, memory.status);
    appendPill(meta, memory.entityRef);
    article.appendChild(meta);

    const heading = document.createElement("h3");
    heading.style.marginTop = "10px";
    heading.textContent = memory.id;
    article.appendChild(heading);

    const pathText = document.createElement("div");
    pathText.className = "status";
    pathText.textContent = memory.path;
    article.appendChild(pathText);

    const preview = document.createElement("p");
    preview.textContent = memory.preview;
    article.appendChild(preview);

    const button = document.createElement("button");
    button.className = "memory-open-button";
    button.dataset.memoryId = memory.id;
    button.textContent = "Open Memory";
    button.addEventListener("click", () => void loadMemoryDetail(memory.id));
    article.appendChild(button);

    list.appendChild(article);
  });
}

function renderReviewQueue(response) {
  const list = $("reviewQueueList");
  if (!list) return;
  if (!response?.found || !Array.isArray(response.reviewQueue) || response.reviewQueue.length === 0) {
    renderEmptyState(list, "No review queue entries found.");
    return;
  }
  clearChildren(list);
  response.reviewQueue.forEach((entry) => {
    const article = createItem();
    const meta = document.createElement("div");
    meta.className = "meta";
    appendPill(meta, entry.reasonCode);
    appendPill(meta, entry.severity);
    appendPill(
      meta,
      entry.suggestedAction ? `${entry.suggestedAction}${entry.suggestedStatus ? `:${entry.suggestedStatus}` : ""}` : "",
    );
    article.appendChild(meta);

    const heading = document.createElement("h3");
    heading.style.marginTop = "10px";
    heading.textContent = entry.memoryId;
    article.appendChild(heading);

    const pathText = document.createElement("div");
    pathText.className = "status";
    pathText.textContent = entry.path || "";
    article.appendChild(pathText);

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    toolbar.style.marginTop = "12px";

    const inspectButton = document.createElement("button");
    inspectButton.className = "secondary queue-open-button";
    inspectButton.dataset.memoryId = entry.memoryId;
    inspectButton.textContent = "Inspect";
    inspectButton.addEventListener("click", () => void loadMemoryDetail(entry.memoryId));
    toolbar.appendChild(inspectButton);

    [
      ["accent", "active", "Confirm"],
      ["secondary", "rejected", "Reject"],
      ["warn", "archived", "Archive"],
    ].forEach(([className, nextStatus, label]) => {
      const button = document.createElement("button");
      button.className = `${className} queue-disposition-button`;
      button.dataset.memoryId = entry.memoryId;
      button.dataset.status = nextStatus;
      button.textContent = label;
      button.addEventListener("click", () => void applyDisposition(entry.memoryId, nextStatus));
      toolbar.appendChild(button);
    });

    article.appendChild(toolbar);
    list.appendChild(article);
  });
}

function renderEntityList(entities) {
  const list = $("entityList");
  if (!list) return;
  if (!Array.isArray(entities) || entities.length === 0) {
    renderEmptyState(list, "No entities matched.");
    return;
  }
  clearChildren(list);
  entities.forEach((entity) => {
    const article = createItem();
    const meta = document.createElement("div");
    meta.className = "meta";
    appendPill(meta, entity.type);
    (entity.aliases || []).forEach((alias) => appendPill(meta, alias));
    article.appendChild(meta);

    const heading = document.createElement("h3");
    heading.style.marginTop = "10px";
    heading.textContent = entity.name;
    article.appendChild(heading);

    const summary = document.createElement("div");
    summary.className = "status";
    summary.textContent = entity.summary || "No summary.";
    article.appendChild(summary);

    const button = document.createElement("button");
    button.className = "entity-open-button";
    button.dataset.entityName = entity.name;
    button.textContent = "Open Entity";
    button.addEventListener("click", () => void loadEntityDetail(entity.name));
    article.appendChild(button);

    list.appendChild(article);
  });
}

function renderQuality(response) {
  const summary = $("qualitySummary");
  clearChildren(summary);
  const cards = [
    ["Memories", String(response.totalMemories ?? 0)],
    ["Pending Review", String(response.archivePressure?.pendingReview ?? 0)],
    ["Archived", String(response.archivePressure?.archived ?? 0)],
    ["Quality Score", typeof response.latestGovernanceRun?.qualityScore?.score === "number"
      ? String(response.latestGovernanceRun.qualityScore.score)
      : "n/a"],
  ];
  cards.forEach(([label, value]) => {
    if (!summary) return;
    const card = document.createElement("div");
    card.className = "quality-stat";
    const strong = document.createElement("strong");
    strong.textContent = value;
    card.appendChild(strong);
    const caption = document.createElement("div");
    caption.className = "status";
    caption.textContent = label;
    card.appendChild(caption);
    summary.appendChild(card);
  });
  $("qualityJson").textContent = JSON.stringify(response, null, 2);
}

async function loadMemoryBrowser(resetOffset = false) {
  if (resetOffset) browserState.offset = 0;
  browserState.sort = $("memorySort")?.value || "updated_desc";
  browserState.limit = Number.parseInt($("memoryPageSize")?.value || "25", 10) || 25;
  setStatus("memoryBrowserStatus", "Loading memory browser...");
  const params = new URLSearchParams();
  const query = $("memoryQuery")?.value?.trim();
  const status = $("memoryStatus")?.value?.trim();
  const category = $("memoryCategory")?.value?.trim();
  if (query) params.set("q", query);
  if (status) params.set("status", status);
  if (category) params.set("category", category);
  params.set("sort", browserState.sort);
  params.set("limit", String(browserState.limit));
  params.set("offset", String(browserState.offset));
  const response = await fetchJson(`/engram/v1/memories?${params.toString()}`);
  browserState.total = response.total || 0;
  const maxOffset = browserState.total > 0
    ? Math.floor((browserState.total - 1) / browserState.limit) * browserState.limit
    : 0;
  if (!resetOffset && browserState.offset > maxOffset) {
    browserState.offset = maxOffset;
    return loadMemoryBrowser(false);
  }
  renderMemoryList(response.memories);
  syncBrowserControls();
  setStatus("memoryBrowserStatus", `Loaded ${response.count} of ${response.total} memories.`, "ok");
}

async function loadMemoryDetail(memoryId) {
  if (!memoryId) return;
  setStatus("memoryDetailStatus", `Loading ${memoryId}...`);
  const [memory, timeline] = await Promise.all([
    fetchJson(`/engram/v1/memories/${encodeURIComponent(memoryId)}`),
    fetchJson(`/engram/v1/memories/${encodeURIComponent(memoryId)}/timeline?limit=50`),
  ]);
  $("memoryContent").textContent = JSON.stringify(memory.memory, null, 2);
  $("memoryTimeline").textContent = JSON.stringify(timeline.timeline, null, 2);
  $("memoryRawPath").value = memory.memory?.path || "";
  const meta = $("memoryDetailMeta");
  clearChildren(meta);
  appendPill(meta, memory.memory.category);
  appendPill(meta, memory.memory.status || "active");
  appendPill(meta, memory.memory.path);
  setStatus("memoryDetailStatus", `Loaded ${memoryId}.`, "ok");
}

async function runRecallDebugger() {
  const query = $("recallQuery")?.value?.trim() || "";
  const sessionKey = $("recallSessionKey")?.value?.trim() || "admin-console";
  setStatus("recallStatus", "Running recall...");
  const recall = await fetchJson("/engram/v1/recall", {
    method: "POST",
    body: JSON.stringify({ query, sessionKey }),
  });
  const explain = await fetchJson("/engram/v1/recall/explain", {
    method: "POST",
    body: JSON.stringify({ sessionKey }),
  });
  $("recallContext").textContent = JSON.stringify(recall, null, 2);
  $("recallExplain").textContent = JSON.stringify(explain, null, 2);
  setStatus("recallStatus", `Recall completed for ${sessionKey}.`, "ok");
}

async function loadReviewQueue() {
  setStatus("reviewQueueStatus", "Loading latest governance review queue...");
  const response = await fetchJson("/engram/v1/review-queue");
  renderReviewQueue(response);
  setStatus(
    "reviewQueueStatus",
    response?.found
      ? `Loaded run ${response.runId} with ${response.reviewQueue.length} queue entries.`
      : "No governance review queue artifacts found.",
    response?.found ? "ok" : "default",
  );
}

async function applyDisposition(memoryId, status) {
  if (!memoryId || !status) return;
  setStatus("reviewQueueStatus", `Applying ${status} to ${memoryId}...`);
  await fetchJson("/engram/v1/review-disposition", {
    method: "POST",
    body: JSON.stringify({
      memoryId,
      status,
      reasonCode: status === "active" ? "operator_confirmed" : "operator_review",
    }),
  });
  await Promise.all([
    loadReviewQueue(),
    loadMemoryBrowser(),
    loadMemoryDetail(memoryId).catch(() => {}),
    loadQuality(),
    loadMaintenance(),
  ]);
  setStatus("reviewQueueStatus", `Applied ${status} to ${memoryId}.`, "ok");
}

async function loadEntities() {
  setStatus("entityStatus", "Loading entities...");
  const params = new URLSearchParams();
  const query = $("entityQuery")?.value?.trim();
  if (query) params.set("q", query);
  const response = await fetchJson(`/engram/v1/entities?${params.toString()}`);
  renderEntityList(response.entities);
  setStatus("entityStatus", `Loaded ${response.count} of ${response.total} entities.`, "ok");
}

async function loadEntityDetail(name) {
  if (!name) return;
  const response = await fetchJson(`/engram/v1/entities/${encodeURIComponent(name)}`);
  $("entityDetail").textContent = JSON.stringify(response.entity, null, 2);
}

async function loadQuality() {
  setStatus("qualityStatus", "Loading quality dashboard...");
  const response = await fetchJson("/engram/v1/quality");
  renderQuality(response);
  setStatus(
    "qualityStatus",
    response.latestGovernanceRun?.found
      ? `Loaded quality summary for ${response.totalMemories} memories and governance run ${response.latestGovernanceRun.runId}.`
      : `Loaded quality summary for ${response.totalMemories} memories.`,
    "ok",
  );
}

async function loadMaintenance() {
  setStatus("maintenanceStatus", "Loading maintenance summary...");
  const response = await fetchJson("/engram/v1/maintenance");
  $("maintenanceJson").textContent = JSON.stringify(response, null, 2);
  setStatus("maintenanceStatus", "Maintenance summary loaded.", "ok");
}

async function connectAndBootstrap() {
  const input = $("tokenInput");
  const token = input?.value?.trim() || readToken();
  if (!token) {
    setStatus("authStatus", "Enter a bearer token first.", "error");
    return;
  }
  writeToken(token);
  if (input) input.value = token;
  setStatus("authStatus", "Connecting...", "default");
  try {
    await fetchJson("/engram/v1/health");
    setStatus("authStatus", "Connected to Engram access API.", "ok");
    await Promise.allSettled([
      loadMemoryBrowser(true),
      loadReviewQueue(),
      loadEntities(),
      loadQuality(),
      loadMaintenance(),
    ]);
  } catch (error) {
    setStatus("authStatus", error.message || String(error), "error");
  }
}

function copyMemoryPath() {
  const rawPathField = $("memoryRawPath");
  const value = rawPathField?.value?.trim();
  if (!value || value === rawPathField?.dataset?.emptyValue) {
    setStatus("memoryDetailStatus", "No memory path to copy.", "error");
    return;
  }
  if (!navigator.clipboard?.writeText) {
    setStatus("memoryDetailStatus", "Clipboard API is unavailable in this browser.", "error");
    return;
  }
  navigator.clipboard.writeText(value)
    .then(() => {
      setStatus("memoryDetailStatus", "Copied raw memory path.", "ok");
    })
    .catch((error) => {
      setStatus("memoryDetailStatus", error.message || String(error), "error");
    });
}

function bootstrap() {
  const remembered = readToken();
  if (remembered && $("tokenInput")) {
    $("tokenInput").value = remembered;
  }

  $("connectButton")?.addEventListener("click", () => void connectAndBootstrap());
  $("clearTokenButton")?.addEventListener("click", () => {
    writeToken("");
    if ($("tokenInput")) $("tokenInput").value = "";
    setStatus("authStatus", "Cleared stored token.", "default");
  });
  $("searchMemoriesButton")?.addEventListener("click", () => void loadMemoryBrowser(true));
  $("memoryPrevButton")?.addEventListener("click", () => {
    browserState.offset = Math.max(0, browserState.offset - browserState.limit);
    void loadMemoryBrowser(false);
  });
  $("memoryNextButton")?.addEventListener("click", () => {
    browserState.offset += browserState.limit;
    void loadMemoryBrowser(false);
  });
  $("runRecallButton")?.addEventListener("click", () => void runRecallDebugger());
  $("refreshQueueButton")?.addEventListener("click", () => void loadReviewQueue());
  $("searchEntitiesButton")?.addEventListener("click", () => void loadEntities());
  $("copyMemoryPathButton")?.addEventListener("click", copyMemoryPath);

  if (remembered) {
    void connectAndBootstrap();
  } else {
    syncBrowserControls();
  }
}

bootstrap();
