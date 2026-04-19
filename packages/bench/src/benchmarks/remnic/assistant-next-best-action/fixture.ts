import type {
  AssistantMemoryGraph,
  AssistantScenario,
} from "../_assistant-common/index.js";

const CORE_GRAPH: AssistantMemoryGraph = {
  userHandle: "Alex Rivera",
  userRole: "staff engineer, tech-lead of Project Atlas",
  facts: [
    {
      id: "fact-rollback-runbook-half",
      summary:
        "Rollback runbook for Project Atlas is approximately 60% drafted; missing the failback-to-warm-standby section.",
      tags: ["action-candidate"],
    },
    {
      id: "fact-pr-481-blocking",
      summary:
        "Remnic PR #481 has been waiting on Alex's review for 48 hours and blocks Jordan's next task.",
      tags: ["action-candidate", "blocking"],
    },
    {
      id: "fact-aurora-commit",
      summary:
        "Alex committed to Priya yesterday to send a written latency-target commitment by EOD Thursday.",
      tags: ["commitment"],
    },
    {
      id: "fact-insufficient-evidence-hiring",
      summary:
        "A single Slack message mentioned that Jordan might be interested in managing a small team. No other evidence.",
      tags: ["weak-signal"],
    },
  ],
  stances: [
    {
      topic: "commitments",
      position: "Alex treats written commitments as hard deadlines.",
    },
    {
      topic: "unblocking peers",
      position: "Alex prioritizes unblocking peers over own deep work.",
    },
  ],
  openThreads: [
    "Rollback runbook is required before the Atlas soft-launch next Tuesday.",
  ],
};

export const ASSISTANT_NEXT_BEST_ACTION_SCENARIOS: AssistantScenario[] = [
  {
    id: "nba.what-next",
    title: "What should I do next?",
    focus: "grounded_actionability",
    scenarioPrompt:
      "I have 45 minutes free. Given what you know about my current commitments and open work, what's the single highest-leverage thing I should do right now, and why?",
    memoryGraph: CORE_GRAPH,
  },
  {
    id: "nba.abstain-when-weak",
    title: "Abstain on weak evidence",
    focus: "calibration_abstention",
    scenarioPrompt:
      "Should I start a conversation with Jordan today about moving into a management track?",
    memoryGraph: CORE_GRAPH,
  },
  {
    id: "nba.deadline-ranking",
    title: "Deadline-aware ranking",
    focus: "deadline_priority",
    scenarioPrompt:
      "Rank my three most important actions for today, using my own commitments as the ordering signal.",
    memoryGraph: CORE_GRAPH,
  },
];

export const ASSISTANT_NEXT_BEST_ACTION_SMOKE_SCENARIOS: AssistantScenario[] =
  ASSISTANT_NEXT_BEST_ACTION_SCENARIOS.slice(0, 2);
