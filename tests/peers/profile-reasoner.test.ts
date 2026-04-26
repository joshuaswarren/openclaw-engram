/**
 * Async peer profile reasoner — issue #679 PR 2/5.
 *
 * Covers:
 *   - reasoner reads log + writes profile with provenance
 *   - disabled flag is a true no-op
 *   - min-interactions guard skips peers below threshold
 *   - max-fields cap respected across peers
 *   - parser tolerates fenced code block / malformed payloads
 *   - existing peer storage tests still pass (separate file —
 *     `packages/remnic-core/src/peers/peers.test.ts` continues to run
 *     under the same `tsx --test` glob).
 *
 * All fixtures are synthetic. The repository is public; no real names,
 * sessions, or interactions appear here.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendInteractionLog,
  buildPeerProfileReasonerPrompt,
  parsePeerProfileReasonerResponse,
  readPeerProfile,
  runPeerProfileReasoner,
  writePeer,
  writePeerProfile,
  type Peer,
  type PeerProfile,
  type PeerProfileReasonerLlm,
} from "../../packages/remnic-core/src/peers/index.js";

// ──────────────────────────────────────────────────────────────────────
// Fixtures + helpers
// ──────────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "peer-reasoner-test-"));
}

function syntheticPeer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: "synthetic.alpha",
    kind: "agent",
    displayName: "Synthetic Alpha",
    createdAt: "2026-04-25T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    ...overrides,
  };
}

/** Mock LLM that returns a fixed JSON payload. */
function fakeLlm(payload: string): {
  llm: PeerProfileReasonerLlm;
  calls: number;
} {
  const state = { calls: 0 };
  const llm: PeerProfileReasonerLlm = {
    async chatCompletion() {
      state.calls += 1;
      return { content: payload };
    },
  };
  return {
    llm,
    get calls() {
      return state.calls;
    },
  } as { llm: PeerProfileReasonerLlm; calls: number };
}

/** Append N synthetic interaction-log entries spanning T+0..T+N-1 minutes. */
async function seedLog(
  memoryDir: string,
  peerId: string,
  count: number,
  prefix = "synthetic-interaction",
): Promise<void> {
  const base = Date.UTC(2026, 3, 25, 12, 0, 0);
  for (let i = 0; i < count; i += 1) {
    await appendInteractionLog(memoryDir, peerId, {
      timestamp: new Date(base + i * 60_000).toISOString(),
      kind: "message",
      sessionId: `synthetic-session-${i}`,
      summary: `${prefix} ${i}`,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// 1. Happy path — log → LLM → profile with provenance
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner reads log and writes profile with provenance", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.writer", kind: "agent" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 6);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [
        {
          field: "communication_style",
          value: "concise, prefers structured replies",
          signal: "explicit_preference",
          note: "derived from synthetic recurrence",
          sourceSessionId: "synthetic-session-2",
        },
      ],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 3,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  assert.equal(result.peersConsidered, 1);
  assert.equal(result.peersProcessed, 1);
  assert.equal(result.fieldsApplied, 1);
  assert.equal(result.perPeer[0].status, "processed");
  assert.deepEqual(result.perPeer[0].fields, ["communication_style"]);

  const profile = await readPeerProfile(dir, peer.id);
  assert.ok(profile, "profile should be written");
  assert.equal(profile.peerId, peer.id);
  assert.equal(profile.fields.communication_style, "concise, prefers structured replies");
  assert.equal(profile.updatedAt, "2026-04-26T00:00:00.000Z");
  const prov = profile.provenance.communication_style;
  assert.ok(prov && prov.length === 1);
  assert.equal(prov[0].observedAt, "2026-04-26T00:00:00.000Z");
  assert.equal(prov[0].signal, "explicit_preference");
  assert.equal(prov[0].sourceSessionId, "synthetic-session-2");
  assert.equal(prov[0].note, "derived from synthetic recurrence");
});

test("runPeerProfileReasoner appends to existing provenance instead of replacing", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.beta" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const existing: PeerProfile = {
    peerId: peer.id,
    updatedAt: "2026-04-25T12:00:00.000Z",
    fields: { communication_style: "old value" },
    provenance: {
      communication_style: [
        {
          observedAt: "2026-04-25T12:00:00.000Z",
          signal: "manual_seed",
        },
      ],
    },
  };
  await writePeerProfile(dir, existing);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [
        {
          field: "communication_style",
          value: "new value",
          signal: "explicit_preference",
        },
      ],
    }),
  );

  await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  const profile = await readPeerProfile(dir, peer.id);
  assert.ok(profile);
  assert.equal(profile.fields.communication_style, "new value");
  // Existing provenance preserved + new entry appended.
  assert.equal(profile.provenance.communication_style.length, 2);
  assert.equal(profile.provenance.communication_style[0].signal, "manual_seed");
  assert.equal(profile.provenance.communication_style[1].signal, "explicit_preference");
});

// ──────────────────────────────────────────────────────────────────────
// 2. Disabled flag — true no-op
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner is a no-op when enabled=false", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.disabled" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 10);

  const { llm } = fakeLlm("{}");

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: false,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
  });

  assert.equal(result.peersConsidered, 0);
  assert.equal(result.peersProcessed, 0);
  assert.equal(result.fieldsApplied, 0);
  // The mock LLM must not have been called.
  assert.equal((llm as unknown as { calls: number }).calls ?? 0, 0);

  // No profile written.
  const profile = await readPeerProfile(dir, peer.id);
  assert.equal(profile, null);
});

test("runPeerProfileReasoner stays a no-op when enabled is a truthy non-boolean string", async () => {
  // Defensive — Gotcha #36: `"false"` is truthy in JS. The reasoner
  // requires strict `=== true`. Pass any non-boolean value and verify
  // it's still treated as disabled.
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.gamma" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [
        { field: "should_not_apply", value: "x", signal: "x" },
      ],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    // @ts-expect-error — intentionally invalid to exercise the strict check
    enabled: "true",
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
  });

  assert.equal(result.peersConsidered, 0);
  assert.equal(result.fieldsApplied, 0);
  const profile = await readPeerProfile(dir, peer.id);
  assert.equal(profile, null);
});

// ──────────────────────────────────────────────────────────────────────
// 3. Min-interactions guard
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner skips peers below the min-interactions threshold", async () => {
  const dir = await makeTempDir();
  const lowVolume = syntheticPeer({ id: "synthetic.low" });
  const highVolume = syntheticPeer({ id: "synthetic.high" });
  await writePeer(dir, lowVolume);
  await writePeer(dir, highVolume);
  await seedLog(dir, lowVolume.id, 2);
  await seedLog(dir, highVolume.id, 8);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [
        {
          field: "tool_patterns",
          value: "frequent search usage",
          signal: "tool_recurrence",
        },
      ],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 5,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  // Both peers considered; only the high-volume one was processed.
  assert.equal(result.peersConsidered, 2);
  assert.equal(result.peersProcessed, 1);
  const lowResult = result.perPeer.find((r) => r.peerId === lowVolume.id);
  const highResult = result.perPeer.find((r) => r.peerId === highVolume.id);
  assert.equal(lowResult?.status, "skipped_below_min_interactions");
  assert.equal(highResult?.status, "processed");
  assert.equal(highResult?.fieldsApplied, 1);

  // Low-volume peer's profile was NOT written.
  assert.equal(await readPeerProfile(dir, lowVolume.id), null);
  // High-volume peer's profile WAS written.
  assert.notEqual(await readPeerProfile(dir, highVolume.id), null);
});

test("runPeerProfileReasoner skips peers with no interaction log", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.empty" });
  await writePeer(dir, peer);

  const { llm } = fakeLlm("{}");

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 0,
    maxFieldsPerRun: 4,
  });

  assert.equal(result.peersConsidered, 1);
  assert.equal(result.peersProcessed, 0);
  assert.equal(result.perPeer[0].status, "skipped_no_log");
});

// ──────────────────────────────────────────────────────────────────────
// 4. Max-fields cap
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner respects maxFieldsPerRun across peers", async () => {
  const dir = await makeTempDir();
  const a = syntheticPeer({ id: "synthetic.aaa" });
  const b = syntheticPeer({ id: "synthetic.bbb" });
  await writePeer(dir, a);
  await writePeer(dir, b);
  await seedLog(dir, a.id, 5);
  await seedLog(dir, b.id, 5);

  // Each peer gets a fake LLM proposing TWO fields. With cap=2 total,
  // peer A should consume the budget and peer B should be skipped or
  // have its proposals dropped.
  const proposalsPayload = JSON.stringify({
    proposals: [
      { field: "field_one", value: "v1", signal: "signal_one" },
      { field: "field_two", value: "v2", signal: "signal_two" },
    ],
  });
  const { llm } = fakeLlm(proposalsPayload);

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 2,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  assert.equal(result.peersConsidered, 2);
  assert.equal(result.fieldsApplied, 2);
  // Listing order for peers is alphabetical (listPeers sorts), so 'a'
  // is processed first.
  const aResult = result.perPeer.find((r) => r.peerId === a.id);
  const bResult = result.perPeer.find((r) => r.peerId === b.id);
  assert.equal(aResult?.fieldsApplied, 2);
  assert.equal(bResult?.fieldsApplied, 0);
  assert.equal(bResult?.status, "skipped_cap_reached");
});

test("runPeerProfileReasoner with maxFieldsPerRun=0 is a no-op", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.cap0" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [{ field: "any_field", value: "v", signal: "s" }],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 0,
  });

  assert.equal(result.fieldsApplied, 0);
  assert.equal(await readPeerProfile(dir, peer.id), null);
});

// ──────────────────────────────────────────────────────────────────────
// 5. Parser robustness
// ──────────────────────────────────────────────────────────────────────

test("parsePeerProfileReasonerResponse handles fenced code blocks", () => {
  const parsed = parsePeerProfileReasonerResponse(
    '```json\n{"proposals":[{"field":"k","value":"v","signal":"s"}]}\n```',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].field, "k");
});

test("parsePeerProfileReasonerResponse rejects malformed JSON", () => {
  assert.deepEqual(parsePeerProfileReasonerResponse(""), []);
  assert.deepEqual(parsePeerProfileReasonerResponse("not-json"), []);
  assert.deepEqual(parsePeerProfileReasonerResponse("null"), []);
  assert.deepEqual(parsePeerProfileReasonerResponse("[1,2,3]"), []);
});

test("parsePeerProfileReasonerResponse drops proposals missing required fields", () => {
  const raw = JSON.stringify({
    proposals: [
      { field: "", value: "v", signal: "s" }, // empty field
      { field: "k", value: "", signal: "s" }, // empty value
      { field: "k", value: "v", signal: "" }, // empty signal
      { field: "__proto__", value: "v", signal: "s" }, // prototype-pollution
      { field: "k", value: "v", signal: "s" }, // valid
    ],
  });
  const parsed = parsePeerProfileReasonerResponse(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].field, "k");
});

test("parsePeerProfileReasonerResponse rejects non-object root", () => {
  assert.deepEqual(parsePeerProfileReasonerResponse("42"), []);
  assert.deepEqual(parsePeerProfileReasonerResponse('"a string"'), []);
});

test("buildPeerProfileReasonerPrompt produces a deterministic, schema-prescriptive prompt", () => {
  const prompt = buildPeerProfileReasonerPrompt({
    peer: syntheticPeer({ id: "synthetic.prompt" }),
    existingProfile: null,
    log: [
      {
        timestamp: "2026-04-25T12:00:00.000Z",
        kind: "message",
        sessionId: "synthetic-session-7",
        summary: "synthetic interaction body",
      },
    ],
    maxFields: 3,
  });
  assert.match(prompt, /synthetic\.prompt/);
  assert.match(prompt, /Output a single JSON object/);
  assert.match(prompt, /synthetic-session-7/);
  assert.match(prompt, /maxFields|0\.\.3|0..3/);
});

// ──────────────────────────────────────────────────────────────────────
// 6. LLM unavailable / abort
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner records skipped_llm_unavailable on null response", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.nullresp" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const llm: PeerProfileReasonerLlm = {
    async chatCompletion() {
      return null;
    },
  };

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
  });

  assert.equal(result.fieldsApplied, 0);
  assert.equal(result.perPeer[0].status, "skipped_llm_unavailable");
});

test("runPeerProfileReasoner records skipped_aborted when signal is aborted", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.aborted" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const controller = new AbortController();
  controller.abort();

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [{ field: "k", value: "v", signal: "s" }],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
    signal: controller.signal,
  });

  assert.equal(result.fieldsApplied, 0);
  assert.equal(result.perPeer[0].status, "skipped_aborted");
});

// ──────────────────────────────────────────────────────────────────────
// 7. Run-marker effect on subsequent runs
// ──────────────────────────────────────────────────────────────────────

test("run-marker counts interactions since previous reasoner run", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.marker" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const payload = JSON.stringify({
    proposals: [{ field: "k", value: "v", signal: "s" }],
  });
  const { llm } = fakeLlm(payload);

  // First run — applies field, writes a run marker into the log.
  const first = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: true,
  });
  assert.equal(first.fieldsApplied, 1);

  // Second run with NO new interactions — should skip due to threshold,
  // because the run marker now represents "0 new interactions since last run".
  const second = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T01:00:00.000Z"),
    appendRunMarkerToLog: true,
  });
  assert.equal(second.peersProcessed, 0);
  assert.equal(
    second.perPeer[0].status,
    "skipped_below_min_interactions",
  );
});
