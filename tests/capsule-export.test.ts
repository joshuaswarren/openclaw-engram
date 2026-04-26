import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { exportCapsule } from "../src/transfer/capsule-export.js";
import {
  CAPSULE_ID_PATTERN,
  ExportBundleV2Schema,
  parseExportBundle,
  parseExportManifest,
} from "../src/transfer/types.js";

interface FixtureFile {
  rel: string;
  content: string;
  mtime?: Date;
}

async function makeFixture(files: FixtureFile[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "capsule-export-"));
  for (const f of files) {
    const abs = path.join(root, ...f.rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, "utf-8");
    if (f.mtime) {
      await utimes(abs, f.mtime, f.mtime);
    }
  }
  return root;
}

function readArchive(absPath: string): Promise<Buffer> {
  return readFile(absPath);
}

test("exportCapsule writes a V2 manifest and gzipped bundle that round-trips", async () => {
  const root = await makeFixture([
    { rel: "profile.md", content: "# profile\n" },
    {
      rel: "facts/2026-04-25/fact-1.md",
      content: "---\nid: fact-1\n---\n\nbody-1\n",
    },
    {
      rel: "entities/acme.md",
      content: "# Acme\n",
    },
  ]);

  const result = await exportCapsule({
    name: "test-capsule",
    root,
    pluginVersion: "9.9.9",
    now: Date.parse("2026-04-26T00:00:00.000Z"),
  });

  assert.equal(result.manifest.schemaVersion, 2);
  assert.equal(result.manifest.format, "openclaw-engram-export");
  assert.equal(result.manifest.pluginVersion, "9.9.9");
  assert.equal(result.manifest.includesTranscripts, false);
  assert.equal(result.manifest.capsule.id, "test-capsule");
  assert.equal(result.manifest.capsule.parentCapsule, null);

  // 3 fixture files, all included.
  assert.equal(result.manifest.files.length, 3);
  assert.deepEqual(
    result.manifest.files.map((f) => f.path),
    [
      "entities/acme.md",
      "facts/2026-04-25/fact-1.md",
      "profile.md",
    ],
  );

  // Sidecar manifest.json mirrors the in-memory manifest.
  const sidecar = JSON.parse(await readFile(result.manifestPath, "utf-8"));
  assert.deepEqual(sidecar, result.manifest);

  // Archive: gunzip + parse + validate against V2 bundle schema.
  const gz = await readArchive(result.archivePath);
  const json = gunzipSync(gz).toString("utf-8");
  const bundle = ExportBundleV2Schema.parse(JSON.parse(json));
  assert.equal(bundle.records.length, 3);
  assert.deepEqual(
    bundle.records.map((r) => r.path),
    [
      "entities/acme.md",
      "facts/2026-04-25/fact-1.md",
      "profile.md",
    ],
  );
  // Records and manifest agree on file content via sha256.
  for (const rec of bundle.records) {
    const entry = bundle.manifest.files.find((f) => f.path === rec.path);
    assert.ok(entry, `manifest entry for ${rec.path}`);
    assert.equal(entry.bytes, Buffer.byteLength(rec.content, "utf-8"));
  }

  // parseExportBundle (V1/V2 dispatcher from PR 1/6) accepts the output.
  const parsed = parseExportBundle(JSON.parse(json));
  assert.equal(parsed.capsuleVersion, 2);
  assert.equal(parsed.capsule?.id, "test-capsule");
});

test("'since' filter excludes files older than the cutoff", async () => {
  const oldMtime = new Date("2026-01-01T00:00:00Z");
  const newMtime = new Date("2026-04-01T00:00:00Z");
  const root = await makeFixture([
    { rel: "facts/old.md", content: "old\n", mtime: oldMtime },
    { rel: "facts/new.md", content: "new\n", mtime: newMtime },
  ]);

  const result = await exportCapsule({
    name: "since-capsule",
    root,
    since: "2026-03-01T00:00:00.000Z",
  });

  assert.equal(result.manifest.files.length, 1);
  assert.equal(result.manifest.files[0].path, "facts/new.md");
});

test("'includeKinds' restricts top-level subdirectories", async () => {
  const root = await makeFixture([
    { rel: "profile.md", content: "p\n" },
    { rel: "facts/a.md", content: "a\n" },
    { rel: "entities/b.md", content: "b\n" },
    { rel: "corrections/c.md", content: "c\n" },
  ]);

  const result = await exportCapsule({
    name: "kinds-capsule",
    root,
    includeKinds: ["facts", "entities"],
  });

  assert.deepEqual(
    result.manifest.files.map((f) => f.path),
    ["entities/b.md", "facts/a.md"],
  );
  // root-level files (profile.md) excluded under an explicit allow-list.
  assert.ok(!result.manifest.files.some((f) => f.path === "profile.md"));
});

test("transcripts are excluded by default and opt-in via includeKinds", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
    { rel: "transcripts/t.md", content: "t\n" },
  ]);

  const exclude = await exportCapsule({ name: "no-transcripts", root });
  assert.equal(exclude.manifest.includesTranscripts, false);
  assert.ok(!exclude.manifest.files.some((f) => f.path.startsWith("transcripts/")));

  const include = await exportCapsule({
    name: "with-transcripts",
    root,
    includeKinds: ["facts", "transcripts"],
  });
  assert.equal(include.manifest.includesTranscripts, true);
  assert.ok(include.manifest.files.some((f) => f.path === "transcripts/t.md"));
});

test("'peerIds' restricts the peers/ tree", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
    { rel: "peers/alice/profile.md", content: "alice\n" },
    { rel: "peers/bob/profile.md", content: "bob\n" },
    { rel: "peers/carol/profile.md", content: "carol\n" },
  ]);

  const result = await exportCapsule({
    name: "peers-capsule",
    root,
    peerIds: ["alice", "carol"],
  });
  const peerPaths = result.manifest.files
    .filter((f) => f.path.startsWith("peers/"))
    .map((f) => f.path)
    .sort();
  assert.deepEqual(peerPaths, [
    "peers/alice/profile.md",
    "peers/carol/profile.md",
  ]);
  // bob is excluded.
  assert.ok(!result.manifest.files.some((f) => f.path.startsWith("peers/bob/")));
  // Non-peer kinds still flow through.
  assert.ok(result.manifest.files.some((f) => f.path === "facts/a.md"));
});

test("empty 'peerIds' array excludes the entire peers/ tree", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
    { rel: "peers/alice/profile.md", content: "alice\n" },
  ]);

  const result = await exportCapsule({
    name: "no-peers",
    root,
    peerIds: [],
  });
  assert.ok(!result.manifest.files.some((f) => f.path.startsWith("peers/")));
  assert.ok(result.manifest.files.some((f) => f.path === "facts/a.md"));
});

test("empty result still produces a valid manifest + archive", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
  ]);

  const result = await exportCapsule({
    name: "empty-capsule",
    root,
    // No top-level segment matches → all files filtered out.
    includeKinds: ["nonexistent"],
  });

  assert.equal(result.manifest.files.length, 0);
  const gz = await readArchive(result.archivePath);
  const bundle = ExportBundleV2Schema.parse(JSON.parse(gunzipSync(gz).toString("utf-8")));
  assert.equal(bundle.records.length, 0);
  // Manifest still parses through the V1/V2 dispatcher.
  const parsed = parseExportManifest(bundle.manifest);
  assert.equal(parsed.capsuleVersion, 2);
});

test("invalid name is rejected", async () => {
  const root = await makeFixture([{ rel: "a.md", content: "a\n" }]);
  await assert.rejects(
    exportCapsule({ name: "Invalid Name!", root }),
    /invalid capsule name/i,
  );
  // Confirm the regex test agrees.
  assert.equal(CAPSULE_ID_PATTERN.test("Invalid Name!"), false);
});

test("invalid 'since' is rejected", async () => {
  const root = await makeFixture([{ rel: "a.md", content: "a\n" }]);
  await assert.rejects(
    exportCapsule({ name: "bad-since", root, since: "not-a-date" }),
    /not a valid ISO/i,
  );
});

test("non-directory root is rejected", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "capsule-root-file-"));
  const filePath = path.join(tmp, "not-a-dir");
  await writeFile(filePath, "x", "utf-8");
  await assert.rejects(
    exportCapsule({ name: "bad-root", root: filePath }),
    /must be an existing directory/i,
  );
});

test("includeKinds entries with path separators are rejected", async () => {
  const root = await makeFixture([{ rel: "a/b.md", content: "a\n" }]);
  await assert.rejects(
    exportCapsule({ name: "bad-kind", root, includeKinds: ["facts/sub"] }),
    /top-level segment/i,
  );
});

test("peerIds entries with traversal segments are rejected", async () => {
  const root = await makeFixture([{ rel: "peers/a/p.md", content: "a\n" }]);
  await assert.rejects(
    exportCapsule({ name: "bad-peer", root, peerIds: [".."] }),
    /plain segment/i,
  );
});

test("capsule overrides flow into the manifest", async () => {
  const root = await makeFixture([{ rel: "a.md", content: "a\n" }]);
  const result = await exportCapsule({
    name: "override-capsule",
    root,
    capsule: {
      version: "1.2.3",
      description: "research bundle",
      parentCapsule: "parent-id",
      retrievalPolicy: {
        tierWeights: { bm25: 0.5, vector: 0.5 },
        directAnswerEnabled: true,
      },
      includes: {
        taxonomy: true,
        identityAnchors: false,
        peerProfiles: false,
        procedural: true,
      },
    },
  });
  assert.equal(result.manifest.capsule.version, "1.2.3");
  assert.equal(result.manifest.capsule.description, "research bundle");
  assert.equal(result.manifest.capsule.parentCapsule, "parent-id");
  assert.equal(result.manifest.capsule.retrievalPolicy.directAnswerEnabled, true);
  assert.equal(result.manifest.capsule.includes.taxonomy, true);
});

test("default-excluded directories (.git, node_modules) are skipped", async () => {
  const root = await makeFixture([
    { rel: "facts/a.md", content: "a\n" },
    { rel: ".git/HEAD", content: "ref\n" },
    { rel: "node_modules/dep/index.js", content: "x\n" },
  ]);
  const result = await exportCapsule({ name: "no-junk", root });
  assert.ok(result.manifest.files.every((f) => !f.path.startsWith(".git/")));
  assert.ok(result.manifest.files.every((f) => !f.path.startsWith("node_modules/")));
  assert.ok(result.manifest.files.some((f) => f.path === "facts/a.md"));
});
