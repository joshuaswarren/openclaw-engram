import { buildEvidencePack } from "./evidence-pack.js";

export interface ExplicitCueRecallEngine {
  expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>>;
  searchContextFull(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<
    Array<{
      turn_index: number;
      role: string;
      content: string;
      session_id: string;
      score?: number;
    }>
  >;
}

export interface ExplicitCueRecallOptions {
  engine: ExplicitCueRecallEngine | null | undefined;
  sessionId?: string;
  query: string;
  maxChars: number;
  maxItemChars?: number;
  maxReferences?: number;
  includeStructuredPlanCues?: boolean;
}

export type ExplicitTurnReference = {
  number: number;
  includeDirectTurn: boolean;
};

const DEFAULT_MAX_CHARS = 2_400;
const DEFAULT_MAX_ITEM_CHARS = 1_200;
const DEFAULT_MAX_REFERENCES = 24;
const REFERENCE_SCAN_TOKEN_FACTOR = 3;
const TURN_REFERENCE_WINDOW_RADIUS = 0;
const LEXICAL_CUE_WINDOW_RADIUS = 1;
const LEXICAL_CUE_SEARCH_LIMIT = 3;
const LEXICAL_CUE_MAX_TOKENS = 400;
const LATEST_STATE_CUES = new Set([
  "as of",
  "currently",
  "latest",
  "most recent",
  "newest",
  "now",
  "updated",
  "changed",
  "change",
]);
const STRUCTURED_PLAN_FIELD_CUES = new Set([
  "accommodation",
  "attraction",
  "breakfast",
  "current city",
  "dinner",
  "flight",
  "flights",
  "hotel",
  "lunch",
  "restaurant",
  "restaurants",
  "transportation",
  "traveler",
  "travelers",
]);
const STRUCTURED_PLAN_DEPENDENCY_CUES = new Set([
  "comparison",
  "constraint",
  "constraints",
  "dependency",
  "dependencies",
  "join",
  "same",
  "shared",
]);
const RELATIVE_TEMPORAL_CUES = [
  "as of",
  "most recent",
  "last time",
  "last week",
  "last month",
  "last year",
  "last session",
  "last conversation",
  "next time",
  "next week",
  "next month",
  "next year",
  "next session",
  "next conversation",
  "previous time",
  "previous week",
  "previous month",
  "previous year",
  "previous session",
  "previous conversation",
  "prior time",
  "prior week",
  "prior month",
  "prior year",
  "prior session",
  "prior conversation",
  "today",
  "yesterday",
  "tomorrow",
  "tonight",
  "earlier",
  "later",
  "recently",
  "previously",
  "currently",
  "now",
  "latest",
  "newest",
  "oldest",
  "earliest",
  "before",
  "after",
  "since",
  "updated",
  "changed",
  "change",
];
const SPEAKER_NAME_STOPWORDS = new Set([
  "A",
  "According",
  "An",
  "And",
  "Are",
  "As",
  "At",
  "Before",
  "Can",
  "Compare",
  "Could",
  "Did",
  "Do",
  "Does",
  "For",
  "From",
  "Had",
  "Has",
  "Have",
  "How",
  "In",
  "Is",
  "It",
  "Join",
  "Of",
  "On",
  "Or",
  "Please",
  "Review",
  "Step",
  "Tell",
  "The",
  "To",
  "Turn",
  "Use",
  "Was",
  "Were",
  "What",
  "When",
  "Where",
  "Which",
  "Who",
  "Why",
  "Will",
  "Would",
]);
const QUESTION_SLOT_STOPWORDS = new Set([
  "answer",
  "choice",
  "did",
  "does",
  "do",
  "is",
  "should",
  "single",
  "the",
  "user",
  "was",
  "were",
]);

export async function buildExplicitCueRecallSection(
  options: ExplicitCueRecallOptions,
): Promise<string> {
  const engine = options.engine;
  const query = options.query.trim();
  const maxChars = normalizePositiveInteger(options.maxChars, DEFAULT_MAX_CHARS);
  if (!engine || query.length === 0 || maxChars <= 0) {
    return "";
  }

  const maxReferences = normalizePositiveInteger(
    options.maxReferences,
    DEFAULT_MAX_REFERENCES,
  );
  if (maxReferences <= 0) {
    return "";
  }

  const evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
    score?: number;
  }> = [];
  const seenTurns = new Set<string>();

  await collectTurnReferenceEvidence({
    engine,
    sessionId: options.sessionId,
    query,
    maxReferences,
    evidenceItems,
    seenTurns,
  });

  await collectLexicalCueEvidence({
    engine,
    sessionId: options.sessionId,
    query,
    maxReferences,
    includeStructuredPlanCues: options.includeStructuredPlanCues,
    evidenceItems,
    seenTurns,
  });

  return buildEvidencePack(evidenceItems, {
    title: "Explicit Cue Evidence",
    maxChars,
    maxItemChars: normalizePositiveInteger(
      options.maxItemChars,
      DEFAULT_MAX_ITEM_CHARS,
    ),
  });
}

async function collectTurnReferenceEvidence(options: {
  engine: ExplicitCueRecallEngine;
  sessionId?: string;
  query: string;
  maxReferences: number;
  evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }>;
  seenTurns: Set<string>;
}): Promise<void> {
  if (!options.sessionId) {
    return;
  }

  const references = collectExplicitTurnReferences(options.query).slice(
    0,
    options.maxReferences,
  );
  if (references.length === 0) {
    return;
  }

  const windows = new Map<string, { fromTurn: number; toTurn: number }>();
  for (const reference of references) {
    for (const center of candidateTurnIndexesForReference(reference)) {
      if (center < 0) {
        continue;
      }

      const fromTurn = Math.max(0, center - TURN_REFERENCE_WINDOW_RADIUS);
      const toTurn = center + TURN_REFERENCE_WINDOW_RADIUS;
      windows.set(`${fromTurn}:${toTurn}`, { fromTurn, toTurn });
    }
  }

  for (const window of [...windows.values()].sort(
    (left, right) => left.fromTurn - right.fromTurn || left.toTurn - right.toTurn,
  )) {
    const expanded = await options.engine.expandContext(
      options.sessionId,
      window.fromTurn,
      window.toTurn,
      2_000,
    );
    appendExpandedEvidence(
      options.evidenceItems,
      options.seenTurns,
      options.sessionId,
      expanded,
    );
  }
}

async function collectLexicalCueEvidence(options: {
  engine: ExplicitCueRecallEngine;
  sessionId?: string;
  query: string;
  maxReferences: number;
  includeStructuredPlanCues?: boolean;
  evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
    score?: number;
  }>;
  seenTurns: Set<string>;
}): Promise<void> {
  const cues = collectLexicalCues(options.query, {
    includeStructuredPlanCues: options.includeStructuredPlanCues,
  }).slice(0, options.maxReferences);
  const preferLatest = hasLatestStateIntent(options.query);
  for (const cue of cues) {
    const results = sortLexicalCueResults(
      await options.engine.searchContextFull(
        cue,
        LEXICAL_CUE_SEARCH_LIMIT,
        options.sessionId,
      ),
      preferLatest,
    );
    for (const result of results) {
      const windowRadius = preferLatest ? 0 : LEXICAL_CUE_WINDOW_RADIUS;
      const fromTurn = Math.max(0, result.turn_index - windowRadius);
      const toTurn = result.turn_index + windowRadius;
      const expanded = await options.engine.expandContext(
        result.session_id,
        fromTurn,
        toTurn,
        LEXICAL_CUE_MAX_TOKENS,
      );
      if (expanded.length === 0) {
        appendEvidenceItem(options.evidenceItems, options.seenTurns, {
          id: `${result.session_id}:${result.turn_index}`,
          sessionId: result.session_id,
          turnIndex: result.turn_index,
          role: result.role,
          content: result.content,
          ...(typeof result.score === "number" ? { score: result.score } : {}),
        });
        continue;
      }
      appendExpandedEvidence(
        options.evidenceItems,
        options.seenTurns,
        result.session_id,
        expanded,
      );
    }
  }
}

function appendExpandedEvidence(
  evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }>,
  seenTurns: Set<string>,
  sessionId: string,
  expanded: Array<{ turn_index: number; role: string; content: string }>,
): void {
  for (const message of expanded) {
    appendEvidenceItem(evidenceItems, seenTurns, {
      id: `${sessionId}:${message.turn_index}`,
      sessionId,
      turnIndex: message.turn_index,
      role: message.role,
      content: message.content,
    });
  }
}

function appendEvidenceItem<T extends { id: string }>(
  evidenceItems: T[],
  seenTurns: Set<string>,
  item: T,
): void {
  if (seenTurns.has(item.id)) {
    return;
  }
  seenTurns.add(item.id);
  evidenceItems.push(item);
}

export function collectExplicitTurnReferences(
  query: string,
): ExplicitTurnReference[] {
  const references = new Map<string, ExplicitTurnReference>();
  const addReference = (value: number, label: string) => {
    const existing = references.get(String(value));
    references.set(String(value), {
      number: value,
      includeDirectTurn:
        (existing?.includeDirectTurn ?? false) || label === "turn",
    });
  };

  const tokens = tokenizeReferenceQuery(query);
  for (let index = 0; index < tokens.length; index += 1) {
    const label = normalizeReferenceLabel(tokens[index]);
    if (!label) {
      continue;
    }

    const parsed = parseReferenceNumbers(tokens, index + 1);
    for (const number of parsed.numbers) {
      addReference(number, label);
    }
    index = Math.max(index, parsed.nextIndex - 1);
  }

  return [...references.values()].sort((left, right) => left.number - right.number);
}

export function collectLexicalCues(
  query: string,
  options: { includeStructuredPlanCues?: boolean } = {},
): string[] {
  const cues = new Set<string>();

  for (const match of query.matchAll(/\b[A-Za-z][A-Za-z0-9]{0,12}\d+:\d+\b/g)) {
    cues.add(match[0]);
  }
  for (const match of query.matchAll(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?\b/g)) {
    cues.add(match[0]);
  }
  for (const cue of collectTemporalLexicalCues(query)) {
    cues.add(cue);
  }
  for (const cue of collectQuestionSlotCues(query)) {
    cues.add(cue);
  }
  if (options.includeStructuredPlanCues) {
    for (const cue of collectStructuredPlanCues(query)) {
      cues.add(cue);
    }
  }
  for (const match of query.matchAll(/\b(?:session|source|chat|plan|task|event|file|tool)[_-][A-Za-z0-9][A-Za-z0-9_.:-]{0,80}\b/gi)) {
    cues.add(match[0]);
  }
  for (const match of query.matchAll(/\b[A-Z][a-z]{1,30}(?:\s+[A-Z][a-z]{1,30}){0,2}\b/g)) {
    const value = normalizeSpeakerNameCue(match[0]);
    if (value) {
      cues.add(value);
    }
  }
  for (const match of query.matchAll(/\[([A-Za-z0-9][A-Za-z0-9_.:/ -]{1,80})\]/g)) {
    const value = match[1]?.trim();
    if (value) {
      cues.add(value);
    }
  }

  return [...cues].sort((left, right) => left.localeCompare(right));
}

export function collectQuestionSlotCues(query: string): string[] {
  const cues = new Set<string>();
  for (const match of query.matchAll(
    /\b(?:what|which)\s+([a-z][a-z0-9_-]{2,30})\s+(?:does|do|did|is|are|was|were|should|would|could|can|will)\b/gi,
  )) {
    const value = match[1]?.toLowerCase();
    if (value && !QUESTION_SLOT_STOPWORDS.has(value)) {
      cues.add(value);
    }
  }
  return [...cues].sort((left, right) => left.localeCompare(right));
}

export function collectStructuredPlanCues(query: string): string[] {
  const cues = new Set<string>();
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ");
  for (const cue of STRUCTURED_PLAN_FIELD_CUES) {
    if (containsBoundedPhrase(normalizedQuery, cue)) {
      cues.add(cue);
    }
  }
  if (cues.size === 0) {
    return [];
  }
  for (const cue of STRUCTURED_PLAN_DEPENDENCY_CUES) {
    if (containsBoundedPhrase(normalizedQuery, cue)) {
      cues.add(cue);
    }
  }
  return [...cues].sort((left, right) => left.localeCompare(right));
}

function containsBoundedPhrase(normalizedHaystack: string, phrase: string): boolean {
  let searchFrom = 0;
  while (searchFrom < normalizedHaystack.length) {
    const index = normalizedHaystack.indexOf(phrase, searchFrom);
    if (index < 0) {
      return false;
    }
    const afterIndex = index + phrase.length;
    if (
      isTemporalCueBoundary(normalizedHaystack[index - 1]) &&
      isTemporalCueBoundary(normalizedHaystack[afterIndex])
    ) {
      return true;
    }
    searchFrom = afterIndex;
  }
  return false;
}

export function collectTemporalLexicalCues(query: string): string[] {
  const cues = new Set<string>();
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ");
  for (const cue of RELATIVE_TEMPORAL_CUES) {
    if (containsBoundedPhrase(normalizedQuery, cue)) {
      cues.add(cue);
    }
  }
  return [...cues].sort((left, right) => left.localeCompare(right));
}

function hasLatestStateIntent(query: string): boolean {
  return collectTemporalLexicalCues(query).some((cue) =>
    LATEST_STATE_CUES.has(cue),
  );
}

function sortLexicalCueResults<
  T extends { session_id: string; turn_index: number; score?: number },
>(results: T[], preferLatest: boolean): T[] {
  return [...results].sort((left, right) => {
    if (preferLatest) {
      const sessionOrder = left.session_id.localeCompare(right.session_id);
      if (sessionOrder !== 0) {
        return sessionOrder;
      }
      const turnOrder = right.turn_index - left.turn_index;
      if (turnOrder !== 0) {
        return turnOrder;
      }
      return (right.score ?? 0) - (left.score ?? 0);
    }
    const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const sessionOrder = left.session_id.localeCompare(right.session_id);
    if (sessionOrder !== 0) {
      return sessionOrder;
    }
    return left.turn_index - right.turn_index;
  });
}

function normalizeSpeakerNameCue(value: string): string | undefined {
  const words = value.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && SPEAKER_NAME_STOPWORDS.has(words[0]!)) {
    words.shift();
  }
  while (words.length > 0 && SPEAKER_NAME_STOPWORDS.has(words[words.length - 1]!)) {
    words.pop();
  }
  return words.length > 0 ? words.join(" ") : undefined;
}

function isTemporalCueBoundary(char: string | undefined): boolean {
  if (!char) {
    return true;
  }
  return !isAsciiLetterOrDigit(char);
}

function tokenizeReferenceQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";

  const flushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (const char of query) {
    if (isAsciiLetterOrDigit(char)) {
      current += char;
      continue;
    }

    flushCurrent();
    if (char === "#" || char === ",") {
      tokens.push(char);
    } else if (isReferenceDash(char)) {
      tokens.push("-");
    }
  }
  flushCurrent();

  return tokens;
}

function parseReferenceNumbers(
  tokens: readonly string[],
  startIndex: number,
): { numbers: number[]; nextIndex: number } {
  const numbers: number[] = [];
  let lastNumber: number | undefined;
  let pendingRangeStart: number | undefined;
  let index = startIndex;
  const scanEnd = Math.min(
    tokens.length,
    startIndex + DEFAULT_MAX_REFERENCES * REFERENCE_SCAN_TOKEN_FACTOR,
  );

  for (; index < scanEnd; index += 1) {
    const token = tokens[index]!;
    const normalized = token.toLowerCase();
    const value = parseNonNegativeIntegerToken(token);
    if (value !== undefined) {
      if (pendingRangeStart !== undefined) {
        numbers.push(...expandReferenceRange(pendingRangeStart, value));
        pendingRangeStart = undefined;
      } else {
        numbers.push(value);
      }
      lastNumber = value;
      continue;
    }

    if (normalized === "#" || normalized === "number" || normalized === ",") {
      continue;
    }

    if (
      normalized === "-" ||
      normalized === "to" ||
      normalized === "through" ||
      normalized === "thru"
    ) {
      if (lastNumber !== undefined) {
        if (numbers[numbers.length - 1] === lastNumber) {
          numbers.pop();
        }
        pendingRangeStart = lastNumber;
      }
      continue;
    }

    if (normalized === "and" && numbers.length > 0) {
      continue;
    }

    if (normalizeReferenceLabel(token)) {
      break;
    }

    break;
  }

  if (pendingRangeStart !== undefined) {
    numbers.push(pendingRangeStart);
  }

  return {
    numbers: [...new Set(numbers)],
    nextIndex: index,
  };
}

function expandReferenceRange(start: number, end: number): number[] {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  if (high - low + 1 > DEFAULT_MAX_REFERENCES) {
    return [start, end];
  }

  const values: number[] = [];
  for (let value = low; value <= high; value += 1) {
    values.push(value);
  }
  return values;
}

function normalizeReferenceLabel(token: string | undefined): string | undefined {
  const normalized = token?.toLowerCase();
  switch (normalized) {
    case "step":
    case "steps":
      return "step";
    case "turn":
    case "turns":
      return "turn";
    case "action":
    case "actions":
      return "action";
    case "observation":
    case "observations":
      return "observation";
    default:
      return undefined;
  }
}

function candidateTurnIndexesForReference(
  reference: ExplicitTurnReference,
): number[] {
  const candidates = new Set<number>();
  if (reference.includeDirectTurn) {
    for (let offset = -1; offset <= 1; offset += 1) {
      candidates.add(reference.number + offset);
    }
  }

  const pairedBase = reference.number * 2;
  for (let offset = -2; offset <= 3; offset += 1) {
    candidates.add(pairedBase + offset);
  }

  return [...candidates].sort((left, right) => left - right);
}

function parseNonNegativeIntegerToken(token: string): number | undefined {
  if (token.length === 0) {
    return undefined;
  }

  let value = 0;
  for (const char of token) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) {
      return undefined;
    }
    value = value * 10 + (code - 48);
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function isAsciiLetterOrDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function isReferenceDash(char: string): boolean {
  return char === "-"
    || char === "\u2010"
    || char === "\u2011"
    || char === "\u2012"
    || char === "\u2013"
    || char === "\u2014"
    || char === "\u2015";
}
