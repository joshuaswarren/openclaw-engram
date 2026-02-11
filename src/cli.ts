import path from "node:path";
import { access, readFile } from "node:fs/promises";
import type { Orchestrator } from "./orchestrator.js";
import { ThreadingManager } from "./threading.js";
import type { TranscriptEntry } from "./types.js";
import { exportJsonBundle } from "./transfer/export-json.js";
import { exportMarkdownBundle } from "./transfer/export-md.js";
import { backupMemoryDir } from "./transfer/backup.js";
import { exportSqlite } from "./transfer/export-sqlite.js";
import { importJsonBundle } from "./transfer/import-json.js";
import { importSqlite } from "./transfer/import-sqlite.js";
import { importMarkdownBundle } from "./transfer/import-md.js";
import { detectImportFormat } from "./transfer/autodetect.js";

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

async function getPluginVersion(): Promise<string> {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw = await readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveMemoryDirForNamespace(orchestrator: Orchestrator, namespace?: string): Promise<string> {
  const ns = (namespace ?? "").trim();
  if (!ns) return orchestrator.config.memoryDir;
  if (!orchestrator.config.namespacesEnabled) return orchestrator.config.memoryDir;

  const candidate = path.join(orchestrator.config.memoryDir, "namespaces", ns);
  if (ns === orchestrator.config.defaultNamespace) {
    return (await exists(candidate)) ? candidate : orchestrator.config.memoryDir;
  }
  return candidate;
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
          // Ensure QMD is probed before checking availability
          await orchestrator.qmd.probe();

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
        .command("export")
        .description("Export Engram memory to JSON, Markdown bundle, or SQLite")
        .option("--format <format>", "Export format: json|md|sqlite", "json")
        .option("--out <path>", "Output path (dir for json/md, file for sqlite)")
        .option("--include-transcripts", "Include transcripts in export (default: false)")
        .option("--namespace <ns>", "Namespace to export (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const format = String(options.format ?? "json");
          const out = options.out ? String(options.out) : "";
          const includeTranscripts = options.includeTranscripts === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          if (!out) {
            console.log("Missing --out. Example: openclaw engram export --format json --out /tmp/engram-export");
            return;
          }

          const pluginVersion = await getPluginVersion();
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          if (format === "json") {
            await exportJsonBundle({
              memoryDir,
              outDir: out,
              includeTranscripts,
              pluginVersion,
              workspaceDir: orchestrator.config.workspaceDir,
              includeWorkspaceIdentity: true,
            });
          } else if (format === "md") {
            await exportMarkdownBundle({
              memoryDir,
              outDir: out,
              includeTranscripts,
              pluginVersion,
            });
          } else if (format === "sqlite") {
            await exportSqlite({
              memoryDir,
              outFile: out,
              includeTranscripts,
              pluginVersion,
            });
          } else {
            console.log(`Unknown format: ${format}`);
            return;
          }
          console.log("OK");
        });

      cmd
        .command("import")
        .description("Import Engram memory from JSON bundle, Markdown bundle, or SQLite")
        .option("--from <path>", "Import source path (dir or file)")
        .option("--format <format>", "Import format: auto|json|md|sqlite", "auto")
        .option("--conflict <mode>", "Conflict policy: skip|overwrite|dedupe", "skip")
        .option("--dry-run", "Validate import without writing files")
        .option("--namespace <ns>", "Namespace to import into (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const from = options.from ? String(options.from) : "";
          const formatOpt = String(options.format ?? "auto");
          const conflict = String(options.conflict ?? "skip") as "skip" | "overwrite" | "dedupe";
          const dryRun = options.dryRun === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          if (!from) {
            console.log("Missing --from. Example: openclaw engram import --from /tmp/engram-export --format auto");
            return;
          }

          const detected = formatOpt === "auto" ? await detectImportFormat(from) : (formatOpt as any);
          if (!detected) {
            console.log("Could not detect import format (use --format json|md|sqlite).");
            return;
          }

          const targetMemoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);

          if (detected === "json") {
            await importJsonBundle({
              targetMemoryDir,
              fromDir: from,
              conflict,
              dryRun,
              workspaceDir: orchestrator.config.workspaceDir,
            });
          } else if (detected === "sqlite") {
            await importSqlite({
              targetMemoryDir,
              fromFile: from,
              conflict,
              dryRun,
            });
          } else if (detected === "md") {
            await importMarkdownBundle({
              targetMemoryDir,
              fromDir: from,
              conflict,
              dryRun,
            });
          } else {
            console.log(`Unknown detected format: ${detected}`);
            return;
          }
          console.log("OK");
        });

      cmd
        .command("backup")
        .description("Create a timestamped backup of the Engram memory directory")
        .option("--out-dir <dir>", "Backup root directory")
        .option("--retention-days <n>", "Delete backups older than N days", "0")
        .option("--include-transcripts", "Include transcripts (default false)")
        .option("--namespace <ns>", "Namespace to back up (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const outDir = options.outDir ? String(options.outDir) : "";
          const retentionDays = parseInt(String(options.retentionDays ?? "0"), 10);
          const includeTranscripts = options.includeTranscripts === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          if (!outDir) {
            console.log("Missing --out-dir. Example: openclaw engram backup --out-dir /tmp/engram-backups");
            return;
          }
          const pluginVersion = await getPluginVersion();
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          await backupMemoryDir({
            memoryDir,
            outDir,
            retentionDays: Number.isFinite(retentionDays) ? retentionDays : undefined,
            includeTranscripts,
            pluginVersion,
          });
          console.log("OK");
        });

      cmd
        .command("search")
        .argument("<query>", "Search query")
        .option("-n, --max-results <number>", "Max results", "8")
        .description("Search memories via QMD")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
          const options = (args[1] ?? {}) as Record<string, string>;
          const maxResults = parseInt(options.maxResults ?? "8", 10);
          if (!query) {
            console.log("Missing query. Usage: openclaw engram search <query>");
            return;
          }

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

      cmd
        .command("access")
        .description("Show memory access statistics")
        .option("-n, --top <number>", "Show top N most accessed", "20")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const top = parseInt(options.top ?? "20", 10);

          const memories = await orchestrator.storage.readAllMemories();
          const withAccess = memories.filter((m) => m.frontmatter.accessCount && m.frontmatter.accessCount > 0);

          if (withAccess.length === 0) {
            console.log("No access tracking data yet. Memories will be tracked as they are retrieved.");
            return;
          }

          // Sort by access count descending
          const sorted = withAccess.sort(
            (a, b) => (b.frontmatter.accessCount ?? 0) - (a.frontmatter.accessCount ?? 0),
          );

          console.log(`\n=== Top ${Math.min(top, sorted.length)} Most Accessed Memories ===\n`);
          for (const m of sorted.slice(0, top)) {
            const lastAccessed = m.frontmatter.lastAccessed
              ? new Date(m.frontmatter.lastAccessed).toLocaleDateString()
              : "unknown";
            console.log(`  ${m.frontmatter.accessCount}x  [${m.frontmatter.category}] ${m.content.slice(0, 80)}`);
            console.log(`       Last accessed: ${lastAccessed}  ID: ${m.frontmatter.id}`);
            console.log();
          }

          // Summary stats
          const totalAccess = withAccess.reduce((sum, m) => sum + (m.frontmatter.accessCount ?? 0), 0);
          console.log(`Total accesses tracked: ${totalAccess}`);
          console.log(`Memories with access data: ${withAccess.length} / ${memories.length}`);
        });

      cmd
        .command("flush-access")
        .description("Flush pending access tracking updates to disk")
        .action(async () => {
          await orchestrator.flushAccessTracking();
          console.log("Access tracking buffer flushed.");
        });

      cmd
        .command("importance")
        .description("Show importance score distribution across memories")
        .option("-l, --level <level>", "Filter by importance level (critical, high, normal, low, trivial)")
        .option("-n, --top <number>", "Show top N memories by importance", "15")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const filterLevel = options.level;
          const top = parseInt(options.top ?? "15", 10);

          const memories = await orchestrator.storage.readAllMemories();
          const withImportance = memories.filter((m) => m.frontmatter.importance);

          if (withImportance.length === 0) {
            console.log("No importance data yet. Importance is scored during extraction.");
            return;
          }

          // Count by level
          const levelCounts: Record<string, number> = {
            critical: 0,
            high: 0,
            normal: 0,
            low: 0,
            trivial: 0,
          };
          for (const m of withImportance) {
            const level = m.frontmatter.importance?.level ?? "normal";
            levelCounts[level] = (levelCounts[level] ?? 0) + 1;
          }

          console.log("\n=== Importance Distribution ===\n");
          for (const [level, count] of Object.entries(levelCounts)) {
            const bar = "█".repeat(Math.min(count, 50));
            console.log(`  ${level.padEnd(10)} ${count.toString().padStart(4)} ${bar}`);
          }
          console.log(`\n  Total scored: ${withImportance.length} / ${memories.length} memories\n`);

          // Filter by level if specified
          let filtered = withImportance;
          if (filterLevel) {
            filtered = withImportance.filter(
              (m) => m.frontmatter.importance?.level === filterLevel,
            );
            if (filtered.length === 0) {
              console.log(`No memories with importance level: ${filterLevel}`);
              return;
            }
          }

          // Sort by importance score descending
          const sorted = filtered.sort(
            (a, b) =>
              (b.frontmatter.importance?.score ?? 0) -
              (a.frontmatter.importance?.score ?? 0),
          );

          const heading = filterLevel
            ? `Top ${Math.min(top, sorted.length)} "${filterLevel}" Importance Memories`
            : `Top ${Math.min(top, sorted.length)} Most Important Memories`;
          console.log(`=== ${heading} ===\n`);

          for (const m of sorted.slice(0, top)) {
            const imp = m.frontmatter.importance!;
            console.log(
              `  ${imp.score.toFixed(2)} [${imp.level}] [${m.frontmatter.category}]`,
            );
            console.log(`    ${m.content.slice(0, 100)}`);
            if (imp.keywords.length > 0) {
              console.log(`    Keywords: ${imp.keywords.join(", ")}`);
            }
            console.log();
          }
        });
      cmd
        .command("topics")
        .description("Show extracted topics from memory corpus")
        .option("-n, --top <number>", "Show top N topics", "20")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const top = parseInt(options.top ?? "20", 10);

          const { topics, updatedAt } = await orchestrator.storage.loadTopics();

          if (topics.length === 0) {
            console.log("No topics extracted yet. Topics are extracted during consolidation.");
            return;
          }

          console.log(`\n=== Top ${Math.min(top, topics.length)} Topics ===`);
          console.log(`Last updated: ${updatedAt ?? "unknown"}\n`);

          for (const topic of topics.slice(0, top)) {
            const bar = "█".repeat(Math.min(Math.round(topic.score * 10), 30));
            console.log(`  ${topic.term.padEnd(20)} ${topic.score.toFixed(3)} (${topic.count}x) ${bar}`);
          }
        });

      cmd
        .command("summaries")
        .description("Show memory summaries")
        .option("-n, --top <number>", "Show top N most recent summaries", "5")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const top = parseInt(options.top ?? "5", 10);

          const summaries = await orchestrator.storage.readSummaries();

          if (summaries.length === 0) {
            console.log("No summaries yet. Summaries are created during consolidation when memory count exceeds threshold.");
            return;
          }

          // Sort by createdAt desc
          const sorted = summaries.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );

          console.log(`\n=== Memory Summaries (${Math.min(top, sorted.length)} of ${sorted.length}) ===\n`);

          for (const summary of sorted.slice(0, top)) {
            console.log(`  ${summary.id}`);
            console.log(`    Created: ${summary.createdAt}`);
            console.log(`    Time range: ${summary.timeRangeStart.slice(0, 10)} to ${summary.timeRangeEnd.slice(0, 10)}`);
            console.log(`    Source memories: ${summary.sourceEpisodeIds.length}`);
            console.log(`    Key facts: ${summary.keyFacts.length}`);
            console.log(`\n    Summary: ${summary.summaryText.slice(0, 200)}...`);
            console.log();
          }
        });

      cmd
        .command("threads")
        .description("Show conversation threads")
        .option("-n, --top <number>", "Show top N most recent threads", "10")
        .option("-t, --thread <id>", "Show details for a specific thread")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const threadId = options.thread;
          const top = parseInt(options.top ?? "10", 10);

          const memoryDir = path.join(process.env.HOME ?? "~", ".openclaw", "workspace", "memory", "local");
          const threading = new ThreadingManager(path.join(memoryDir, "threads"));

          if (threadId) {
            const thread = await threading.loadThread(threadId);
            if (!thread) {
              console.log(`Thread not found: ${threadId}`);
              return;
            }

            console.log(`\n=== Thread: ${thread.title} ===\n`);
            console.log(`  ID: ${thread.id}`);
            console.log(`  Created: ${thread.createdAt}`);
            console.log(`  Updated: ${thread.updatedAt}`);
            console.log(`  Session: ${thread.sessionKey ?? "(none)"}`);
            console.log(`  Episodes: ${thread.episodeIds.length}`);

            if (thread.episodeIds.length > 0) {
              console.log("\n  Episode IDs:");
              for (const id of thread.episodeIds.slice(0, 20)) {
                console.log(`    - ${id}`);
              }
              if (thread.episodeIds.length > 20) {
                console.log(`    ... and ${thread.episodeIds.length - 20} more`);
              }
            }

            if (thread.linkedThreadIds.length > 0) {
              console.log("\n  Linked threads:");
              for (const id of thread.linkedThreadIds) {
                console.log(`    - ${id}`);
              }
            }
            return;
          }

          const threads = await threading.getAllThreads();

          if (threads.length === 0) {
            console.log("No conversation threads yet. Enable threading with threadingEnabled: true");
            return;
          }

          console.log(`\n=== Conversation Threads (${Math.min(top, threads.length)} of ${threads.length}) ===\n`);
          for (const thread of threads.slice(0, top)) {
            const updated = new Date(thread.updatedAt).toLocaleString();
            console.log(`  ${thread.title}`);
            console.log(`    ID: ${thread.id}`);
            console.log(`    Episodes: ${thread.episodeIds.length} | Updated: ${updated}`);
            console.log();
          }
        });

      cmd
        .command("chunks")
        .description("Show chunking statistics and orphaned chunks")
        .option("-p, --parent <id>", "Show chunks for a specific parent memory ID")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const parentId = options.parent;

          const memories = await orchestrator.storage.readAllMemories();

          if (parentId) {
            // Show chunks for specific parent
            const chunks = memories
              .filter((m) => m.frontmatter.parentId === parentId)
              .sort((a, b) => (a.frontmatter.chunkIndex ?? 0) - (b.frontmatter.chunkIndex ?? 0));

            if (chunks.length === 0) {
              console.log(`No chunks found for parent: ${parentId}`);
              return;
            }

            const parent = memories.find((m) => m.frontmatter.id === parentId);
            console.log(`\n=== Chunks for ${parentId} ===\n`);
            if (parent) {
              console.log(`Parent: ${parent.content.slice(0, 100)}...`);
              console.log();
            }

            for (const chunk of chunks) {
              console.log(
                `  [${(chunk.frontmatter.chunkIndex ?? 0) + 1}/${chunk.frontmatter.chunkTotal}] ${chunk.content.slice(0, 80)}...`,
              );
            }
            return;
          }

          // Show overall chunking stats
          const chunked = memories.filter((m) => m.frontmatter.tags?.includes("chunked"));
          const chunks = memories.filter((m) => m.frontmatter.parentId);

          // Find orphaned chunks (parent no longer exists)
          const parentIds = new Set(chunked.map((m) => m.frontmatter.id));
          const orphans = chunks.filter((m) => !parentIds.has(m.frontmatter.parentId!));

          console.log("\n=== Chunking Statistics ===\n");
          console.log(`  Chunked memories (parents): ${chunked.length}`);
          console.log(`  Total chunks: ${chunks.length}`);
          console.log(`  Orphaned chunks: ${orphans.length}`);

          if (chunked.length > 0) {
            // Calculate average chunks per parent
            const avgChunks = chunks.length / chunked.length;
            console.log(`  Average chunks per parent: ${avgChunks.toFixed(1)}`);
          }

          if (orphans.length > 0) {
            console.log("\n  Orphaned chunk IDs:");
            for (const orphan of orphans.slice(0, 10)) {
              console.log(`    - ${orphan.frontmatter.id}`);
            }
            if (orphans.length > 10) {
              console.log(`    ... and ${orphans.length - 10} more`);
            }
          }
        });

      // Transcript commands
      cmd
        .command("transcript")
        .description("View conversation transcripts")
        .option("--date <date>", "View transcript for specific date (YYYY-MM-DD)")
        .option("--recent <duration>", "View recent transcript (e.g., 12h, 30m)")
        .option("--channel <key>", "Filter by channel/session key")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const date = options.date;
          const recent = options.recent;
          let channel = options.channel;

          // Expand shorthand channel names to full sessionKey patterns
          if (channel && !channel.includes(":")) {
            // Convert "main" -> "agent:generalist:main"
            // Convert "discord" -> "agent:generalist:discord" (will match all discord channels)
            // Convert "cron" -> "agent:generalist:cron" (will match all cron jobs)
            if (channel === "main") {
              channel = "agent:generalist:main";
            } else if (["discord", "slack", "cron", "telegram"].includes(channel)) {
              channel = `agent:generalist:${channel}`;
            }
          }

          if (date) {
            // Read specific date
            const entries = await orchestrator.transcript.readRange(
              `${date}T00:00:00Z`,
              `${date}T23:59:59Z`,
              channel,
            );
            console.log(formatTranscript(entries));
          } else if (recent) {
            // Parse duration (e.g., "12h", "30m")
            const hours = parseDuration(recent);
            const entries = await orchestrator.transcript.readRecent(hours, channel);
            console.log(formatTranscript(entries));
          } else {
            // Default: show today's transcript
            const today = new Date().toISOString().slice(0, 10);
            const entries = await orchestrator.transcript.readRange(
              `${today}T00:00:00Z`,
              `${today}T23:59:59Z`,
              channel,
            );
            console.log(formatTranscript(entries));
          }
        });

      // Checkpoint command
      cmd
        .command("checkpoint")
        .description("View current compaction checkpoint (if any)")
        .action(async () => {
          const checkpoint = await orchestrator.transcript.loadCheckpoint();
          if (!checkpoint) {
            console.log("No active checkpoint found.");
            return;
          }
          console.log(`Checkpoint for session: ${checkpoint.sessionKey}`);
          console.log(`Captured at: ${checkpoint.capturedAt}`);
          console.log(`Expires at: ${checkpoint.ttl}`);
          console.log(`Turns: ${checkpoint.turns.length}`);
          console.log("\n---\n");
          console.log(orchestrator.transcript.formatForRecall(checkpoint.turns, 2000));
        });

      // Summaries command
      cmd
        .command("hourly")
        .description("View hourly summaries")
        .option("--channel <key>", "Filter by channel/session key")
        .option("--recent <hours>", "Show recent summaries (hours)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const channel = options.channel ?? "default";
          const recentHours = options.recent ? parseInt(options.recent, 10) : 24;

          const summaries = await orchestrator.summarizer.readRecent(channel, recentHours);
          if (summaries.length === 0) {
            console.log(`No summaries found for channel: ${channel}`);
            return;
          }

          console.log(orchestrator.summarizer.formatForRecall(summaries, summaries.length));
        });
    },
    { commands: ["engram"] },
  );
}

function formatTranscript(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return "No transcript entries found.";

  return entries
    .map((e) => {
      const time = e.timestamp.slice(11, 16); // HH:MM
      return `[${time}] ${e.role}: ${e.content.slice(0, 200)}${e.content.length > 200 ? "..." : ""}`;
    })
    .join("\n");
}

function parseDuration(duration: string): number {
  // Parse strings like "12h", "30m", "2h30m"
  const hours = duration.match(/(\d+)h/);
  const minutes = duration.match(/(\d+)m/);
  let total = 0;
  if (hours) total += parseInt(hours[1], 10);
  if (minutes) total += parseInt(minutes[1], 10) / 60;
  return total || 12; // Default to 12 hours
}
