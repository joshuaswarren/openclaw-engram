import { runBenchmarkStoredBaselineCiGateCliCommand } from "../src/cli.js";

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const base = readArg("--base");
const candidate = readArg("--candidate");
const snapshotId = readArg("--snapshot-id");

if (!base || !candidate || !snapshotId) {
  console.error("Usage: tsx scripts/eval-baseline-ci-gate.ts --base <dir> --candidate <dir> --snapshot-id <id>");
  process.exit(1);
}

const report = await runBenchmarkStoredBaselineCiGateCliCommand({
  baseEvalStoreDir: base,
  candidateEvalStoreDir: candidate,
  snapshotId,
});

console.log(JSON.stringify(report, null, 2));
console.log(report.markdownReport);
if (!report.passed) {
  process.exitCode = 1;
}
