import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SessionToggleStore {
  isDisabled(sessionKey: string, agentId: string): Promise<boolean>;
  resolve(sessionKey: string, agentId: string): Promise<{
    disabled: boolean;
    source: "primary" | "secondary" | "none";
    updatedAt?: string;
  }>;
  setDisabled(sessionKey: string, agentId: string, disabled: boolean): Promise<void>;
  clear(sessionKey: string, agentId: string): Promise<void>;
  list(): Promise<Array<{ sessionKey: string; agentId: string; disabled: boolean; updatedAt: string }>>;
}

interface ToggleEntry {
  disabled: boolean;
  updatedAt: string;
}

interface ToggleFile {
  version: 1;
  entries: Record<string, ToggleEntry>;
}

interface FileToggleStoreOptions {
  secondaryReadOnlyPath?: string;
}

function encodeToggleKey(sessionKey: string, agentId: string): string {
  return `${encodeURIComponent(sessionKey)}::${encodeURIComponent(agentId)}`;
}

function decodeToggleKey(key: string): { sessionKey: string; agentId: string } | null {
  const [encodedSessionKey, encodedAgentId] = key.split("::");
  if (!encodedSessionKey || !encodedAgentId) return null;
  return {
    sessionKey: decodeURIComponent(encodedSessionKey),
    agentId: decodeURIComponent(encodedAgentId),
  };
}

async function safeReadToggleFile(filePath: string): Promise<ToggleFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ToggleFile>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return {
      version: 1,
      entries: Object.fromEntries(
        Object.entries(parsed.entries).filter(
          ([, value]) =>
            value &&
            typeof value === "object" &&
            typeof value.disabled === "boolean" &&
            typeof value.updatedAt === "string",
        ),
      ) as Record<string, ToggleEntry>,
    };
  } catch {
    return { version: 1, entries: {} };
  }
}

export function createFileToggleStore(
  filePath: string,
  options: FileToggleStoreOptions = {},
): SessionToggleStore {
  let writeChain = Promise.resolve();

  async function queueWrite(operation: () => Promise<void>): Promise<void> {
    const run = writeChain.catch(() => undefined).then(operation);
    writeChain = run.catch(() => undefined);
    await run;
  }

  async function writeToggleFile(next: ToggleFile): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
  }

  async function readPrimary(): Promise<ToggleFile> {
    return safeReadToggleFile(filePath);
  }

  async function readSecondary(): Promise<ToggleFile> {
    if (!options.secondaryReadOnlyPath) return { version: 1, entries: {} };
    return safeReadToggleFile(options.secondaryReadOnlyPath);
  }

  return {
    async isDisabled(sessionKey: string, agentId: string): Promise<boolean> {
      const resolved = await this.resolve(sessionKey, agentId);
      return resolved.disabled;
    },

    async resolve(sessionKey: string, agentId: string) {
      const key = encodeToggleKey(sessionKey, agentId);
      const primary = await readPrimary();
      if (primary.entries[key]) {
        return {
          disabled: primary.entries[key].disabled,
          source: "primary" as const,
          updatedAt: primary.entries[key].updatedAt,
        };
      }
      const secondary = await readSecondary();
      if (secondary.entries[key]) {
        return {
          disabled: secondary.entries[key].disabled,
          source: "secondary" as const,
          updatedAt: secondary.entries[key].updatedAt,
        };
      }
      return { disabled: false, source: "none" as const };
    },

    async setDisabled(sessionKey: string, agentId: string, disabled: boolean): Promise<void> {
      const key = encodeToggleKey(sessionKey, agentId);
      await queueWrite(async () => {
        const current = await readPrimary();
        current.entries[key] = {
          disabled,
          updatedAt: new Date().toISOString(),
        };
        await writeToggleFile(current);
      });
    },

    async clear(sessionKey: string, agentId: string): Promise<void> {
      const key = encodeToggleKey(sessionKey, agentId);
      await queueWrite(async () => {
        const current = await readPrimary();
        delete current.entries[key];
        await writeToggleFile(current);
      });
    },

    async list() {
      const current = await readPrimary();
      return Object.entries(current.entries)
        .map(([key, value]) => {
          const decoded = decodeToggleKey(key);
          if (!decoded) return null;
          return {
            sessionKey: decoded.sessionKey,
            agentId: decoded.agentId,
            disabled: value.disabled,
            updatedAt: value.updatedAt,
          };
        })
        .filter((value): value is { sessionKey: string; agentId: string; disabled: boolean; updatedAt: string } =>
          value !== null
        );
    },
  };
}
