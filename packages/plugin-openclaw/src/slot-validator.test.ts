import test from "node:test";
import assert from "node:assert/strict";
import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "../../remnic-core/src/plugin-id.js";
import { SlotMismatchMode, validateSlotSelection } from "./slot-validator.js";

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
      assert.match(error.message, /closest known memory-slot plugin id/i);
      assert.match(error.message, /slotBehavior\.onSlotMismatch/);
      assert.match(error.message, /docs\/plugins\/openclaw\.md#slot-selection/);
      return true;
    },
  );
});

test("slot validator points legacy slot users at the canonical plugin id", () => {
  const { logger } = buildLogger();

  assert.throws(
    () =>
      validateSlotSelection({
        pluginId: PLUGIN_ID,
        runtimeConfig: {
          plugins: {
            slots: {
              memory: LEGACY_PLUGIN_ID,
            },
          },
        },
        requireExclusive: true,
        onMismatch: "error",
        logger,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(LEGACY_PLUGIN_ID));
      assert.match(error.message, new RegExp(PLUGIN_ID));
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

const mismatchModes: SlotMismatchMode[] = ["error", "warn", "silent"];
const slotStates = ["unset", "self", "other"] as const;

for (const requireExclusive of [true, false]) {
  for (const onMismatch of mismatchModes) {
    for (const slotState of slotStates) {
      test(`slot validator matrix covers slot=${slotState}, mode=${onMismatch}, requireExclusive=${requireExclusive}`, () => {
        const { logger, warnings } = buildLogger();
        const runtimeConfig =
          slotState === "unset"
            ? {
                plugins: {
                  entries: {
                    [PLUGIN_ID]: {},
                  },
                },
              }
            : {
                plugins: {
                  slots: {
                    memory: slotState === "self" ? PLUGIN_ID : "other-memory-plugin",
                  },
                },
              };

        if (slotState === "other" && onMismatch === "error") {
          assert.throws(() =>
            validateSlotSelection({
              pluginId: PLUGIN_ID,
              runtimeConfig,
              requireExclusive,
              onMismatch,
              logger,
            }),
          );
          assert.equal(warnings.length, 0);
          return;
        }

        const result = validateSlotSelection({
          pluginId: PLUGIN_ID,
          runtimeConfig,
          requireExclusive,
          onMismatch,
          logger,
        });

        if (slotState === "unset" || slotState === "self") {
          assert.equal(result, "ok");
        } else {
          assert.equal(result, "passive");
        }

        const expectedWarnings =
          slotState === "unset"
            ? (requireExclusive ? 1 : 0)
            : slotState === "other" && onMismatch === "warn"
              ? 1
              : 0;
        assert.equal(warnings.length, expectedWarnings);
      });
    }
  }
}
