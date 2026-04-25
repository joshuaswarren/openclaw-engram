/**
 * Regression tests for issue #686 PR 1/6 — verify recall path excludes cold
 * collection by default.
 *
 * Year-2 retention design intent: the cold QMD collection (default
 * "openclaw-engram-cold") is opt-in via `qmdColdTierEnabled`. Default recall
 * must hit the hot collection only. If a fresh install (no cold tier
 * configured) ever queries the cold QMD collection, the index-cost benefit of
 * the two-tier design evaporates.
 *
 * These tests pin three invariants:
 *   1. parseConfig defaults `qmdColdTierEnabled` to false.
 *   2. `applyColdFallbackPipeline` does NOT call into the cold-QMD branch when
 *      `qmdColdTierEnabled` is false (the archive-scan path is allowed; that
 *      reads `archive/`, not the cold tier).
 *   3. `applyColdFallbackPipeline` DOES call into the cold-QMD branch when
 *      `qmdColdTierEnabled` is explicitly true (the opt-in path remains wired).
 *
 * Test stubs the orchestrator's QMD adapter and `searchLongTermArchiveFallback`
 * so we can observe whether the cold collection is ever queried.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { QmdSearchResult } from "../src/types.js";

interface ColdAuditState {
  coldQmdCalls: number;
  archiveFallbackCalls: number;
  hotPrimaryCalls: number;
  observedCollections: (string | undefined)[];
}

async function buildAuditedOrchestrator(opts: {
  memoryDir: string;
  workspaceDir: string;
  qmdColdTierEnabled?: boolean;
}): Promise<{ orchestrator: any; state: ColdAuditState }> {
  const cfgInput: Record<string, unknown> = {
    openaiApiKey: "sk-test",
    memoryDir: opts.memoryDir,
    workspaceDir: opts.workspaceDir,
    qmdEnabled: true,
    qmdMaxResults: 4,
    qmdCollection: "engram-hot",
    qmdColdCollection: "engram-cold",
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: true,
  };
  if (opts.qmdColdTierEnabled !== undefined) {
    cfgInput.qmdColdTierEnabled = opts.qmdColdTierEnabled;
  }
  const config = parseConfig(cfgInput);
  const orchestrator = new Orchestrator(config) as any;

  const state: ColdAuditState = {
    coldQmdCalls: 0,
    archiveFallbackCalls: 0,
    hotPrimaryCalls: 0,
    observedCollections: [],
  };

  // Stub QMD adapter so any direct call is recorded.
  orchestrator.qmd = {
    isAvailable: () => true,
    search: async (_query: string, collection?: string) => {
      state.observedCollections.push(collection);
      if (collection === "engram-cold") {
        state.coldQmdCalls += 1;
      } else if (collection === undefined || collection === "engram-hot") {
        state.hotPrimaryCalls += 1;
      }
      return [] as QmdSearchResult[];
    },
    hybridSearch: async (_query: string, collection?: string) => {
      state.observedCollections.push(collection);
      return [] as QmdSearchResult[];
    },
  };

  // Stub the namespace-aware hot path so we can observe it without depending
  // on a live qmd binary or actual filesystem fixtures.
  orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async (
    _prompt: string,
    _qmdFetchLimit: number,
    _qmdHybridFetchLimit: number,
    o: { collection?: string },
  ): Promise<QmdSearchResult[]> => {
    state.observedCollections.push(o.collection);
    if (o.collection === "engram-cold") {
      state.coldQmdCalls += 1;
    } else {
      state.hotPrimaryCalls += 1;
    }
    return [];
  };

  // Stub archive scan so cold-fallback's archive branch is observable but
  // returns empty (so we can check whether cold-QMD is called instead).
  orchestrator.searchLongTermArchiveFallback = async (): Promise<
    QmdSearchResult[]
  > => {
    state.archiveFallbackCalls += 1;
    return [];
  };

  return { orchestrator, state };
}

test("parseConfig: qmdColdTierEnabled defaults to false (cold tier opt-in)", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(
    cfg.qmdColdTierEnabled,
    false,
    "Default qmdColdTierEnabled must be false; cold tier is opt-in",
  );
});

test("applyColdFallbackPipeline: cold QMD collection NOT queried under default config", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-default-excluded-"),
  );
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-default-excluded-ws-"),
  );

  try {
    const { orchestrator, state } = await buildAuditedOrchestrator({
      memoryDir,
      workspaceDir,
      // qmdColdTierEnabled left unset → defaults to false.
    });

    // Invoke the cold-fallback pipeline directly. Under default config the
    // cold-QMD branch must be skipped entirely; archive-scan is the only
    // source consulted and returns empty per our stub.
    const results: QmdSearchResult[] = await orchestrator.applyColdFallbackPipeline(
      {
        prompt: "any query",
        recallNamespaces: ["default"],
        recallResultLimit: 4,
        recallMode: "full",
      },
    );

    assert.equal(results.length, 0);
    assert.equal(
      state.coldQmdCalls,
      0,
      "cold QMD collection must not be queried when qmdColdTierEnabled=false",
    );
    assert.equal(
      state.archiveFallbackCalls,
      1,
      "archive-scan fallback should run once when cold-QMD is disabled",
    );
    assert.ok(
      !state.observedCollections.includes("engram-cold"),
      `cold collection must not appear in observed collections, got: ${JSON.stringify(state.observedCollections)}`,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3 });
    await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("applyColdFallbackPipeline: cold QMD IS queried when explicitly opted in", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-optin-"),
  );
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-optin-ws-"),
  );

  try {
    const { orchestrator, state } = await buildAuditedOrchestrator({
      memoryDir,
      workspaceDir,
      qmdColdTierEnabled: true,
    });

    await orchestrator.applyColdFallbackPipeline({
      prompt: "any query",
      recallNamespaces: ["default"],
      recallResultLimit: 4,
      recallMode: "full",
    });

    assert.equal(
      state.coldQmdCalls,
      1,
      "cold QMD collection MUST be queried when qmdColdTierEnabled=true",
    );
    assert.ok(
      state.observedCollections.includes("engram-cold"),
      `cold collection should appear in observed collections, got: ${JSON.stringify(state.observedCollections)}`,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3 });
    await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("AST audit: every fetchQmdMemoryResultsWithArtifactTopUp call resolves to hot-collection default outside applyColdFallbackPipeline", async () => {
  // Structural (AST-based) audit, replacing a brittle text-regex variant.
  //
  // Invariant: in `orchestrator.ts`, every call to
  // `fetchQmdMemoryResultsWithArtifactTopUp` whose enclosing function is NOT
  // `applyColdFallbackPipeline` must resolve to an options object whose
  // `collection` property is either absent or `undefined`. The cold-targeted
  // call site is permitted only inside `applyColdFallbackPipeline`.
  //
  // The AST walker handles both inline object literals AND options objects
  // declared in a parent block and passed by reference (the indirection that
  // a regex would miss — see codex review on PR #693).
  const ts = await import("typescript");
  const { readFile } = await import("node:fs/promises");
  const orchestratorPath = new URL(
    "../packages/remnic-core/src/orchestrator.ts",
    import.meta.url,
  );
  const src = await readFile(orchestratorPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    "orchestrator.ts",
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  /**
   * Find the nearest enclosing function/method declaration name for a node.
   * Returns "<top-level>" if no method/function ancestor is found.
   */
  function enclosingFunctionName(node: import("typescript").Node): string {
    let cur: import("typescript").Node | undefined = node.parent;
    while (cur) {
      if (
        ts.isMethodDeclaration(cur) ||
        ts.isFunctionDeclaration(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isArrowFunction(cur)
      ) {
        if (
          (ts.isMethodDeclaration(cur) || ts.isFunctionDeclaration(cur)) &&
          cur.name &&
          ts.isIdentifier(cur.name)
        ) {
          return cur.name.text;
        }
        // Anonymous arrow/function — keep walking up to the next named scope.
      }
      cur = cur.parent;
    }
    return "<top-level>";
  }

  /**
   * Resolve an argument expression to a *static* `collection` value if one is
   * statically determinable. Returns:
   *   - { kind: "absent" } — no collection key on the resolved options.
   *   - { kind: "explicit", value } — a syntactic value (Identifier text or
   *     string literal). The caller compares this against expected names.
   *   - { kind: "unknown" } — the audit cannot statically determine the
   *     value (e.g. a property access, function call, or unresolved
   *     parameter). Treated as a HARD FAILURE so the audit is re-run.
   */
  type Resolution =
    | { kind: "absent" }
    | { kind: "explicit"; value: string }
    | { kind: "unknown"; reason: string };

  function resolveOptionsArg(arg: import("typescript").Expression): Resolution {
    if (ts.isObjectLiteralExpression(arg)) {
      return resolveObjectLiteral(arg);
    }
    if (ts.isIdentifier(arg)) {
      // Find the variable declaration in the enclosing function.
      const decl = findVariableDeclaration(arg);
      if (!decl) {
        return {
          kind: "unknown",
          reason: `identifier ${arg.text} has no resolvable declaration`,
        };
      }
      if (!decl.initializer) {
        return {
          kind: "unknown",
          reason: `${arg.text} has no initializer`,
        };
      }
      if (!ts.isObjectLiteralExpression(decl.initializer)) {
        return {
          kind: "unknown",
          reason: `${arg.text} initializer is not an object literal`,
        };
      }
      return resolveObjectLiteral(decl.initializer);
    }
    return {
      kind: "unknown",
      reason: `unsupported argument kind: ${ts.SyntaxKind[arg.kind]}`,
    };
  }

  function resolveObjectLiteral(
    obj: import("typescript").ObjectLiteralExpression,
  ): Resolution {
    for (const prop of obj.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "collection"
      ) {
        const init = prop.initializer;
        // `collection: undefined` is semantically equivalent to omitting
        // the property — treat as absent so future refactors that explicitly
        // set undefined for clarity don't trip the audit.
        if (init.kind === ts.SyntaxKind.UndefinedKeyword) {
          return { kind: "absent" };
        }
        if (ts.isIdentifier(init) && init.text === "undefined") {
          return { kind: "absent" };
        }
        if (init.kind === ts.SyntaxKind.NullKeyword) {
          // `collection: null` is not a hot default; the search backend would
          // still see a null collection. Surface as unknown for human review.
          return {
            kind: "unknown",
            reason: "collection: null is ambiguous; review",
          };
        }
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          return { kind: "explicit", value: init.text };
        }
        if (ts.isIdentifier(init)) {
          return { kind: "explicit", value: init.text };
        }
        if (ts.isPropertyAccessExpression(init)) {
          // e.g. `options.collection` or `this.config.qmdColdCollection`
          return {
            kind: "explicit",
            value: init.getText(sourceFile),
          };
        }
        return {
          kind: "unknown",
          reason: `collection initializer kind: ${ts.SyntaxKind[init.kind]}`,
        };
      }
      if (
        ts.isShorthandPropertyAssignment(prop) &&
        prop.name.text === "collection"
      ) {
        return { kind: "explicit", value: "collection" };
      }
      if (ts.isSpreadAssignment(prop)) {
        // A spread could carry a `collection` field. Force a re-audit.
        return {
          kind: "unknown",
          reason: "object literal contains a spread; cannot statically audit",
        };
      }
    }
    return { kind: "absent" };
  }

  /**
   * Resolve an identifier to its lexically-visible variable declaration.
   *
   * Walks UP the parent chain from the use-site, and at each enclosing
   * Block / SourceFile / function body, scans only that block's *direct*
   * statements (not deep descendants). This respects shadowing: an inner
   * `opts` shadows an outer `opts`, and the audit will bind to the inner
   * declaration. If the same name is declared in a sibling block (not on
   * the path to the use-site), it is correctly ignored.
   *
   * Returns the nearest lexically-visible `VariableDeclaration`.
   */
  function findVariableDeclaration(
    id: import("typescript").Identifier,
  ): import("typescript").VariableDeclaration | undefined {
    function scanStatement(
      stmt: import("typescript").Node,
    ): import("typescript").VariableDeclaration | undefined {
      // Variable declarations live inside VariableStatement → VariableDeclarationList
      // (e.g. `const x = ...`). Function/method parameters are also declarations.
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === id.text) {
            return decl;
          }
        }
      }
      return undefined;
    }

    function scanScope(
      scope: import("typescript").Node,
    ): import("typescript").VariableDeclaration | undefined {
      // Iterate the scope's direct children. For Block, that's `statements`.
      // For function-like nodes, the body is a Block; we already handle that
      // when the parent walk lands on the Block itself.
      const children: import("typescript").Statement[] = [];
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
        children.push(...(scope.statements as readonly import("typescript").Statement[]));
      } else if (ts.isCaseOrDefaultClause(scope)) {
        children.push(
          ...(scope.statements as readonly import("typescript").Statement[]),
        );
      }
      for (const child of children) {
        const found = scanStatement(child);
        if (found) return found;
      }
      return undefined;
    }

    function scanFunctionParameters(
      fn:
        | import("typescript").MethodDeclaration
        | import("typescript").FunctionDeclaration
        | import("typescript").FunctionExpression
        | import("typescript").ArrowFunction
        | import("typescript").Constructor
        | import("typescript").GetAccessorDeclaration
        | import("typescript").SetAccessorDeclaration,
    ): import("typescript").VariableDeclaration | undefined {
      for (const param of fn.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === id.text) {
          // Parameters aren't VariableDeclarations, but for our audit we only
          // care that the identifier resolves to *something* with an
          // initializer we can read. Parameters do not have initializers we
          // can statically resolve, so we surface a sentinel by returning a
          // synthetic-looking unresolved decl — handled by the caller as
          // "no initializer", which becomes `unknown` upstream.
          // We can't construct a VariableDeclaration here, so return
          // undefined to force the caller to flag this as `unknown`.
          return undefined;
        }
      }
      return undefined;
    }

    let cur: import("typescript").Node | undefined = id.parent;
    while (cur) {
      if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
        const found = scanScope(cur);
        if (found) return found;
      }
      // When we hit a function-like node, also check its parameters as a
      // sibling scope (parameters are visible inside the function body).
      if (
        ts.isMethodDeclaration(cur) ||
        ts.isFunctionDeclaration(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isArrowFunction(cur) ||
        ts.isConstructorDeclaration(cur) ||
        ts.isGetAccessorDeclaration(cur) ||
        ts.isSetAccessorDeclaration(cur)
      ) {
        const paramHit = scanFunctionParameters(cur);
        if (paramHit) return paramHit;
      }
      cur = cur.parent;
    }
    return undefined;
  }

  interface CallSite {
    enclosingFn: string;
    resolution: Resolution;
    line: number;
  }
  const callSites: CallSite[] = [];

  function visit(node: import("typescript").Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === "fetchQmdMemoryResultsWithArtifactTopUp"
    ) {
      const lastArg = node.arguments[node.arguments.length - 1];
      const resolution: Resolution = lastArg
        ? resolveOptionsArg(lastArg)
        : { kind: "absent" };
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      callSites.push({
        enclosingFn: enclosingFunctionName(node),
        resolution,
        line: line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  assert.ok(
    callSites.length >= 2,
    `expected to find at least 2 call sites; found ${callSites.length}`,
  );

  // Categorize.
  const coldFromColdFallback: CallSite[] = [];
  const hotImplicit: CallSite[] = [];
  const violations: string[] = [];
  for (const site of callSites) {
    const inColdFallback = site.enclosingFn === "applyColdFallbackPipeline";
    if (site.resolution.kind === "unknown") {
      violations.push(
        `line ${site.line} in ${site.enclosingFn}: cannot statically audit collection arg (${site.resolution.reason})`,
      );
      continue;
    }
    if (site.resolution.kind === "absent") {
      hotImplicit.push(site);
      continue;
    }
    // Explicit collection argument.
    if (inColdFallback && site.resolution.value === "coldCollection") {
      coldFromColdFallback.push(site);
      continue;
    }
    violations.push(
      `line ${site.line} in ${site.enclosingFn}: explicit collection=${site.resolution.value} outside applyColdFallbackPipeline`,
    );
  }

  assert.deepEqual(
    violations,
    [],
    `cold-tier exclusion audit failed:\n${violations.join("\n")}`,
  );
  assert.equal(
    coldFromColdFallback.length,
    1,
    `expected exactly 1 cold-targeted call inside applyColdFallbackPipeline; found ${coldFromColdFallback.length}`,
  );
  assert.ok(
    hotImplicit.length >= 1,
    "at least one hot-default call site (no collection key) must exist",
  );
});

test("AST audit: this.config.qmdColdCollection is read only inside applyColdFallbackPipeline or TierMigrationExecutor setup", async () => {
  // Companion invariant: the cold-collection config field is read in exactly
  // two known-safe places:
  //   - inside `applyColdFallbackPipeline` (recall opt-in path, gated by
  //     qmdColdTierEnabled === true), and
  //   - inside the TierMigrationExecutor wiring (write-time migration).
  // Any new read elsewhere is a regression and must be re-reviewed.
  const ts = await import("typescript");
  const { readFile } = await import("node:fs/promises");
  const orchestratorPath = new URL(
    "../packages/remnic-core/src/orchestrator.ts",
    import.meta.url,
  );
  const src = await readFile(orchestratorPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    "orchestrator.ts",
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  function enclosingFunctionName(node: import("typescript").Node): string {
    let cur: import("typescript").Node | undefined = node.parent;
    while (cur) {
      if (
        (ts.isMethodDeclaration(cur) || ts.isFunctionDeclaration(cur)) &&
        cur.name &&
        ts.isIdentifier(cur.name)
      ) {
        return cur.name.text;
      }
      cur = cur.parent;
    }
    return "<top-level>";
  }

  const reads: { fn: string; line: number }[] = [];
  function visit(node: import("typescript").Node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "qmdColdCollection"
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      reads.push({ fn: enclosingFunctionName(node), line: line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  // Allowed enclosing functions for `qmdColdCollection` reads.
  const allowedFns = new Set<string>([
    "applyColdFallbackPipeline",
    "runTierMigrationCycle",
    "runQmdTierMigrationCycle",
    "performTierMigrationOnce",
  ]);

  const violations = reads.filter((r) => !allowedFns.has(r.fn));
  // We allow either of the documented reads to be merged into a helper; the
  // real assertion is that no UNKNOWN function reads it.
  assert.deepEqual(
    violations,
    [],
    `qmdColdCollection read outside the allow-list — review and add to allowedFns if intentional:\n${violations
      .map((v) => `  line ${v.line} in ${v.fn}`)
      .join("\n")}`,
  );
  // Require at least one read inside applyColdFallbackPipeline specifically.
  // A weaker `reads.length >= 1` would be silently satisfied by a tier-
  // migration read while applyColdFallbackPipeline hard-coded the cold
  // collection name, breaking configurability while this audit stayed green.
  // (Codex review on PR #693.)
  const fallbackReads = reads.filter(
    (r) => r.fn === "applyColdFallbackPipeline",
  );
  assert.ok(
    fallbackReads.length >= 1,
    `applyColdFallbackPipeline must read this.config.qmdColdCollection so the cold collection name remains configurable; found ${fallbackReads.length} reads in that function`,
  );
});
