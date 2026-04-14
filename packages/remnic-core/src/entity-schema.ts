import type {
  EntitySchemaDefinition,
  EntitySchemaSectionDefinition,
  EntityStructuredSection,
} from "./types.js";

const DEFAULT_ENTITY_SCHEMAS: Record<string, EntitySchemaDefinition> = {
  person: {
    sections: [
      {
        key: "beliefs",
        title: "Beliefs",
        description: "",
        aliases: ["belief", "beliefs", "believe", "believes"],
      },
      {
        key: "communication_style",
        title: "Communication Style",
        description: "",
        aliases: ["communication", "communication style", "communicate", "writes", "writing style"],
      },
      {
        key: "building",
        title: "Building / Working On",
        description: "",
        aliases: ["building", "working on", "work on", "projects"],
      },
    ],
  },
  project: {
    sections: [
      { key: "status", title: "Status", description: "" },
      {
        key: "building",
        title: "Building / Working On",
        description: "",
        aliases: ["building", "working on", "work on"],
      },
      { key: "risks", title: "Risks", description: "" },
      { key: "notes", title: "Notes", description: "" },
    ],
  },
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toSnakeCase(value: string): string {
  return normalizeText(value).replace(/\s+/g, "_");
}

function titleFromKey(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function normalizeSectionDefinition(raw: unknown): EntitySchemaSectionDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keySource = typeof value.key === "string" ? value.key : typeof value.title === "string" ? value.title : "";
  const titleSource = typeof value.title === "string" ? value.title : typeof value.key === "string" ? value.key : "";
  const key = toSnakeCase(keySource);
  const title = titleSource.trim() || titleFromKey(key);
  if (!key || !title) return null;
  const description = typeof value.description === "string" ? value.description : "";
  const aliases = Array.isArray(value.aliases)
    ? value.aliases
        .filter((alias): alias is string => typeof alias === "string")
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0)
    : [];
  return aliases.length > 0
    ? { key, title, description, aliases }
    : { key, title, description };
}

export function normalizeEntitySchemas(raw: unknown): Record<string, EntitySchemaDefinition> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, EntitySchemaDefinition> = {};
  for (const [entityType, schema] of Object.entries(raw as Record<string, unknown>)) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) continue;
    const rawSections = (schema as Record<string, unknown>).sections;
    if (!Array.isArray(rawSections)) continue;
    const sections = rawSections
      .map((section) => normalizeSectionDefinition(section))
      .filter((section): section is EntitySchemaSectionDefinition => section !== null);
    if (sections.length === 0) continue;
    result[toSnakeCase(entityType)] = { sections };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function getEntitySchema(
  entityType: string,
  entitySchemas?: Record<string, EntitySchemaDefinition>,
): EntitySchemaDefinition | undefined {
  const normalizedType = toSnakeCase(entityType);
  return entitySchemas?.[normalizedType]
    ?? DEFAULT_ENTITY_SCHEMAS[normalizedType];
}

export function matchEntitySchemaSection(
  entityType: string,
  title: string,
  entitySchemas?: Record<string, EntitySchemaDefinition>,
): EntitySchemaSectionDefinition | null {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) return null;
  const schema = getEntitySchema(entityType, entitySchemas);
  if (!schema) return null;
  for (const section of schema.sections) {
    const aliases = [section.title, section.key, ...(section.aliases ?? [])];
    if (aliases.some((alias) => normalizeText(alias) === normalizedTitle)) {
      return section;
    }
  }
  return null;
}

function queryMentionsAlias(query: string, alias: string): boolean {
  const normalizedQuery = normalizeText(query);
  const normalizedAlias = normalizeText(alias);
  if (!normalizedQuery || !normalizedAlias) return false;
  if (normalizedQuery.includes(normalizedAlias)) return true;
  return normalizedQuery
    .split(/\s+/)
    .some((token) => token === normalizedAlias);
}

export function resolveRequestedEntitySectionKeys(
  query: string,
  entityType: string,
  availableSections: EntityStructuredSection[],
  entitySchemas?: Record<string, EntitySchemaDefinition>,
): string[] {
  if (availableSections.length === 0) return [];
  const availableKeys = new Set(availableSections.map((section) => toSnakeCase(section.key)));
  const schema = getEntitySchema(entityType, entitySchemas);
  if (!schema) return [];
  const matches: string[] = [];
  for (const section of schema.sections) {
    const key = toSnakeCase(section.key);
    if (!availableKeys.has(key)) continue;
    const aliases = [section.title, section.key, ...(section.aliases ?? [])];
    if (aliases.some((alias) => queryMentionsAlias(query, alias))) {
      matches.push(key);
    }
  }
  return matches;
}

export function sortStructuredSectionsBySchema(
  entityType: string,
  sections: EntityStructuredSection[],
  entitySchemas?: Record<string, EntitySchemaDefinition>,
): EntityStructuredSection[] {
  const schema = getEntitySchema(entityType, entitySchemas);
  if (!schema || sections.length <= 1) return sections;
  const order = new Map(schema.sections.map((section, index) => [toSnakeCase(section.key), index]));
  return [...sections].sort((left, right) => {
    const leftRank = order.get(toSnakeCase(left.key)) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = order.get(toSnakeCase(right.key)) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.title.localeCompare(right.title);
  });
}
