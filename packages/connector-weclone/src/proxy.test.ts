import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createWeCloneProxy } from "./proxy.js";
import type { WeCloneConnectorConfig } from "./config.js";

/**
 * Create a mock HTTP server that responds with a fixed body for any request.
 * Listens on port 0 (OS-assigned) to avoid conflicts.
 */
function createMockServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => void
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          ),
      });
    });
  });
}

/**
 * Read a response body as string.
 */
async function readResponse(res: Response): Promise<string> {
  return res.text();
}

/**
 * Build a test config pointing at the given mock ports.
 */
function testConfig(
  weclonePort: number,
  remnicPort: number,
  overrides: Partial<WeCloneConnectorConfig> = {}
): WeCloneConnectorConfig {
  return {
    wecloneApiUrl: `http://127.0.0.1:${weclonePort}/v1`,
    proxyPort: 0, // OS-assigned
    remnicDaemonUrl: `http://127.0.0.1:${remnicPort}`,
    sessionStrategy: "single",
    memoryInjection: {
      maxTokens: 1500,
      position: "system-append",
      template: "[Memory]\n{memories}\n[/Memory]",
    },
    ...overrides,
  };
}

// Track servers to clean up
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn();
  }
});

describe("WeCloneProxy", () => {
  it("starts and stops cleanly", async () => {
    const weclone = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    assert.ok(proxy.port > 0, "proxy should have a valid port");
    await proxy.stop();
    // Remove from cleanups since we already stopped
    cleanups.pop();
  });

  it("health endpoint returns 200 with status ok", async () => {
    const weclone = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const config = testConfig(weclone.port, remnic.port);
    const proxy = createWeCloneProxy(config);
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(`http://127.0.0.1:${proxy.port}/health`);
    assert.equal(res.status, 200);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.status, "ok");
    assert.equal(body.wecloneApi, config.wecloneApiUrl);
  });

  it("proxies chat completions with memory injection", async () => {
    let receivedBody: Record<string, unknown> | null = null;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Hello from WeClone!" },
              },
            ],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { content: "User prefers formal tone", confidence: 0.9 },
          ],
        })
      );
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hi there" },
          ],
        }),
      }
    );

    assert.equal(res.status, 200);
    const responseBody = JSON.parse(await readResponse(res));
    assert.equal(responseBody.choices[0].message.content, "Hello from WeClone!");

    // Verify memory was injected into the forwarded request
    assert.ok(receivedBody, "WeClone should have received a request");
    const messages = (receivedBody as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    const systemMsg = messages.find((m) => m.role === "system");
    assert.ok(systemMsg, "System message should exist");
    assert.ok(
      systemMsg.content.includes("User prefers formal tone"),
      "Memory should be injected into system message"
    );
    assert.ok(
      systemMsg.content.includes("[Memory]"),
      "Memory template should be used"
    );
  });

  it("continues working when Remnic recall fails", async () => {
    let receivedBody: Record<string, unknown> | null = null;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Response without memory" },
              },
            ],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    // Remnic returns 500
    const remnic = await createMockServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hello" },
          ],
        }),
      }
    );

    assert.equal(res.status, 200);
    const responseBody = JSON.parse(await readResponse(res));
    assert.equal(
      responseBody.choices[0].message.content,
      "Response without memory"
    );

    // Verify the system message was NOT modified (no memory block)
    assert.ok(receivedBody);
    const messages = (receivedBody as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    const systemMsg = messages.find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.equal(
      systemMsg.content,
      "You are helpful.",
      "System message should be unmodified when recall fails"
    );
  });

  it("transparently proxies non-chat paths", async () => {
    const weclone = await createMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/models`
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.path, "/v1/models");
    assert.equal(body.method, "GET");
  });

  it("returns 400 for invalid JSON body on chat completions", async () => {
    const weclone = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json at all{{{",
      }
    );
    assert.equal(res.status, 400);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.error, "bad_request");
  });
});
