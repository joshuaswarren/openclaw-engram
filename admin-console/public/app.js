const tokenKey = "remnic.adminConsole.token";
const legacyTokenKey = "engram.adminConsole.token";

// One-time migration: copy any pre-existing token from the legacy
// `engram.adminConsole.token` key over to the new `remnic.*` key so
// existing operators are not logged out by the rename. Runs once on
// load; the legacy key is removed only after the new key is written.
function migrateLegacyToken() {
  try {
    const storage = window.sessionStorage;
    if (!storage) return;
    const current = storage.getItem(tokenKey);
    if (current) return;
    const legacy = storage.getItem(legacyTokenKey);
    if (!legacy) return;
    storage.setItem(tokenKey, legacy);
    storage.removeItem(legacyTokenKey);
  } catch {
    // sessionStorage can throw in private/sandboxed contexts; ignore.
  }
}
migrateLegacyToken();
const browserState = {
  sort: "updated_desc",
  limit: 25,
  offset: 0,
  total: 0,
};
const trustZoneState = {
  limit: 12,
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

function readMemoryPageSize() {
  return Number.parseInt($("memoryPageSize")?.value || String(browserState.limit || 25), 10) || 25;
}

function readTrustZonePageSize() {
  return Number.parseInt($("trustZonePageSize")?.value || String(trustZoneState.limit || 12), 10) || 12;
}

function stepMemoryPage(direction) {
  const pageSize = readMemoryPageSize();
  browserState.limit = pageSize;
  browserState.offset = Math.max(0, browserState.offset + direction * pageSize);
}

function syncTrustZoneControls() {
  const prevButton = $("trustZonePrevButton");
  const nextButton = $("trustZoneNextButton");
  if (prevButton) prevButton.disabled = trustZoneState.offset <= 0;
  if (nextButton) nextButton.disabled = trustZoneState.offset + trustZoneState.limit >= trustZoneState.total;

  const pageStatus = $("trustZonePageStatus");
  if (!pageStatus) return;
  if (trustZoneState.total === 0) {
    pageStatus.textContent = "No results";
    return;
  }
  const pageOffset = Math.min(
    trustZoneState.offset,
    Math.max(0, trustZoneState.total - 1),
  );
  const start = pageOffset + 1;
  const end = Math.min(pageOffset + trustZoneState.limit, trustZoneState.total);
  pageStatus.textContent = `${start}-${end} of ${trustZoneState.total}`;
}

function stepTrustZonePage(direction) {
  const pageSize = readTrustZonePageSize();
  trustZoneState.limit = pageSize;
  trustZoneState.offset = Math.max(0, trustZoneState.offset + direction * pageSize);
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

function renderTrustZoneList(records) {
  const list = $("trustZoneList");
  if (!list) return;
  if (!Array.isArray(records) || records.length === 0) {
    renderEmptyState(list, "No trust-zone records matched.");
    return;
  }
  clearChildren(list);
  records.forEach((record) => {
    const article = createItem();
    const meta = document.createElement("div");
    meta.className = "meta";
    appendPill(meta, record.zone);
    appendPill(meta, record.kind);
    appendPill(meta, record.sourceClass);
    appendPill(meta, record.anchored ? "anchored" : "unanchored");
    if (record.trustScore) {
      appendPill(meta, `trust ${record.trustScore.total} (${record.trustScore.band})`);
    }
    article.appendChild(meta);

    const heading = document.createElement("h3");
    heading.style.marginTop = "10px";
    heading.textContent = record.recordId;
    article.appendChild(heading);

    const pathText = document.createElement("div");
    pathText.className = "status";
    pathText.textContent = `${record.recordedAt} · ${record.filePath}`;
    article.appendChild(pathText);

    const preview = document.createElement("p");
    preview.textContent = record.summary;
    article.appendChild(preview);

    const readiness = document.createElement("div");
    readiness.className = "status";
    if (record.nextPromotionTarget) {
      readiness.textContent = record.nextPromotionAllowed
        ? `Ready for promotion to ${record.nextPromotionTarget}.`
        : `Blocked on ${record.nextPromotionTarget}: ${(record.nextPromotionReasons || []).join("; ") || "operator review required"}`;
    } else {
      readiness.textContent = "No further promotion path.";
    }
    article.appendChild(readiness);

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    toolbar.style.marginTop = "12px";

    const inspectButton = document.createElement("button");
    inspectButton.className = "secondary";
    inspectButton.textContent = "Inspect";
    inspectButton.addEventListener("click", () => {
      $("trustZoneDetail").textContent = JSON.stringify(record, null, 2);
      setStatus("trustZoneDetailStatus", `Loaded ${record.recordId}.`, "ok");
    });
    toolbar.appendChild(inspectButton);

    if (record.nextPromotionTarget) {
      const previewButton = document.createElement("button");
      previewButton.className = "secondary";
      previewButton.textContent = `Preview → ${record.nextPromotionTarget}`;
      previewButton.addEventListener("click", () => void promoteTrustZone(record.recordId, record.nextPromotionTarget, true));
      toolbar.appendChild(previewButton);
    }

    if (record.nextPromotionTarget && record.nextPromotionAllowed) {
      const promoteButton = document.createElement("button");
      promoteButton.className = "accent";
      promoteButton.textContent = `Promote → ${record.nextPromotionTarget}`;
      promoteButton.addEventListener("click", () => void promoteTrustZone(record.recordId, record.nextPromotionTarget, false));
      toolbar.appendChild(promoteButton);
    }

    article.appendChild(toolbar);
    list.appendChild(article);
  });
}

function renderQuality(response) {
  const summary = $("qualitySummary");
  if (!summary) return;
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
  const qualityJson = $("qualityJson");
  if (qualityJson) {
    qualityJson.textContent = JSON.stringify(response, null, 2);
  }
}

async function loadMemoryBrowser(resetOffset = false) {
  if (resetOffset) browserState.offset = 0;
  browserState.sort = $("memorySort")?.value || "updated_desc";
  browserState.limit = readMemoryPageSize();
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

async function loadTrustZones(resetOffset = false) {
  if (resetOffset) trustZoneState.offset = 0;
  trustZoneState.limit = readTrustZonePageSize();
  setStatus("trustZoneStatus", "Loading trust-zone state...");
  const params = new URLSearchParams();
  const query = $("trustZoneQuery")?.value?.trim();
  const zone = $("trustZoneZone")?.value?.trim();
  const sourceClass = $("trustZoneSourceClass")?.value?.trim();
  if (query) params.set("q", query);
  if (zone) params.set("zone", zone);
  if (sourceClass) params.set("sourceClass", sourceClass);
  params.set("limit", String(trustZoneState.limit));
  params.set("offset", String(trustZoneState.offset));

  const [statusResponse, browseResponse] = await Promise.all([
    fetchJson("/engram/v1/trust-zones/status"),
    fetchJson(`/engram/v1/trust-zones/records?${params.toString()}`),
  ]);
  trustZoneState.total = browseResponse.total || 0;
  const maxOffset = trustZoneState.total > 0
    ? Math.floor((trustZoneState.total - 1) / trustZoneState.limit) * trustZoneState.limit
    : 0;
  if (!resetOffset && trustZoneState.offset > maxOffset) {
    trustZoneState.offset = maxOffset;
    return loadTrustZones(false);
  }

  renderTrustZoneList(browseResponse.records);
  syncTrustZoneControls();
  const byZone = statusResponse?.status?.records?.byZone || {};
  const zoneSummary = ["quarantine", "working", "trusted"]
    .filter((name) => typeof byZone[name] === "number")
    .map((name) => `${name} ${byZone[name]}`)
    .join(" · ");
  setStatus(
    "trustZoneStatus",
    `Loaded ${browseResponse.count} of ${browseResponse.total} trust-zone records.${zoneSummary ? ` ${zoneSummary}.` : ""}`,
    "ok",
  );
}

async function promoteTrustZone(recordId, targetZone, dryRun) {
  if (!recordId || !targetZone) return;
  setStatus("trustZoneDetailStatus", `${dryRun ? "Previewing" : "Applying"} ${targetZone} promotion for ${recordId}...`);
  const response = await fetchJson("/engram/v1/trust-zones/promote", {
    method: "POST",
    body: JSON.stringify({
      recordId,
      targetZone,
      promotionReason: dryRun
        ? `Previewed in Remnic admin console for ${recordId}.`
        : `Promoted in Remnic admin console for ${recordId}.`,
      dryRun,
    }),
  });
  $("trustZoneSeedResult").textContent = JSON.stringify(response, null, 2);
  $("trustZoneDetail").textContent = JSON.stringify(response.record, null, 2);
  await loadTrustZones(false);
  setStatus(
    "trustZoneDetailStatus",
    dryRun ? `Previewed ${targetZone} promotion for ${recordId}.` : `Applied ${targetZone} promotion for ${recordId}.`,
    "ok",
  );
}

async function seedTrustZoneDemo(dryRun) {
  if (!dryRun && typeof window.confirm === "function") {
    const confirmed = window.confirm(
      "Seed the explicit trust-zone demo dataset into the current namespace? This is opt-in demo data for buyer-facing walkthroughs.",
    );
    if (!confirmed) return;
  }
  setStatus("trustZoneStatus", dryRun ? "Previewing trust-zone demo seed..." : "Seeding trust-zone demo dataset...");
  const response = await fetchJson("/engram/v1/trust-zones/demo-seed", {
    method: "POST",
    body: JSON.stringify({
      scenario: "enterprise-buyer-v1",
      dryRun,
    }),
  });
  $("trustZoneSeedResult").textContent = JSON.stringify(response, null, 2);
  if (!dryRun) {
    await loadTrustZones(true);
  }
  setStatus(
    "trustZoneStatus",
    dryRun
      ? `Previewed ${response.records.length} trust-zone demo records.`
      : `Seeded ${response.recordsWritten} trust-zone demo records into ${response.namespace}.`,
    "ok",
  );
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
    setStatus("authStatus", "Connected to Remnic access API.", "ok");
    await Promise.allSettled([
      loadMemoryBrowser(true),
      loadTrustZones(true),
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
  if (!value) {
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
    stepMemoryPage(-1);
    void loadMemoryBrowser(false);
  });
  $("memoryNextButton")?.addEventListener("click", () => {
    stepMemoryPage(1);
    void loadMemoryBrowser(false);
  });
  $("runRecallButton")?.addEventListener("click", () => void runRecallDebugger());
  $("refreshTrustZonesButton")?.addEventListener("click", () => void loadTrustZones(true));
  $("trustZonePrevButton")?.addEventListener("click", () => {
    stepTrustZonePage(-1);
    void loadTrustZones(false);
  });
  $("trustZoneNextButton")?.addEventListener("click", () => {
    stepTrustZonePage(1);
    void loadTrustZones(false);
  });
  $("previewTrustZoneSeedButton")?.addEventListener("click", () => void seedTrustZoneDemo(true));
  $("seedTrustZoneDemoButton")?.addEventListener("click", () => void seedTrustZoneDemo(false));
  $("refreshQueueButton")?.addEventListener("click", () => void loadReviewQueue());
  $("searchEntitiesButton")?.addEventListener("click", () => void loadEntities());
  $("copyMemoryPathButton")?.addEventListener("click", copyMemoryPath);

  if (remembered) {
    void connectAndBootstrap();
  } else {
    syncBrowserControls();
    syncTrustZoneControls();
  }
}

bootstrap();
