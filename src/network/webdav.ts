import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { URL } from "node:url";

export function hostToUrlAuthority(host: string): string {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

export interface WebDavAuth {
  username: string;
  password: string;
}

export interface WebDavServerOptions {
  enabled?: boolean;
  host?: string;
  port: number;
  allowlistDirs: string[];
  auth?: WebDavAuth;
}

export interface WebDavServerStatus {
  running: boolean;
  host: string;
  port: number;
  rootCount: number;
}

interface AllowedRoot {
  absolute: string;
  name: string;
}

export class WebDavServer {
  private readonly options: Required<Omit<WebDavServerOptions, "auth">> & Pick<WebDavServerOptions, "auth">;
  private readonly allowedRoots: AllowedRoot[];
  private readonly timingKey: Buffer;
  private server: Server | null = null;

  private constructor(
    options: Required<Omit<WebDavServerOptions, "auth">> & Pick<WebDavServerOptions, "auth">,
    allowedRoots: AllowedRoot[],
  ) {
    this.options = options;
    this.allowedRoots = allowedRoots;
    this.timingKey = randomBytes(32);
  }

  static async create(input: WebDavServerOptions): Promise<WebDavServer> {
    const options: Required<Omit<WebDavServerOptions, "auth">> & Pick<WebDavServerOptions, "auth"> = {
      enabled: input.enabled ?? false,
      host: input.host ?? "127.0.0.1",
      port: input.port,
      allowlistDirs: input.allowlistDirs,
      auth: input.auth,
    };

    if (!Array.isArray(options.allowlistDirs) || options.allowlistDirs.length === 0) {
      throw new Error("webdav allowlistDirs must include at least one directory");
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error(`invalid webdav port: ${options.port}`);
    }

    const allowedRoots: AllowedRoot[] = [];
    const aliasSet = new Set<string>();
    for (const dir of options.allowlistDirs) {
      const resolved = path.resolve(dir);
      await mkdir(resolved, { recursive: true });
      const canonical = await realpath(resolved);
      const alias = path.basename(canonical) || "root";
      if (aliasSet.has(alias)) {
        throw new Error(`duplicate webdav allowlist alias: ${alias}`);
      }
      aliasSet.add(alias);
      allowedRoots.push({ absolute: canonical, name: alias });
    }

    return new WebDavServer(options, allowedRoots);
  }

  async start(): Promise<WebDavServerStatus> {
    if (!this.options.enabled) {
      throw new Error("webdav server is disabled; set enabled=true to start");
    }
    if (this.server) {
      return this.status();
    }

    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end(`webdav error: ${(err as Error).message}`);
      });
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.options.port, this.options.host);
      });
    } catch (err) {
      this.server = null;
      server.close();
      throw err;
    }

    const address = server.address();
    if (address && typeof address !== "string") {
      this.options.port = address.port;
    }

    return this.status();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  status(): WebDavServerStatus {
    return {
      running: this.server !== null,
      host: this.options.host,
      port: this.options.port,
      rootCount: this.allowedRoots.length,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Engram WebDAV"',
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("authentication required");
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      res.writeHead(204, {
        Allow: "OPTIONS, PROPFIND, GET, HEAD",
        DAV: "1",
      });
      res.end();
      return;
    }

    const parsed = new URL(req.url ?? "/", `http://${hostToUrlAuthority(this.options.host)}`);
    const resolved = await this.resolvePath(parsed.pathname);
    if (!resolved.ok) {
      res.writeHead(resolved.code, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(resolved.message);
      return;
    }

    if (method === "PROPFIND") {
      await this.handlePropfind(resolved.absolutePath, resolved.displayPath, res);
      return;
    }

    if (method === "GET" || method === "HEAD") {
      await this.handleRead(method, resolved.absolutePath, res);
      return;
    }

    res.writeHead(405, {
      Allow: "OPTIONS, PROPFIND, GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("method not allowed");
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.options.auth) return true;
    const raw = req.headers.authorization;
    if (!raw || !raw.startsWith("Basic ")) return false;

    try {
      const decoded = Buffer.from(raw.slice("Basic ".length), "base64").toString("utf-8");
      const separator = decoded.indexOf(":");
      if (separator < 0) return false;
      const username = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      const usernameOk = this.timingSafeStringEqual(username, this.options.auth.username);
      const passwordOk = this.timingSafeStringEqual(password, this.options.auth.password);
      return usernameOk && passwordOk;
    } catch {
      return false;
    }
  }

  private timingSafeStringEqual(a: string, b: string): boolean {
    const left = createHmac("sha256", this.timingKey).update(a, "utf-8").digest();
    const right = createHmac("sha256", this.timingKey).update(b, "utf-8").digest();
    return timingSafeEqual(left, right);
  }

  private async resolvePath(requestPathname: string): Promise<
    | { ok: true; absolutePath: string; displayPath: string }
    | { ok: false; code: number; message: string }
  > {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(requestPathname || "/");
    } catch {
      return { ok: false, code: 400, message: "invalid path encoding" };
    }
    if (decodedPath.includes("\0")) {
      return { ok: false, code: 400, message: "invalid path" };
    }

    const normalized = path.posix.normalize(decodedPath);
    const segments = normalized.split("/").filter((segment) => segment.length > 0);

    if (segments.length === 0) {
      return { ok: false, code: 403, message: "root listing is not allowed" };
    }

    const rootName = segments[0];
    const root = this.allowedRoots.find((entry) => entry.name === rootName);
    if (!root) {
      return { ok: false, code: 403, message: "path is outside allowlist" };
    }

    const relative = segments.slice(1);
    if (relative.some((segment) => segment === ".." || segment.includes("\\"))) {
      return { ok: false, code: 403, message: "path traversal is not allowed" };
    }

    const candidate = path.resolve(root.absolute, ...relative);
    if (!this.isPathInside(root.absolute, candidate)) {
      return { ok: false, code: 403, message: "path escaped allowlist" };
    }

    try {
      const canonicalCandidate = await realpath(candidate);
      if (!this.isPathInside(root.absolute, canonicalCandidate)) {
        return { ok: false, code: 403, message: "path escaped allowlist via symlink" };
      }
      return { ok: true, absolutePath: canonicalCandidate, displayPath: `/${segments.join("/")}` };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw err;
      }
      return { ok: true, absolutePath: candidate, displayPath: `/${segments.join("/")}` };
    }
  }

  private async handleRead(method: "GET" | "HEAD", absolutePath: string, res: ServerResponse): Promise<void> {
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    if (!info.isFile()) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("path is not a file");
      return;
    }

    res.writeHead(200, {
      "Content-Length": String(info.size),
      "Content-Type": "application/octet-stream",
    });

    if (method === "HEAD") {
      res.end();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absolutePath);
      stream.on("error", reject);
      stream.on("end", () => resolve());
      stream.pipe(res);
    });
  }

  private async handlePropfind(absolutePath: string, displayPath: string, res: ServerResponse): Promise<void> {
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const entries: string[] = [];
    if (info.isDirectory()) {
      const children = await readdir(absolutePath, { withFileTypes: true });
      for (const child of children) {
        entries.push(`
  <d:response>
    <d:href>${xmlEscape(`${displayPath.replace(/\/$/, "")}/${child.name}`)}</d:href>
    <d:propstat><d:prop><d:resourcetype>${child.isDirectory() ? "<d:collection/>" : ""}</d:resourcetype></d:prop></d:propstat>
  </d:response>`);
      }
    }

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${xmlEscape(displayPath)}</d:href>
    <d:propstat><d:prop><d:resourcetype>${info.isDirectory() ? "<d:collection/>" : ""}</d:resourcetype></d:prop></d:propstat>
  </d:response>${entries.join("")}
</d:multistatus>`;

    res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(xml);
  }

  private isPathInside(root: string, target: string): boolean {
    if (target === root) return true;
    if (root === path.parse(root).root) {
      return target.startsWith(root);
    }
    return target.startsWith(`${root}${path.sep}`);
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
