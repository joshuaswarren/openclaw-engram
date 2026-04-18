import os from "node:os";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadBenchResultSummaries } from "./src/results.js";

function resolveResultsDir(): string {
  const configuredDir = process.env.REMNIC_BENCH_RESULTS_DIR;
  if (configuredDir && configuredDir.trim().length > 0) {
    return path.resolve(configuredDir);
  }

  return path.join(os.homedir(), ".remnic", "bench", "results");
}

function benchResultsApi() {
  return {
    name: "remnic-bench-results-api",
    configureServer(server: {
      middlewares: {
        use(
          route: string,
          handler: (
            req: { method?: string | undefined },
            res: {
              statusCode: number;
              setHeader(name: string, value: string): void;
              end(body: string): void;
            },
          ) => Promise<void>,
        ): void;
      };
    }) {
      server.middlewares.use("/api/results", async (req, res) => {
        if ((req.method ?? "GET") !== "GET") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        try {
          const payload = await loadBenchResultSummaries(resolveResultsDir());
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(payload));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), benchResultsApi()],
});
