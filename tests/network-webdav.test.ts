import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { WebDavServer } from "../src/network/webdav.ts";

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
  } finally {
    await server.stop();
  }
});
