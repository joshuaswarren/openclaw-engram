import test from "node:test";
import assert from "node:assert/strict";
import { PLUGIN_ID } from "../../remnic-core/src/plugin-id.js";
import { validateSlotSelection } from "./slot-validator.js";

function buildLogger() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug() {},
      info() {},
      warn(message: string) {
        warnings.push(message);
      },
      error() {},
    },
  };
}

test("slot validator returns ok when memory slot matches this plugin", () => {
  const { logger } = buildLogger();
  const result = validateSlotSelection({
    pluginId: PLUGIN_ID,
    runtimeConfig: {
      plugins: {
        slots: {
          memory: PLUGIN_ID,
        },
      },
    },
    requireExclusive: true,
    onMismatch: "error",
    logger,
  });

  assert.equal(result, "ok");
});

test("slot validator throws actionable error on mismatch when configured to error", () => {
  const { logger } = buildLogger();

  assert.throws(
    () =>
      validateSlotSelection({
        pluginId: PLUGIN_ID,
        runtimeConfig: {
          plugins: {
            slots: {
              memory: "other-memory-plugin",
            },
          },
        },
        requireExclusive: true,
        onMismatch: "error",
        logger,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /other-memory-plugin/);
      assert.match(error.message, new RegExp(PLUGIN_ID));
      assert.match(error.message, /slotBehavior\.onSlotMismatch/);
      assert.match(error.message, /docs\/plugins\/openclaw\.md#slot-selection/);
      return true;
    },
  );
});

test("slot validator returns passive and warns on mismatch when configured to warn", () => {
  const { logger, warnings } = buildLogger();
  const result = validateSlotSelection({
    pluginId: PLUGIN_ID,
    runtimeConfig: {
      plugins: {
        slots: {
          memory: "other-memory-plugin",
        },
      },
    },
    requireExclusive: true,
    onMismatch: "warn",
    logger,
  });

  assert.equal(result, "passive");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /other-memory-plugin/);
});

test("slot validator returns passive silently on mismatch when configured silent", () => {
  const { logger, warnings } = buildLogger();
  const result = validateSlotSelection({
    pluginId: PLUGIN_ID,
    runtimeConfig: {
      plugins: {
        slots: {
          memory: "other-memory-plugin",
        },
      },
    },
    requireExclusive: true,
    onMismatch: "silent",
    logger,
  });

  assert.equal(result, "passive");
  assert.deepEqual(warnings, []);
});

test("slot validator recommends explicit slot selection when unset and exclusive", () => {
  const { logger, warnings } = buildLogger();
  const result = validateSlotSelection({
    pluginId: PLUGIN_ID,
    runtimeConfig: {
      plugins: {
        entries: {
          [PLUGIN_ID]: {},
        },
      },
    },
    requireExclusive: true,
    onMismatch: "warn",
    logger,
  });

  assert.equal(result, "ok");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /plugins\.slots\.memory/);
});

test("slot validator tolerates malformed runtime config", () => {
  const { logger, warnings } = buildLogger();
  const result = validateSlotSelection({
    pluginId: PLUGIN_ID,
    runtimeConfig: undefined,
    requireExclusive: true,
    onMismatch: "error",
    logger,
  });

  assert.equal(result, "ok");
  assert.deepEqual(warnings, []);
});
