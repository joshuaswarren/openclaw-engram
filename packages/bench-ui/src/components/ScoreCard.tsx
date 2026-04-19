import type { BenchmarkCard } from "../bench-data";
import {
  formatDelta,
  formatMetricValue,
  formatTimestamp,
  humanizeIdentifier,
} from "../bench-data";

export function ScoreCard({ card }: { card: BenchmarkCard }) {
  return (
    <article className="score-card">
      <div className="score-card__header">
        <div>
          <span className="section-kicker">{card.latest.benchmarkTier}</span>
          <h4>{humanizeIdentifier(card.benchmark)}</h4>
        </div>
        <span className="score-card__timestamp">{formatTimestamp(card.latest.timestamp)}</span>
      </div>

      <div className="score-card__score-row">
        <strong>{formatMetricValue(card.latest.primaryScore, card.latest.primaryMetric ?? undefined)}</strong>
        <span
          className={`delta-pill${
            card.delta !== null && card.delta > 0
              ? " delta-pill--positive"
              : card.delta !== null && card.delta < 0
                ? " delta-pill--negative"
                : ""
          }`}
        >
          {formatDelta(card.delta, card.latest.primaryMetric ?? undefined)}
        </span>
      </div>

      <dl className="score-card__meta">
        <div>
          <dt>Metric</dt>
          <dd>{card.latest.primaryMetric ?? "n/a"}</dd>
        </div>
        <div>
          <dt>System</dt>
          <dd>{card.latest.systemProvider}</dd>
        </div>
        <div>
          <dt>Judge</dt>
          <dd>{card.latest.judgeProvider}</dd>
        </div>
      </dl>
    </article>
  );
}
