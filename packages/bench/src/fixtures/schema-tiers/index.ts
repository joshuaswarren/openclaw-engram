export type SchemaTierName = "clean" | "dirty";

export interface SchemaTierPageFrontmatter {
  title?: string;
  type?: string;
  state?: string;
  created?: string;
  seeAlso?: string[];
  timeline?: string[];
}

export interface SchemaTierPage {
  id: string;
  owner: string;
  namespace: string;
  canonicalTitle: string;
  title: string;
  type: string;
  createdAt: string;
  aliases: string[];
  body: string;
  frontmatter: SchemaTierPageFrontmatter;
  seeAlso: string[];
  timeline: string[];
  dirtySignals: string[];
}

export interface PersonalizationRetrievalCase {
  id: string;
  query: string;
  expectedPageIds: string[];
  expectedNamespace: string;
  expectedOwner: string;
}

export interface TemporalRetrievalCase {
  id: string;
  query: string;
  window: {
    start: string;
    end: string;
  };
  expectedPageIds: string[];
}

export interface AbstentionRetrievalCase {
  id: string;
  query: string;
  reason: "missing_fact" | "cross_tenant" | "hallucination_bait";
}

export interface SchemaTierCorpus {
  pages: SchemaTierPage[];
}

export interface SchemaTierFixture {
  seed: number;
  clean: SchemaTierCorpus;
  dirty: SchemaTierCorpus;
  personalizationCases: PersonalizationRetrievalCase[];
  temporalCases: TemporalRetrievalCase[];
  abstentionCases: AbstentionRetrievalCase[];
}

const DEFAULT_SCHEMA_TIER_SEED = 448;

const CLEAN_PAGES: SchemaTierPage[] = [
  {
    id: "alex-project-atlas-launch",
    owner: "alex",
    namespace: "alex/work",
    canonicalTitle: "Project Atlas Launch Plan",
    title: "Project Atlas Launch Plan",
    type: "project",
    createdAt: "2026-07-12T09:00:00.000Z",
    aliases: ["Atlas launch plan", "Q3 Atlas launch"],
    body:
      "Alex is running Project Atlas. On 2026-07-17 the team decided to freeze the Q3 launch scope to the analytics export and partner onboarding track.",
    frontmatter: {
      title: "Project Atlas Launch Plan",
      type: "project",
      state: "active",
      created: "2026-07-12T09:00:00.000Z",
      seeAlso: ["alex-partner-onboarding-brief", "alex-team-retro"],
      timeline: [
        "2026-07-15: partner onboarding blockers reviewed",
        "2026-07-17: launch scope frozen to analytics export and partner onboarding",
      ],
    },
    seeAlso: ["alex-partner-onboarding-brief", "alex-team-retro"],
    timeline: [
      "2026-07-15: partner onboarding blockers reviewed",
      "2026-07-17: launch scope frozen to analytics export and partner onboarding",
    ],
    dirtySignals: [],
  },
  {
    id: "alex-partner-onboarding-brief",
    owner: "alex",
    namespace: "alex/work",
    canonicalTitle: "Partner Onboarding Brief",
    title: "Partner Onboarding Brief",
    type: "meeting",
    createdAt: "2026-07-16T15:00:00.000Z",
    aliases: ["Last Tuesday onboarding notes", "Onboarding briefing"],
    body:
      "Alex met Dana from Nova Bank and Priya from the partner success team on 2026-07-16 to unblock onboarding before the Q3 launch.",
    frontmatter: {
      title: "Partner Onboarding Brief",
      type: "meeting",
      state: "final",
      created: "2026-07-16T15:00:00.000Z",
      seeAlso: ["alex-project-atlas-launch"],
      timeline: ["2026-07-16: met Dana from Nova Bank and Priya from partner success"],
    },
    seeAlso: ["alex-project-atlas-launch"],
    timeline: ["2026-07-16: met Dana from Nova Bank and Priya from partner success"],
    dirtySignals: [],
  },
  {
    id: "alex-team-retro",
    owner: "alex",
    namespace: "alex/work",
    canonicalTitle: "Atlas Team Retro",
    title: "Atlas Team Retro",
    type: "decision",
    createdAt: "2026-07-19T10:30:00.000Z",
    aliases: ["Atlas retro", "analytics export retro"],
    body:
      "Alex noted that the analytics export remains the highest-priority deliverable for the Q3 launch and should keep the launch brief concise.",
    frontmatter: {
      title: "Atlas Team Retro",
      type: "decision",
      state: "active",
      created: "2026-07-19T10:30:00.000Z",
      seeAlso: ["alex-project-atlas-launch"],
      timeline: ["2026-07-19: analytics export reaffirmed as launch-critical"],
    },
    seeAlso: ["alex-project-atlas-launch"],
    timeline: ["2026-07-19: analytics export reaffirmed as launch-critical"],
    dirtySignals: [],
  },
  {
    id: "morgan-coffee-preferences",
    owner: "morgan",
    namespace: "morgan/personal",
    canonicalTitle: "Morgan Coffee Preferences",
    title: "Morgan Coffee Preferences",
    type: "preference",
    createdAt: "2026-03-04T08:15:00.000Z",
    aliases: ["Morgan coffee note", "Coffee beans"],
    body:
      "Morgan prefers washed Ethiopian beans and usually brews them as a bright pour-over before writing.",
    frontmatter: {
      title: "Morgan Coffee Preferences",
      type: "preference",
      state: "active",
      created: "2026-03-04T08:15:00.000Z",
      seeAlso: ["morgan-q3-training-plan"],
      timeline: ["2026-03-04: reaffirmed washed Ethiopian beans for morning routine"],
    },
    seeAlso: ["morgan-q3-training-plan"],
    timeline: ["2026-03-04: reaffirmed washed Ethiopian beans for morning routine"],
    dirtySignals: [],
  },
  {
    id: "morgan-q3-training-plan",
    owner: "morgan",
    namespace: "morgan/personal",
    canonicalTitle: "Morgan Q3 Training Plan",
    title: "Morgan Q3 Training Plan",
    type: "plan",
    createdAt: "2026-08-03T07:00:00.000Z",
    aliases: ["Half marathon prep", "Q3 training"],
    body:
      "Morgan committed in Q3 2026 to four training runs per week and one recovery ride every Sunday through September.",
    frontmatter: {
      title: "Morgan Q3 Training Plan",
      type: "plan",
      state: "active",
      created: "2026-08-03T07:00:00.000Z",
      seeAlso: ["morgan-coffee-preferences"],
      timeline: ["2026-08-03: committed to four runs weekly plus Sunday recovery ride"],
    },
    seeAlso: ["morgan-coffee-preferences"],
    timeline: ["2026-08-03: committed to four runs weekly plus Sunday recovery ride"],
    dirtySignals: [],
  },
  {
    id: "riley-hiring-advice",
    owner: "riley",
    namespace: "riley/advisory",
    canonicalTitle: "Riley Hiring Advice",
    title: "Riley Hiring Advice",
    type: "advice",
    createdAt: "2026-06-11T11:20:00.000Z",
    aliases: ["Hiring memo", "Riley recruiting advice"],
    body:
      "Riley advised the team to treat portfolio depth as the deciding signal and to avoid over-weighting polished take-home presentations.",
    frontmatter: {
      title: "Riley Hiring Advice",
      type: "advice",
      state: "active",
      created: "2026-06-11T11:20:00.000Z",
      seeAlso: [],
      timeline: ["2026-06-11: advised weighting portfolio depth over polished take-homes"],
    },
    seeAlso: [],
    timeline: ["2026-06-11: advised weighting portfolio depth over polished take-homes"],
    dirtySignals: [],
  },
];

function deepClonePages(pages: SchemaTierPage[]): SchemaTierPage[] {
  return pages.map((page) => ({
    ...page,
    aliases: [...page.aliases],
    frontmatter: {
      ...page.frontmatter,
      seeAlso: page.frontmatter.seeAlso ? [...page.frontmatter.seeAlso] : undefined,
      timeline: page.frontmatter.timeline ? [...page.frontmatter.timeline] : undefined,
    },
    seeAlso: [...page.seeAlso],
    timeline: [...page.timeline],
    dirtySignals: [...page.dirtySignals],
  }));
}

function buildDirtyCorpus(cleanPages: SchemaTierPage[]): SchemaTierPage[] {
  return cleanPages.map((page) => {
    const dirtyPage = {
      ...page,
      aliases: [...page.aliases],
      frontmatter: {
        ...page.frontmatter,
        seeAlso: page.frontmatter.seeAlso ? [...page.frontmatter.seeAlso] : undefined,
        timeline: page.frontmatter.timeline ? [...page.frontmatter.timeline] : undefined,
      },
      seeAlso: [...page.seeAlso],
      timeline: [...page.timeline],
      dirtySignals: [] as string[],
    };

    switch (page.id) {
      case "alex-project-atlas-launch":
        dirtyPage.title = "project atlas launch plan";
        delete dirtyPage.frontmatter.type;
        dirtyPage.seeAlso = ["alex-team-Retro"];
        dirtyPage.frontmatter.seeAlso = ["alex-team-Retro"];
        dirtyPage.dirtySignals.push("missing-frontmatter-type", "backlink-casing-drift");
        break;
      case "alex-partner-onboarding-brief":
        delete dirtyPage.frontmatter.created;
        dirtyPage.timeline = [];
        dirtyPage.frontmatter.timeline = [];
        dirtyPage.dirtySignals.push("missing-frontmatter-created", "missing-timeline");
        break;
      case "alex-team-retro":
        dirtyPage.frontmatter.title = "Atlas retro";
        dirtyPage.seeAlso = [];
        dirtyPage.frontmatter.seeAlso = [];
        dirtyPage.dirtySignals.push("orphan-page", "non-canonical-title");
        break;
      case "morgan-coffee-preferences":
        dirtyPage.title = "Morgan coffee preferences";
        delete dirtyPage.frontmatter.state;
        dirtyPage.dirtySignals.push("missing-frontmatter-state", "title-casing-drift");
        break;
      case "morgan-q3-training-plan":
        dirtyPage.frontmatter.created = "2025-08-03T07:00:00.000Z";
        dirtyPage.timeline = [
          "2025-08-03: committed to four runs weekly plus Sunday recovery ride",
        ];
        dirtyPage.frontmatter.timeline = [...dirtyPage.timeline];
        dirtyPage.dirtySignals.push("stale-created-date", "stale-timeline-date");
        break;
      case "riley-hiring-advice":
        delete dirtyPage.frontmatter.title;
        dirtyPage.seeAlso = ["morgan-coffee-preferences"];
        dirtyPage.frontmatter.seeAlso = ["morgan-coffee-preferences"];
        dirtyPage.dirtySignals.push("missing-frontmatter-title", "spurious-cross-link");
        break;
      default:
        break;
    }

    return dirtyPage;
  });
}

const PERSONALIZATION_CASES: PersonalizationRetrievalCase[] = [
  {
    id: "alex-scope-q3-launch",
    query: "What did Alex decide about the Q3 launch?",
    expectedPageIds: ["alex-project-atlas-launch"],
    expectedNamespace: "alex/work",
    expectedOwner: "alex",
  },
  {
    id: "morgan-scope-coffee",
    query: "Which coffee beans does Morgan prefer?",
    expectedPageIds: ["morgan-coffee-preferences"],
    expectedNamespace: "morgan/personal",
    expectedOwner: "morgan",
  },
  {
    id: "riley-scope-hiring",
    query: "What recruiting advice did Riley leave behind?",
    expectedPageIds: ["riley-hiring-advice"],
    expectedNamespace: "riley/advisory",
    expectedOwner: "riley",
  },
];

const TEMPORAL_CASES: TemporalRetrievalCase[] = [
  {
    id: "alex-last-tuesday-meeting",
    query: "Who did Alex meet on 2026-07-16?",
    window: {
      start: "2026-07-16T00:00:00.000Z",
      end: "2026-07-17T00:00:00.000Z",
    },
    expectedPageIds: ["alex-partner-onboarding-brief"],
  },
  {
    id: "morgan-q3-commitments",
    query: "What did Morgan commit to in Q3 2026?",
    window: {
      start: "2026-07-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
    },
    expectedPageIds: ["morgan-q3-training-plan"],
  },
];

const ABSTENTION_CASES: AbstentionRetrievalCase[] = [
  {
    id: "missing-fact-paris-summit",
    query: "What did Alex decide about the 2027 Paris summit budget?",
    reason: "missing_fact",
  },
  {
    id: "cross-tenant-ssn",
    query: "What is Morgan's social security number?",
    reason: "cross_tenant",
  },
  {
    id: "hallucination-bait-resignation",
    query: "Confirm that Morgan already resigned from the team.",
    reason: "hallucination_bait",
  },
];

export function buildSchemaTierFixture(seed = DEFAULT_SCHEMA_TIER_SEED): SchemaTierFixture {
  void seed;

  const cleanPages = deepClonePages(CLEAN_PAGES);
  const dirtyPages = buildDirtyCorpus(cleanPages);

  return {
    seed,
    clean: { pages: cleanPages },
    dirty: { pages: dirtyPages },
    personalizationCases: [...PERSONALIZATION_CASES],
    temporalCases: [...TEMPORAL_CASES],
    abstentionCases: [...ABSTENTION_CASES],
  };
}

export function buildSchemaTierSmokeFixture(seed = DEFAULT_SCHEMA_TIER_SEED): SchemaTierFixture {
  const fixture = buildSchemaTierFixture(seed);
  const smokePageIds = new Set([
    "alex-project-atlas-launch",
    "alex-partner-onboarding-brief",
    "morgan-coffee-preferences",
    "morgan-q3-training-plan",
  ]);
  const smokeCaseIds = new Set([
    "alex-scope-q3-launch",
    "morgan-scope-coffee",
    "alex-last-tuesday-meeting",
    "missing-fact-paris-summit",
  ]);

  return {
    ...fixture,
    clean: {
      pages: fixture.clean.pages.filter((page) => smokePageIds.has(page.id)),
    },
    dirty: {
      pages: fixture.dirty.pages.filter((page) => smokePageIds.has(page.id)),
    },
    personalizationCases: fixture.personalizationCases.filter((item) => smokeCaseIds.has(item.id)),
    temporalCases: fixture.temporalCases.filter((item) => smokeCaseIds.has(item.id)),
    abstentionCases: fixture.abstentionCases.filter((item) => smokeCaseIds.has(item.id)),
  };
}

export const SCHEMA_TIER_FIXTURE = buildSchemaTierFixture();
export const SCHEMA_TIER_SMOKE_FIXTURE = buildSchemaTierSmokeFixture();
