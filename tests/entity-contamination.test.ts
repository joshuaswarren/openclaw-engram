/**
 * Cross-entity contamination test suite (issue #682 PR 2/3).
 *
 * Each test corresponds to a risk row from
 * `docs/security/entity-isolation-audit.md`. The suite is intentionally
 * permissive about the *current* shape of the contamination — some risks
 * are documented as designed (R-3, R-5) and the matching tests assert the
 * *current* behavior so a future fix that changes the surface area trips
 * the test loudly. Other risks (R-9, R-10) assert the desired isolation
 * invariant so the test fails today and is fixed in PR 3/3.
 *
 * All entity / project / person names are SYNTHETIC per the project's
 * PUBLIC repo policy (see CLAUDE.md). Names follow the `*-A1` / `*-B1`
 * fake-fixture convention.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";

import { parseConfig } from "../src/config.js";
import { buildEntityRecallSection } from "../src/entity-retrieval.js";
import { StorageManager, normalizeEntityName } from "../src/storage.js";
import { focusMatchesMemory, parseBriefingFocus } from "../src/briefing.js";
import {
  DIRECT_ANSWER_FILTER_LABELS as FILTER_LABELS,
  isDirectAnswerEligible,
  extractGraphEdges,
  findDuplicates,
  runGraphRecall,
  type DirectAnswerCandidate,
  type DirectAnswerConfig,
  type MemoryEdgeSource,
} from "@remnic/core";
import type { MemoryFile, PluginConfig, TranscriptEntry } from "../src/types.js";

// ── Harness ────────────────────────────────────────────────────────────

async function buildHarness(prefix: string) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-memory-`));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-workspace-`));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    sharedContextEnabled: false,
    hourlySummariesEnabled: false,
    transcriptEnabled: true,
    nativeKnowledge: {
      enabled: false,
      includeFiles: ["IDENTITY.md", "MEMORY.md", "USER.md"],
      maxChunkChars: 400,
      maxResults: 5,
      maxChars: 1600,
      stateDir: "state/native-knowledge",
      obsidianVaults: [],
    },
  });
  const storage = new StorageManager(memoryDir, config.entitySchemas);
  await storage.ensureDirectories();
  return { memoryDir, workspaceDir, config, storage };
}

async function buildSection(
  config: PluginConfig,
  storage: StorageManager,
  query: string,
  transcriptEntries: TranscriptEntry[] = [],
) {
  return buildEntityRecallSection({
    config,
    storage,
    query,
    recentTurns: 6,
    maxHints: 4,
    maxSupportingFacts: 6,
    maxRelatedEntities: 3,
    maxChars: 4000,
    transcriptEntries,
  });
}

const DIRECT_ANSWER_CONFIG: DirectAnswerConfig = {
  enabled: true,
  tokenOverlapFloor: 0.4,
  importanceFloor: 0.7,
  ambiguityMargin: 0.15,
  eligibleTaxonomyBuckets: ["decisions", "principles", "conventions", "runbooks", "entities"],
};

function makeMemory(overrides: {
  id?: string;
  content?: string;
  tags?: string[];
  entityRef?: string;
  status?: MemoryFile["frontmatter"]["status"];
  verificationState?: MemoryFile["frontmatter"]["verificationState"];
} = {}): MemoryFile {
  const id = overrides.id ?? "mem-test";
  return {
    path: `/memory/${id}.md`,
    frontmatter: {
      id,
      category: "decision",
      created: "2026-04-25T00:00:00.000Z",
      updated: "2026-04-25T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: overrides.tags ?? [],
      status: overrides.status,
      verificationState: overrides.verificationState,
      entityRef: overrides.entityRef,
    },
    content: overrides.content ?? "test content",
  };
}

function makeCandidate(overrides: Partial<DirectAnswerCandidate> & { memory: MemoryFile }): DirectAnswerCandidate {
  // Use `in` instead of `??` so callers can pass an explicit `null` for
  // the nullable fields without it being clobbered by the default. The
  // existing `direct-answer.test.ts` follows the same pattern.
  return {
    memory: overrides.memory,
    trustZone: "trustZone" in overrides ? overrides.trustZone ?? null : "trusted",
    taxonomyBucket:
      "taxonomyBucket" in overrides ? overrides.taxonomyBucket ?? null : "entities",
    importanceScore: overrides.importanceScore ?? 0.9,
    matchScore: overrides.matchScore,
  };
}

// ──────────────────────────────────────────────────────────────────────
// R-1: same display name + same type — silent overwrite in entity index
// ──────────────────────────────────────────────────────────────────────

test("R-1: writeEntity collapses same-name same-type entities to one canonical id (documented)", async () => {
  const { storage } = await buildHarness("contam-r1");

  // Two distinct logical people, same display name, same type. Storage
  // fuzzy-match collapses them; the audit doc identifies this as a write-side
  // collapse risk. Verify storage exposes a single entity, not two.
  await storage.writeEntity("Alice-Test", "person", [
    "Alice-Test-A1 works on Project-A1.",
  ]);
  await storage.writeEntity("Alice-Test", "person", [
    "Alice-Test-B1 lives in Continent-B1.",
  ]);

  const entities = await storage.readAllEntityFiles();
  const aliceEntries = entities.filter(
    (entity) => normalizeEntityName(entity.name, entity.type) === "person-alice-test",
  );

  // Both write attempts must collapse to a SINGLE on-disk entity. The
  // contamination is "facts about two different people end up in one file";
  // the test asserts the collapse happens (so PR 3 can decide whether to
  // surface a write-time warning, not whether to ban same-name writes).
  assert.equal(
    aliceEntries.length,
    1,
    "two same-name same-type writes must collapse via fuzzy match",
  );
  assert.equal(
    aliceEntries[0]!.facts.length,
    2,
    "both fact bodies merged into the surviving entity file",
  );
});

// ──────────────────────────────────────────────────────────────────────
// R-2: alias merge collapses distinct entities at index-build time
// ──────────────────────────────────────────────────────────────────────

// PINNED CURRENT BEHAVIOR (bug). `scoreAliasMatch` uses token overlap
// via `tokenize`, so a query token "Person-A1" partially overlaps the
// "Person" token shared by every Person-* alias. The current bug: two
// distinct same-prefix entities BOTH get returned. PR 3 inverts this
// assertion (`doesNotMatch`) and tightens `scoreAliasMatch` so the
// inverted assertion passes. Per Codex review, we pin the current
// behavior with a `match` assertion rather than `todo` so CI cannot
// silently regress in the same direction.
test("R-2 (pinned bug): query for Person-B1 also surfaces Person-A1 due to shared 'person' token", async () => {
  const { config, storage } = await buildHarness("contam-r2");

  await storage.writeEntity("Person-A1", "person", [
    "Person-A1 owns Project-A1.",
    "Person-A1 prefers async standups.",
  ]);
  await storage.writeEntity("Person-B1", "person", [
    "Person-B1 owns Project-B1.",
  ]);
  const personA1Canonical = normalizeEntityName("Person-A1", "person");
  await storage.addEntityAlias(personA1Canonical, "PA1");

  await storage.writeMemory(
    "fact",
    "Person-A1 confirmed ownership of Project-A1 in retro.",
    { entityRef: personA1Canonical, confidence: 0.95 },
  );

  const sectionForB = await buildSection(config, storage, "Who is Person-B1?");
  assert.ok(sectionForB);
  // Person-B1 is correctly resolved as a target.
  assert.match(sectionForB!, /target: Person-B1 \(person\)/);
  // BUG: Person-A1 also appears as a target. PR 3 will invert this to
  // `doesNotMatch` and apply the alias-scoring tightening fix.
  assert.match(
    sectionForB!,
    /target: Person-A1 \(person\)/,
    "R-2 bug today: query for Person-B1 surfaces Person-A1 due to shared 'person' token",
  );
});

// ──────────────────────────────────────────────────────────────────────
// R-3: recent-turn alias drag picks wrong entity for pronoun queries
// ──────────────────────────────────────────────────────────────────────

// PINNED CURRENT BEHAVIOR (bug). Same root cause as R-2 — partial-token
// alias scoring surfaces both Person-A1 and Person-B1 on a pronoun
// query because both entries share the "person" token from prior
// transcript turns. PR 3 inverts the assertion and applies the fix.
test("R-3 (pinned bug): pronoun query surfaces both transcript entities (alias token leak)", async () => {
  const { config, storage } = await buildHarness("contam-r3");

  await storage.writeEntity("Person-A1", "person", [
    "Person-A1 prefers vegetarian meals.",
  ]);
  await storage.writeEntity("Person-B1", "person", [
    "Person-B1 prefers spicy food.",
  ]);

  // Transcript: Person-A1 mentioned first, Person-B1 mentioned second.
  // A pronoun query "what does she prefer?" should pick Person-B1 (most
  // recent). This is documented as designed in the audit (R-3).
  const transcript: TranscriptEntry[] = [
    {
      role: "user",
      content: "Tell me about Person-A1",
      timestamp: "2026-04-25T10:00:00.000Z",
      sessionKey: "s",
      turnId: "t1",
    },
    {
      role: "assistant",
      content: "Person-A1 is on the team.",
      timestamp: "2026-04-25T10:00:01.000Z",
      sessionKey: "s",
      turnId: "t2",
    },
    {
      role: "user",
      content: "and Person-B1?",
      timestamp: "2026-04-25T10:00:02.000Z",
      sessionKey: "s",
      turnId: "t3",
    },
    {
      role: "assistant",
      content: "Person-B1 also on the team.",
      timestamp: "2026-04-25T10:00:03.000Z",
      sessionKey: "s",
      turnId: "t4",
    },
  ];
  const section = await buildSection(
    config,
    storage,
    "what does she prefer?",
    transcript,
  );

  // PINNED bug: a pronoun query produces a hint section that resolves
  // BOTH Person-A1 and Person-B1 as separate targets. PR 3 inverts these
  // to assert exactly one target (B1) and applies the fix.
  assert.ok(section, "pronoun query must produce a hint section");
  assert.match(
    section!,
    /target: Person-A1 \(person\)/,
    "R-3 bug today: Person-A1 surfaces as a target alongside Person-B1",
  );
  assert.match(
    section!,
    /target: Person-B1 \(person\)/,
    "Person-B1 also surfaces (correctly — most recent)",
  );
});

// ──────────────────────────────────────────────────────────────────────
// R-4: alias substring match across letter/digit boundaries
// ──────────────────────────────────────────────────────────────────────

test("R-4: short alias does not match longer alphanumeric token in query", async () => {
  const { config, storage } = await buildHarness("contam-r4");

  // Two entities: "A1" (alias "A1") and a project "A12".
  await storage.writeEntity("Project-A1", "project", [
    "Project-A1 launched in March.",
  ]);
  const projectA1 = normalizeEntityName("Project-A1", "project");
  await storage.addEntityAlias(projectA1, "A1");

  await storage.writeEntity("Project-A12", "project", [
    "Project-A12 is in design phase.",
  ]);
  const projectA12 = normalizeEntityName("Project-A12", "project");
  await storage.addEntityAlias(projectA12, "A12");

  // Query about "A12" must NOT surface Project-A1 just because "A1" is a
  // prefix of "A12". Section MUST exist (Project-A12's alias matches),
  // and the surfaced content must be Project-A12's, not A1's.
  const section = await buildSection(config, storage, "tell me about A12");
  assert.ok(section, "query for A12 must produce an entity hint section");
  assert.match(
    section!,
    /target: Project-A12 \(project\)/,
    "Project-A12 should be the resolved target",
  );
  assert.doesNotMatch(
    section!,
    /Project-A1 launched in March/,
    "alias 'A1' must not match query token 'A12'",
  );
  assert.doesNotMatch(
    section!,
    /target: Project-A1 \(project\)/,
    "Project-A1 must not appear as a separate target for query 'A12'",
  );
});

// ──────────────────────────────────────────────────────────────────────
// R-5: untagged memories pass direct-answer entity filter (documented)
// ──────────────────────────────────────────────────────────────────────

test("R-5: direct-answer passes through memories with no entityRef even when query has hints (documented)", () => {
  // Documented as designed: untagged general knowledge passes through
  // entity-scoped queries. The test pins the current behavior so a future
  // fix that flips it (e.g. require entityRef for entity-scoped queries)
  // is a deliberate change, not an accidental one.
  const memoryWithoutRef = makeMemory({
    id: "untagged-1",
    content: "general knowledge fact about token policy",
    entityRef: undefined,
  });
  const result = isDirectAnswerEligible({
    query: "what is the token policy",
    candidates: [makeCandidate({ memory: memoryWithoutRef, importanceScore: 0.9 })],
    config: DIRECT_ANSWER_CONFIG,
    queryEntityRefs: ["person-alice-test"],
  });
  assert.ok(
    !result.filteredBy.includes(FILTER_LABELS.entityRefMismatch),
    "untagged memories should pass through the entityRef filter (documented behavior)",
  );
});

test("R-5b: direct-answer DOES filter mismatched entityRef when both are tagged", () => {
  const aliceMemory = makeMemory({
    id: "alice-1",
    content: "Alice-Test prefers async standups",
    entityRef: "person-alice-test",
  });
  const bobMemory = makeMemory({
    id: "bob-1",
    content: "Bob-B1 prefers sync standups",
    entityRef: "person-bob-b1",
  });
  const result = isDirectAnswerEligible({
    query: "what does Alice-Test prefer",
    candidates: [
      makeCandidate({ memory: aliceMemory }),
      makeCandidate({ memory: bobMemory }),
    ],
    config: DIRECT_ANSWER_CONFIG,
    queryEntityRefs: ["person-alice-test"],
  });
  assert.ok(
    result.filteredBy.includes(FILTER_LABELS.entityRefMismatch),
    "direct-answer must filter Bob's memory when query is scoped to Alice",
  );
});

// ──────────────────────────────────────────────────────────────────────
// R-6: direct-answer filter case-only normalization
// ──────────────────────────────────────────────────────────────────────

test("R-6: direct-answer entityRef filter is case-insensitive but not slug-tolerant", () => {
  // Memory stores entityRef in slug form `person-alice-test`. A hint passed
  // in display-name form `Alice Test` would NOT match — only the slug form
  // matches. This is the asymmetry called out in the audit.
  const memory = makeMemory({
    entityRef: "person-alice-test",
    content: "Alice-Test prefers async standups",
  });
  const candidate = makeCandidate({ memory });

  // Case-insensitive equality on slug form: matches.
  const matched = isDirectAnswerEligible({
    query: "what does Alice-Test prefer",
    candidates: [candidate],
    config: DIRECT_ANSWER_CONFIG,
    queryEntityRefs: ["PERSON-ALICE-TEST"],
  });
  assert.ok(
    !matched.filteredBy.includes(FILTER_LABELS.entityRefMismatch),
    "uppercase slug hint should match lowercase stored slug",
  );

  // Display-name form does NOT match the stored slug — documented asymmetry.
  const displayNameOnly = isDirectAnswerEligible({
    query: "what does Alice-Test prefer",
    candidates: [candidate],
    config: DIRECT_ANSWER_CONFIG,
    queryEntityRefs: ["Alice Test"],
  });
  assert.ok(
    displayNameOnly.filteredBy.includes(FILTER_LABELS.entityRefMismatch),
    "display-name hint does NOT match stored slug — known asymmetry (R-6)",
  );
});

// ──────────────────────────────────────────────────────────────────────
// R-7: graph PPR seed pollution — wrong-entity seed boosts other-entity memories
// ──────────────────────────────────────────────────────────────────────

test("R-7: graph PPR result shape does not expose seed provenance (under-attribution risk)", () => {
  // Documented under-attribution risk: PPR returns memory ids ranked by
  // score; the result shape does NOT carry a back-reference to "which
  // seed pulled this memory in." Build a memory pool with `derived-from`
  // edges so PPR's projection step actually surfaces memory results we
  // can introspect — checking the SHAPE of a self-constructed sample
  // would be a tautology (per cursor / codex review).
  const memories: MemoryEdgeSource[] = [
    {
      id: "mem-b1-old",
      content: "Person-B1 owned Project-B1 in 2025.",
      entityRef: "person-person-b1",
    },
    {
      id: "mem-b1-new",
      content: "Person-B1 owns Project-B1 in 2026.",
      entityRef: "person-person-b1",
      supersedes: "mem-b1-old",
    },
    {
      id: "mem-a1",
      content: "Person-A1 owns Project-A1.",
      entityRef: "person-person-a1",
    },
  ];

  // Seed with B1's memory id directly — PPR will personalize the random
  // walk on this seed so memory-typed neighbors of mem-b1-new are
  // surfaced.
  const run = runGraphRecall(
    {
      recallGraphEnabled: true,
      recallGraphDamping: 0.85,
      recallGraphIterations: 20,
      recallGraphTopK: 5,
    },
    {
      memories,
      seedIds: ["mem-b1-new"],
    },
  );

  assert.equal(run.ran, true);
  assert.ok(
    run.results.length > 0,
    "memory-seeded PPR must surface memory-typed results so the shape assertion exercises real output",
  );

  // Assert on EACH actual result returned by runGraphRecall — the audit
  // claim ("results carry no seed provenance") is verified against the
  // real return value, not a self-constructed mock.
  for (const result of run.results) {
    const keys = Object.keys(result).sort();
    assert.deepEqual(
      keys,
      ["id", "score"],
      `R-7: GraphRecallResult exposes only {id, score}; got ${JSON.stringify(keys)} for ${result.id}`,
    );
    assert.equal(
      "seedId" in result,
      false,
      "no per-result seed back-reference",
    );
    assert.equal(
      "seedIds" in result,
      false,
      "no per-result seed back-reference",
    );
    assert.equal(
      "seedProvenance" in result,
      false,
      "no per-result seed provenance field",
    );
  }
});

// ──────────────────────────────────────────────────────────────────────
// R-8: graph entity-node id collision when refs not normalized
// ──────────────────────────────────────────────────────────────────────

test("R-8: graph extractor treats normalized and un-normalized entity refs as different nodes", () => {
  // Two memories about the same logical person. One uses the slug form,
  // the other uses the display-name form. The graph extractor preserves
  // them as opaque strings, producing two separate entity nodes.
  const memories: MemoryEdgeSource[] = [
    {
      id: "mem-slug",
      content: "Alice-Test confirmed Project-A1 ownership.",
      entityRef: "person-alice-test",
    },
    {
      id: "mem-display",
      content: "Alice-Test scheduled the launch review.",
      entityRef: "person:Alice-Test",
    },
  ];
  const { nodes, edges } = extractGraphEdges(memories);

  // Both entity ids appear as separate entity nodes — the documented
  // under-recall risk in R-8.
  const entityNodes = [...nodes.values()].filter((node) => node.type === "entity");
  const ids = new Set(entityNodes.map((node) => node.id));
  assert.ok(
    ids.has("person-alice-test") && ids.has("person:Alice-Test"),
    "extractor preserves both forms — no canonicalization happens here",
  );
  // Each memory only `mentions` its own entityRef.
  const slugMention = edges.find((edge) => edge.from === "mem-slug" && edge.type === "mentions");
  const displayMention = edges.find((edge) => edge.from === "mem-display" && edge.type === "mentions");
  assert.equal(slugMention?.to, "person-alice-test");
  assert.equal(displayMention?.to, "person:Alice-Test");
});

// ──────────────────────────────────────────────────────────────────────
// R-9: multi-entity chunk citation attribution
// ──────────────────────────────────────────────────────────────────────

test("R-9: multi-entity chunk graph extractor preserves all referenced entities", () => {
  // Layer 1: graph extractor — a memory with `entityRef` + `entityRefs[]`
  // produces `mentions` edges to every referenced entity, so graph-tier
  // recall can attribute the chunk to each.
  const memories: MemoryEdgeSource[] = [
    {
      id: "mem-multi",
      content: "Person-A1 introduced Person-B1 to Project-A1.",
      entityRef: "person-person-a1",
      entityRefs: ["person-person-b1", "project-project-a1"],
    },
  ];
  const { edges } = extractGraphEdges(memories);
  const mentionTargets = new Set(
    edges.filter((edge) => edge.type === "mentions").map((edge) => edge.to),
  );
  assert.ok(mentionTargets.has("person-person-a1"));
  assert.ok(mentionTargets.has("person-person-b1"));
  assert.ok(mentionTargets.has("project-project-a1"));
});

test("R-9 (attribution surface): multi-entity chunk attributes via primary entityRef only on focus match", () => {
  // Layer 2: actual attribution surface — `focusMatchesMemory` reads
  // ONLY `frontmatter.entityRef` (not `entityRefs[]`) for slug-form
  // matching. A focus on a *secondary* entity matches via content/tags,
  // not via the structured entity reference. This is the "primary
  // entityRef wins" attribution gap from the audit's R-9.
  const multiEntityMemory = makeMemory({
    entityRef: "person-person-a1", // primary attribution
    tags: [],
    content: "Person-A1 introduced Person-B1 to Project-A1.",
  });
  // Add `entityRefs` to frontmatter directly (simulating extraction-time
  // tagging of secondary entities).
  (multiEntityMemory.frontmatter as Record<string, unknown>).entityRefs = [
    "person-person-b1",
    "project-project-a1",
  ];

  const focusOnA1 = parseBriefingFocus("person:Person-A1");
  const focusOnB1 = parseBriefingFocus("person:Person-B1");
  assert.ok(focusOnA1);
  assert.ok(focusOnB1);

  // Primary attribution: focus on A1 matches via slug entityRef.
  assert.equal(focusMatchesMemory(multiEntityMemory, focusOnA1!), true);

  // Secondary attribution: focus on B1 matches today only because the
  // CONTENT contains "Person-B1", NOT because frontmatter.entityRefs
  // includes it. Strip the content to prove the attribution surface
  // ignores `entityRefs[]`.
  const noContentMemory = makeMemory({
    entityRef: "person-person-a1",
    content: "internal: redacted",
  });
  (noContentMemory.frontmatter as Record<string, unknown>).entityRefs = [
    "person-person-b1",
    "project-project-a1",
  ];
  assert.equal(
    focusMatchesMemory(noContentMemory, focusOnB1!),
    false,
    "R-9 attribution gap: focusMatchesMemory does NOT consult frontmatter.entityRefs[]",
  );
});

// ──────────────────────────────────────────────────────────────────────
// R-10: briefing focus substring match leaks across entity prefixes
// ──────────────────────────────────────────────────────────────────────
// PINNED CURRENT BEHAVIOR (bug). `focusMatchesMemory` uses
// `entityRef.includes(slug)`, a substring test, so a focus on
// `person:Alice-Test` matches both `person-alice-test` and
// `person-alice-test-a1`. PR 3 inverts the second assertion and switches
// to a slug-boundary-aware match.
test("R-10 (pinned bug): focusMatchesMemory substring-matches entityRef prefix across distinct entities", () => {
  // Memory tagged to entity-prefix-a1 must not match a focus on entity-prefix.
  // Today the function uses `entityRef.includes(slug)`, so a focus on
  // `person:Alice-Test` matches both `person-alice-test` AND
  // `person-alice-test-a1`. This test is RED today — it documents the
  // contamination and PR 3 fixes it.

  const memoryAlice = makeMemory({
    entityRef: "person-alice-test",
    content: "Alice-Test prefers async standups",
  });
  const memoryAliceA1 = makeMemory({
    entityRef: "person-alice-test-a1",
    content: "Alice-Test-A1 lives in Continent-A1",
  });
  const focus = parseBriefingFocus("person:Alice-Test");
  assert.ok(focus);

  // Person Alice-Test should match — exact slug.
  assert.equal(
    focusMatchesMemory(memoryAlice, focus!),
    true,
    "focus on Alice-Test should match memory tagged person-alice-test",
  );

  // PINNED bug: today the substring check matches the prefix, so
  // memoryAliceA1 (a distinct entity) ALSO matches. PR 3 inverts to
  // assert `false` and fixes the substring to a slug-boundary match.
  assert.equal(
    focusMatchesMemory(memoryAliceA1, focus!),
    true,
    "R-10 bug today: focus on Alice-Test substring-matches person-alice-test-a1",
  );
});

// ──────────────────────────────────────────────────────────────────────
// R-11: correction `entityRef` parsing does not normalize
// ──────────────────────────────────────────────────────────────────────

test("R-11: calibration's correction parser extracts entityRef verbatim, not canonicalized", async () => {
  // Per Codex review: drive this test through the actual calibration.ts
  // parsing path, not just storage round-trip. We write a real correction
  // markdown file under `<memoryDir>/corrections/` (the directory
  // calibration.ts:88 scans) and apply the same regex calibration uses
  // (`/^entityRef:\s*(.+)$/m`, calibration.ts:145) to confirm it extracts
  // the verbatim display-name value with no canonicalization.
  const { memoryDir } = await buildHarness("contam-r11");
  const correctionsDir = path.join(memoryDir, "corrections");
  await mkdir(correctionsDir, { recursive: true });

  const correctionPath = path.join(correctionsDir, "correction-r11.md");
  // Display-name form (NOT slug). Calibration's regex captures the line
  // verbatim, so downstream consumers comparing against the canonical id
  // `person-alice-test` will not match.
  const correctionBody = [
    "---",
    "id: correction-r11",
    "category: correction",
    "confidence: 0.95",
    "entityRef: Alice Test",
    "---",
    "the user prefers async standups, not sync ones",
    "",
  ].join("\n");
  await writeFile(correctionPath, correctionBody, "utf-8");

  // Inline the EXACT regex calibration.ts:145–146 uses, against the file
  // contents we just wrote. Asserting the parse output proves R-11
  // directly: calibration sees "Alice Test" verbatim, not the canonical
  // "person-alice-test".
  const raw = await readFile(correctionPath, "utf-8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(fmMatch);
  const entityMatch = fmMatch![1].match(/^entityRef:\s*(.+)$/m);
  assert.ok(entityMatch);
  const parsedEntityRef = entityMatch![1].trim();

  // R-11: the parser produces the verbatim display name.
  assert.equal(
    parsedEntityRef,
    "Alice Test",
    "calibration's regex captures the display-name form verbatim",
  );
  // The canonical form is different — any downstream consumer comparing
  // against `normalizeEntityName(...)` output will silently miss this
  // correction.
  const canonical = normalizeEntityName("Alice-Test", "person");
  assert.equal(canonical, "person-alice-test");
  assert.notEqual(
    parsedEntityRef,
    canonical,
    "R-11: parsed entityRef does NOT equal the canonical id — calibration weighting drops this correction",
  );
});

// ──────────────────────────────────────────────────────────────────────
// R-13: dedup hash equivalence across distinct entityRefs
// ──────────────────────────────────────────────────────────────────────
// Pure-storage observation: two memories with identical content but
// different entityRef are written as separate files. We don't assert
// the dedup verdict here — we assert that storage allows the parallel
// existence so downstream entity recall can serve each independently.

test("R-13: dedup pipeline flags two same-content / different-entityRef memories as duplicates", async () => {
  // Per Codex review: drive R-13 through the actual dedup code path
  // (`findDuplicates`), not just storage round-trip. Write two memories
  // with identical content but different entityRefs and assert that
  // `findDuplicates` flags them as duplicates regardless of entity. This
  // is the contamination R-13 documents — dedup ignores `entityRef`, so
  // a consolidation pass would merge two distinct-entity memories.
  const { memoryDir, storage } = await buildHarness("contam-r13");
  const aliceCanonical = normalizeEntityName("Alice-Test", "person");
  const bobCanonical = normalizeEntityName("Bob-B1", "person");
  await storage.writeEntity("Alice-Test", "person", []);
  await storage.writeEntity("Bob-B1", "person", []);

  await storage.writeMemory("fact", "prefers async standups", {
    entityRef: aliceCanonical,
    confidence: 0.9,
  });
  await storage.writeMemory("fact", "prefers async standups", {
    entityRef: bobCanonical,
    confidence: 0.9,
  });

  // Drive through findDuplicates — this exercises the actual dedup
  // similarity comparison, not a pure storage assertion.
  const result = findDuplicates({ memoryDir, threshold: 0.9 });
  assert.ok(result.scanned >= 2, "dedup must have scanned both memories");

  // The contamination: two memories with identical content but different
  // entityRefs are flagged as duplicates by `findDuplicates` because the
  // similarity computation does not factor entityRef. A consolidation
  // pass acting on this output would merge cross-entity memories.
  assert.ok(
    result.duplicates.length >= 1,
    "R-13 contamination: dedup flags same-content/different-entityRef memories as duplicates (entityRef is ignored)",
  );
});

// ──────────────────────────────────────────────────────────────────────
// Cross-entity recall isolation — end-to-end
// ──────────────────────────────────────────────────────────────────────

// PINNED CURRENT BEHAVIOR: end-to-end manifestation of R-2's partial-token
// bug. "Who is Person-A1?" alias-matches BOTH Person-A1 and Person-B1
// because both share the "person" token. PR 3 inverts the contamination
// assertions and applies the alias-scoring fix.
test("end-to-end (pinned bug): querying Person-A1 also surfaces Person-B1's hint section", async () => {
  const { config, storage } = await buildHarness("contam-e2e");
  await storage.writeEntity("Person-A1", "person", [
    "Person-A1 owns Project-A1.",
    "Person-A1 prefers async standups.",
  ]);
  await storage.writeEntity("Person-B1", "person", [
    "Person-B1 owns Project-B1.",
    "Person-B1 prefers sync standups.",
  ]);

  const sectionA = await buildSection(config, storage, "Who is Person-A1?");
  assert.ok(sectionA);
  assert.match(sectionA!, /target: Person-A1 \(person\)/);
  // Bug today: Person-B1 ALSO appears as a target. PR 3 inverts these.
  assert.match(
    sectionA!,
    /target: Person-B1 \(person\)/,
    "end-to-end bug today: Person-B1 surfaces alongside Person-A1",
  );
  assert.match(
    sectionA!,
    /Project-B1/,
    "end-to-end bug today: B1's project leaks into A1's hint section",
  );
});
