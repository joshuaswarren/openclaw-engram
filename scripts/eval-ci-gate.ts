import { runBenchmarkCiGateCliCommand } from "../src/cli.js";

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const base = readArg("--base");
const candidate = readArg("--candidate");

if (!base || !candidate) {
  console.error("Usage: tsx scripts/eval-ci-gate.ts --base <dir> --candidate <dir>");
  process.exit(1);
}

const report = await runBenchmarkCiGateCliCommand({
  baseEvalStoreDir: base,
  candidateEvalStoreDir: candidate,
});

console.log(JSON.stringify(report, null, 2));
if (!report.passed) {
  process.exitCode = 1;
}
