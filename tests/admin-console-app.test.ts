import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class FakeElement {
  value = "";
  textContent = "";
  disabled = false;
  className = "";
  dataset: Record<string, string> = {};

  addEventListener(): void {}
  appendChild(): void {}
  removeChild(): void {}
  get firstChild(): null {
    return null;
  }
}

async function loadAdminConsoleContext(pageSizeValue: string) {
  const scriptPath = path.resolve("admin-console/public/app.js");
  const script = await readFile(scriptPath, "utf8");
  const elements = new Map<string, FakeElement>([
    ["memoryPrevButton", new FakeElement()],
    ["memoryNextButton", new FakeElement()],
    ["memoryPageStatus", new FakeElement()],
    ["memoryPageSize", Object.assign(new FakeElement(), { value: pageSizeValue })],
  ]);
  const session = new Map<string, string>();
  const context = vm.createContext({
    console,
    URLSearchParams,
    document: {
      getElementById(id: string) {
        return elements.get(id) ?? null;
      },
      createElement() {
        return new FakeElement();
      },
    },
    window: {
      sessionStorage: {
        getItem(key: string) {
          return session.get(key) ?? "";
        },
        setItem(key: string, value: string) {
          session.set(key, value);
        },
        removeItem(key: string) {
          session.delete(key);
        },
      },
    },
    navigator: {},
  });
  vm.runInContext(script, context, { filename: scriptPath });
  return {
    browserState: vm.runInContext("browserState", context) as { limit: number; offset: number; total: number },
    stepMemoryPage: vm.runInContext("stepMemoryPage", context) as (direction: number) => void,
  };
}

test("admin console pagination step reads the current page size before advancing", async () => {
  const { browserState, stepMemoryPage } = await loadAdminConsoleContext("10");
  browserState.limit = 25;
  browserState.offset = 50;

  stepMemoryPage(1);

  assert.equal(browserState.limit, 10);
  assert.equal(browserState.offset, 60);
});

test("admin console pagination step reads the current page size before retreating", async () => {
  const { browserState, stepMemoryPage } = await loadAdminConsoleContext("10");
  browserState.limit = 25;
  browserState.offset = 50;

  stepMemoryPage(-1);

  assert.equal(browserState.limit, 10);
  assert.equal(browserState.offset, 40);
});
