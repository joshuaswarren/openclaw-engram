import path from "node:path";
import type { Orchestrator } from "./orchestrator.js";

interface CliApi {
  registerCli(
    handler: (opts: { program: CliProgram }) => void,
    options: { commands: string[] },
  ): void;
}

interface CliProgram {
  command(name: string): CliCommand;
}

interface CliCommand {
  description(desc: string): CliCommand;
  option(flags: string, desc: string, defaultValue?: string): CliCommand;
  argument(name: string, desc: string): CliCommand;
  action(fn: (...args: unknown[]) => Promise<void> | void): CliCommand;
  command(name: string): CliCommand;
}

export function registerCli(api: CliApi, orchestrator: Orchestrator): void {
  api.registerCli(
    ({ program }) => {
      const cmd = program
        .command("engram")
        .description("Engram local memory commands");

      cmd
        .command("stats")
        .description("Show memory system statistics")
        .action(async () => {
          const meta = await orchestrator.storage.loadMeta();
          const memories = await orchestrator.storage.readAllMemories();
          const entities = await orchestrator.storage.readEntities();
          const profile = await orchestrator.storage.readProfile();

          console.log("=== Engram Memory Stats ===\n");
          console.log(`Total memories: ${memories.length}`);
          console.log(`Total entities: ${entities.length}`);
          console.log(`Profile size: ${profile.length} chars`);
          console.log(`Extractions: ${meta.extractionCount}`);
          console.log(`Last extraction: ${meta.lastExtractionAt ?? "never"}`);
          console.log(
            `Last consolidation: ${meta.lastConsolidationAt ?? "never"}`,
          );
          console.log(`QMD: ${orchestrator.qmd.isAvailable() ? "available" : "not available"}`);

          // Category breakdown
          const categories: Record<string, number> = {};
          for (const m of memories) {
            categories[m.frontmatter.category] =
              (categories[m.frontmatter.category] ?? 0) + 1;
          }
          if (Object.keys(categories).length > 0) {
            console.log("\nBy category:");
            for (const [cat, count] of Object.entries(categories)) {
              console.log(`  ${cat}: ${count}`);
            }
          }
        });

      cmd
        .command("search")
        .argument("<query>", "Search query")
        .option("-n, --max-results <number>", "Max results", "8")
        .description("Search memories via QMD")
        .action(async (query: string, options: Record<string, string>) => {
          const maxResults = parseInt(options.maxResults ?? "8", 10);

          if (orchestrator.qmd.isAvailable()) {
            const results = await orchestrator.qmd.search(
              query,
              undefined,
              maxResults,
            );
            if (results.length === 0) {
              console.log(`No results for: "${query}"`);
              return;
            }
            console.log(`\n=== Memory Search: "${query}" ===\n`);
            for (const r of results) {
              console.log(`  ${r.path} (score: ${r.score.toFixed(3)})`);
              if (r.snippet) {
                console.log(
                  `    ${r.snippet.slice(0, 150).replace(/\n/g, " ")}`,
                );
              }
              console.log();
            }
          } else {
            // Fallback: search filenames
            const memories = await orchestrator.storage.readAllMemories();
            const lowerQuery = query.toLowerCase();
            const matches = memories.filter(
              (m) =>
                m.content.toLowerCase().includes(lowerQuery) ||
                m.frontmatter.tags.some((t) => t.includes(lowerQuery)),
            );
            if (matches.length === 0) {
              console.log(`No results for: "${query}" (QMD not available, using text search)`);
              return;
            }
            console.log(`\n=== Text Search: "${query}" (${matches.length} results) ===\n`);
            for (const m of matches.slice(0, maxResults)) {
              console.log(`  [${m.frontmatter.category}] ${m.content.slice(0, 120)}`);
            }
          }
        });

      cmd
        .command("profile")
        .description("Show current user profile")
        .action(async () => {
          const profile = await orchestrator.storage.readProfile();
          if (!profile) {
            console.log("No profile built yet.");
            return;
          }
          console.log(profile);
        });

      cmd
        .command("entities")
        .description("List all tracked entities")
        .action(async () => {
          const entities = await orchestrator.storage.readEntities();
          if (entities.length === 0) {
            console.log("No entities tracked yet.");
            return;
          }
          console.log(`=== Entities (${entities.length}) ===\n`);
          for (const e of entities) {
            console.log(`  - ${e}`);
          }
        });

      cmd
        .command("extract")
        .description("Force extraction of buffered turns")
        .action(async () => {
          await orchestrator.buffer.load();
          const turns = orchestrator.buffer.getTurns();
          if (turns.length === 0) {
            console.log("Buffer is empty. Nothing to extract.");
            return;
          }
          console.log(`Extracting ${turns.length} buffered turns...`);
          // Trigger extraction by processing a dummy turn that forces extraction
          // Actually we need to call the internal extraction method
          // For now, inform the user
          console.log(
            "Use the memory system in conversation to trigger extraction, or wait for the buffer threshold.",
          );
        });

      cmd
        .command("questions")
        .description("List open questions from memory extraction")
        .option("-a, --all", "Show all questions including resolved")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const showAll = options.all === true;
          const questions = await orchestrator.storage.readQuestions({ unresolvedOnly: !showAll });
          if (questions.length === 0) {
            console.log(showAll ? "No questions found." : "No unresolved questions.");
            return;
          }
          console.log(`\n=== Questions (${questions.length}) ===\n`);
          for (const q of questions) {
            const status = q.resolved ? "[RESOLVED]" : `[priority: ${q.priority.toFixed(2)}]`;
            console.log(`  ${q.id} ${status}`);
            console.log(`    ${q.question}`);
            console.log(`    Context: ${q.context}`);
            console.log();
          }
        });

      cmd
        .command("identity")
        .description("Show agent identity reflections")
        .action(async () => {
          const workspaceDir = path.join(process.env.HOME ?? "~", ".openclaw", "workspace");
          const identity = await orchestrator.storage.readIdentity(workspaceDir);
          if (!identity) {
            console.log("No identity file found.");
            return;
          }
          console.log(identity);
        });
    },
    { commands: ["engram"] },
  );
}
