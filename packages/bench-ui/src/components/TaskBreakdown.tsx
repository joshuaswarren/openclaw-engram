import type { TaskDeltaRow } from "../bench-data";
import { formatDuration, formatMetricValue } from "../bench-data";

export function TaskBreakdown({
  rows,
  title,
}: {
  rows: TaskDeltaRow[];
  title: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="panel panel--empty">
        <p>No task-level data was available for this benchmark run.</p>
      </div>
    );
  }

  return (
    <section className="panel">
      <div className="section-title">
        <span className="section-kicker">Tasks</span>
        <h4>{title}</h4>
      </div>
      <div className="task-stack">
        {rows.slice(0, 8).map((row) => (
          <article className="task-card" key={row.taskId}>
            <div className="task-card__header">
              <strong>{row.taskId}</strong>
              <span>{formatDuration(row.latencyMs)}</span>
            </div>
            <p>{row.question}</p>
            <div className="task-card__scores">
              <span>Baseline {formatMetricValue(row.baseline)}</span>
              <span>Candidate {formatMetricValue(row.candidate)}</span>
              <span>Delta {formatMetricValue(row.delta)}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
