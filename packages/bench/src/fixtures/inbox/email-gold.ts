/**
 * Gold graph for the synthetic inbox email fixture.
 *
 * Entities and links are fully synthetic — no real person or organisation data.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export const EMAIL_GOLD_GRAPH: GoldGraph = {
  entities: [
    // People
    { id: "person-alice", name: "Alice Nakamura", type: "person", aliases: ["Alice"] },
    { id: "person-bob", name: "Bob Chen", type: "person", aliases: ["Bob"] },
    { id: "person-carol", name: "Carol Osei", type: "person", aliases: ["Carol"] },
    // Orgs
    { id: "org-acme", name: "Acme Corp", type: "org", aliases: ["Acme"] },
    { id: "org-betaworks", name: "Betaworks Ltd", type: "org", aliases: ["Betaworks"] },
    // Projects
    { id: "project-atlas", name: "Project Atlas", type: "project", aliases: ["Atlas"] },
    // Topics
    { id: "topic-budget", name: "Q3 Budget Review", type: "topic", aliases: ["budget review", "Q3 budget"] },
    { id: "topic-onboarding", name: "Onboarding", type: "topic", aliases: ["onboard"] },
    // Events
    { id: "event-kickoff", name: "Atlas Kickoff Meeting", type: "event", aliases: ["kickoff"] },
  ],
  links: [
    { source: "Alice Nakamura", target: "Acme Corp", relation: "works-at", bidirectional: false },
    { source: "Bob Chen", target: "Acme Corp", relation: "works-at", bidirectional: false },
    { source: "Carol Osei", target: "Betaworks Ltd", relation: "works-at", bidirectional: false },
    { source: "Alice Nakamura", target: "Project Atlas", relation: "leads", bidirectional: false },
    { source: "Bob Chen", target: "Project Atlas", relation: "contributes-to", bidirectional: false },
    { source: "Alice Nakamura", target: "Bob Chen", relation: "collaborates-with", bidirectional: true },
    { source: "Atlas Kickoff Meeting", target: "Project Atlas", relation: "relates-to", bidirectional: false },
  ],
  pages: [
    {
      title: "Project Atlas",
      requiredFields: ["title", "type", "state", "created", "see-also"],
      expectTimeline: true,
      expectExecSummary: true,
      expectSeeAlso: ["Alice Nakamura", "Acme Corp"],
    },
    {
      title: "Alice Nakamura",
      requiredFields: ["title", "type", "state", "created", "see-also"],
      expectTimeline: false,
      expectExecSummary: false,
      expectSeeAlso: ["Project Atlas", "Acme Corp"],
    },
    {
      title: "Acme Corp",
      requiredFields: ["title", "type", "state", "created", "see-also"],
      expectTimeline: false,
      expectExecSummary: true,
      expectSeeAlso: ["Project Atlas"],
    },
  ],
};
