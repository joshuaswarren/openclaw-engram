import { useState } from "react";
import { useParams } from "react-router-dom";
import type { BenchResultSummaryPayload } from "../bench-data";
import {
  benchmarkRuns,
  buildHistogram,
  formatMetricValue,
  formatTimestamp,
  humanizeIdentifier,
} from "../bench-data";
import { CostSummary } from "../components/CostSummary";
import { TaskBreakdown } from "../components/TaskBreakdown";

export function BenchmarkDetail({ payload }: { payload: BenchResultSummaryPayload }) {
  const { benchmarkId } = useParams();
  const runs = benchmarkId ? benchmarkRuns(payload, benchmarkId) : [];
  const [selectedRunId, setSelectedRunId] = useState<string>(runs[0]?.id ?? "");
  const selected = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;

  if (!benchmarkId || !selected) {
    return (
      <section className="page">
        <header className="page-header">
          <div>
            <span className="section-kicker">Benchmark detail</span>
            <h3>Benchmark not found</h3>
          </div>
          <p>Choose a benchmark from Overview or Runs to inspect its task-level detail.</p>
        </header>
      </section>
    );
  }

  const histogram = buildHistogram(selected);
  const taskRows = selected.taskSummaries.map((task) => ({
    taskId: task.taskId,
    baseline: null,
    candidate: task.primaryScore,
    delta: null,
    question: task.question,
    latencyMs: task.latencyMs,
  }));
  const lowScoring = taskRows
    .filter((task) => (task.candidate ?? 1) < 0.6)
    .sort((left, right) => (left.candidate ?? 1) - (right.candidate ?? 1));

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Benchmark detail</span>
          <h3>{humanizeIdentifier(benchmarkId)}</h3>
        </div>
        <p>
          Latest local metrics, task score distribution, and failure analysis for this benchmark family.
        </p>
      </header>

      <section className="panel controls-grid">
        <label>
          <span>Inspect run</span>
          <select value={selected.id} onChange={(event) => setSelectedRunId(event.target.value)}>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id} · {formatTimestamp(run.timestamp)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <div className="detail-hero">
        <article className="stat-card">
          <span>Primary score</span>
          <strong>{formatMetricValue(selected.primaryScore)}</strong>
          <p>{selected.primaryMetric ?? "No primary metric"}</p>
        </article>
        <article className="stat-card">
          <span>Metric stack</span>
          <strong>{selected.aggregateMetrics.length}</strong>
          <p>{selected.aggregateMetrics.map((metric) => metric.name).slice(0, 4).join(", ") || "No aggregates"}</p>
        </article>
      </div>

      <CostSummary summary={selected} />

      <section className="panel">
        <div className="section-title">
          <span className="section-kicker">Distribution</span>
          <h4>Task score histogram</h4>
        </div>
        <div className="histogram">
          {histogram.map((bucket) => (
            <div className="histogram__bucket" key={bucket.label}>
              <div className="histogram__bar-wrap">
                <div className="histogram__bar" style={{ height: `${Math.max(bucket.count * 18, 12)}px` }} />
              </div>
              <strong>{bucket.count}</strong>
              <span>{bucket.label}</span>
            </div>
          ))}
        </div>
      </section>

      <TaskBreakdown rows={taskRows} title="Task-level score breakdown" />

      <section className="panel">
        <div className="section-title">
          <span className="section-kicker">Failure analysis</span>
          <h4>Lowest-scoring tasks</h4>
        </div>
        {lowScoring.length > 0 ? (
          <ul className="failure-list">
            {lowScoring.slice(0, 5).map((task) => (
              <li key={task.taskId}>
                <strong>{task.taskId}</strong>
                <span>{formatMetricValue(task.candidate)}</span>
                <p>{task.question}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-copy">No low-scoring task cluster was detected for the selected run.</p>
        )}
      </section>
    </section>
  );
}
