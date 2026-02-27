import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { WebDavServer, hostToUrlAuthority } from "../src/network/webdav.ts";

type HttpResult = {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
};

async function httpRequest(
  method: string,
  port: number,
  pathname: string,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("webdav server is disabled by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-disabled-"));
  const server = await WebDavServer.create({
    port: 0,
    allowlistDirs: [root],
  });

  await assert.rejects(() => server.start(), /disabled/);
});

test("webdav serves files only inside allowlisted root alias", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-allow-"));
  await writeFile(path.join(root, "hello.txt"), "hello-world", "utf-8");

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const ok = await httpRequest("GET", started.port, `/${alias}/hello.txt`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "hello-world");

    const blocked = await httpRequest("GET", started.port, "/hello.txt");
    assert.equal(blocked.status, 403);
  } finally {
    await server.stop();
  }
});

test("webdav blocks traversal and supports PROPFIND", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-propfind-"));
  await writeFile(path.join(root, "a.txt"), "a", "utf-8");

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const propfind = await httpRequest("PROPFIND", started.port, `/${alias}`);
    assert.equal(propfind.status, 207);
    assert.match(propfind.body, /multistatus/);
    assert.match(propfind.body, /a\.txt/);

    const traversal = await httpRequest("GET", started.port, `/${alias}/../etc/passwd`);
    assert.equal(traversal.status, 403);
  } finally {
    await server.stop();
  }
});

test("webdav enforces optional basic auth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-auth-"));
  await writeFile(path.join(root, "secret.txt"), "top-secret", "utf-8");

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
    auth: {
      username: "engram",
      password: "pass123",
    },
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const denied = await httpRequest("GET", started.port, `/${alias}/secret.txt`);
    assert.equal(denied.status, 401);

    const authHeader = `Basic ${Buffer.from("engram:pass123").toString("base64")}`;
    const allowed = await httpRequest("GET", started.port, `/${alias}/secret.txt`, {
      Authorization: authHeader,
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "top-secret");

    const lowerScheme = await httpRequest("GET", started.port, `/${alias}/secret.txt`, {
      Authorization: authHeader.replace("Basic ", "basic "),
    });
    assert.equal(lowerScheme.status, 200);
    assert.equal(lowerScheme.body, "top-secret");
  } finally {
    await server.stop();
  }
});

test("webdav blocks symlink escapes outside allowlisted root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-outside-"));
  const outsideFile = path.join(outsideDir, "outside.txt");
  await writeFile(outsideFile, "outside-secret", "utf-8");
  await symlink(outsideFile, path.join(root, "leak.txt"));

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  const alias = path.basename(root);

  try {
    const leakAttempt = await httpRequest("GET", started.port, `/${alias}/leak.txt`);
    assert.equal(leakAttempt.status, 403);
    assert.match(leakAttempt.body, /allowlist/i);
  } finally {
    await server.stop();
  }
});

test("webdav start resets state after listen failure and supports retry", async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-retry-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-retry-b-"));

  const first = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [rootA],
  });
  const firstStarted = await first.start();

  const second = await WebDavServer.create({
    enabled: true,
    port: firstStarted.port,
    allowlistDirs: [rootB],
  });

  await assert.rejects(() => second.start());
  assert.equal(second.status().running, false);

  await first.stop();

  const secondStarted = await second.start();
  assert.equal(secondStarted.running, true);
  await second.stop();
});

test("hostToUrlAuthority brackets IPv6 host literals", () => {
  assert.equal(hostToUrlAuthority("127.0.0.1"), "127.0.0.1");
  assert.equal(hostToUrlAuthority("::1"), "[::1]");
  assert.equal(hostToUrlAuthority("[::1]"), "[::1]");
});

test("webdav returns 400 for malformed URL encoding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-bad-escape-"));
  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: [root],
  });
  const started = await server.start();
  try {
    const malformed = await httpRequest("GET", started.port, "/%E0%A4%A");
    assert.equal(malformed.status, 400);
    assert.match(malformed.body, /invalid path encoding/i);
  } finally {
    await server.stop();
  }
});

test("webdav create rejects duplicate root aliases", async () => {
  const baseA = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-alias-a-"));
  const baseB = await mkdtemp(path.join(os.tmpdir(), "engram-webdav-alias-b-"));
  const dirA = path.join(baseA, "shared");
  const dirB = path.join(baseB, "shared");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });

  await assert.rejects(
    () =>
      WebDavServer.create({
        enabled: true,
        port: 0,
        allowlistDirs: [dirA, dirB],
      }),
    /duplicate webdav allowlist alias: shared/,
  );
});

test("webdav supports filesystem-root allowlists", async () => {
  const hostsPath = "/etc/hosts";
  try {
    await stat(hostsPath);
  } catch {
    return;
  }

  const server = await WebDavServer.create({
    enabled: true,
    port: 0,
    allowlistDirs: ["/"],
  });
  const started = await server.start();
  try {
    const res = await httpRequest("GET", started.port, "/root/etc/hosts");
    assert.equal(res.status, 200);
  } finally {
    await server.stop();
  }
});
