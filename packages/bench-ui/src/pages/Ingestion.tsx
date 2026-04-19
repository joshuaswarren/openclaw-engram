import { Link } from "react-router-dom";
import type { BenchResultSummaryPayload } from "../bench-data";
import {
  formatDelta,
  formatMetricValue,
  formatTimestamp,
  getBenchmarkCards,
  humanizeIdentifier,
} from "../bench-data";

const INGESTION_BENCHMARKS = [
  "ingestion-entity-recall",
  "ingestion-backlink-f1",
  "ingestion-citation-accuracy",
  "ingestion-schema-completeness",
  "ingestion-setup-friction",
] as const;

const INGESTION_DESCRIPTIONS: Record<string, string> = {
  "ingestion-entity-recall":
    "Recall of people, orgs, projects, topics, and events extracted from raw inbox fixtures against a curated gold entity set.",
  "ingestion-backlink-f1":
    "Precision and F1 of the extracted bidirectional link graph compared to the gold link set.",
  "ingestion-citation-accuracy":
    "Fraction of claims in generated summaries that carry a valid source-chunk citation, verified by the judge.",
  "ingestion-schema-completeness":
    "Pass rate across required frontmatter fields (title, type, state, created, see-also), exec-summary, and timeline on generated pages.",
  "ingestion-setup-friction":
    "Number of commands and prompts required for a human to make the ingested inbox useful. Lower is better.",
};

export function Ingestion({ payload }: { payload: BenchResultSummaryPayload }) {
  const allCards = getBenchmarkCards(payload);
  const ingestionCards = allCards.filter((card) =>
    (INGESTION_BENCHMARKS as readonly string[]).includes(card.benchmark),
  );

  const missingBenchmarks = (INGESTION_BENCHMARKS as readonly string[]).filter(
    (id) => !ingestionCards.some((card) => card.benchmark === id),
  );

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Ingestion</span>
          <h3>Ingestion tier benchmark suite</h3>
        </div>
        <p>
          Five metrics that measure whether Remnic can turn raw input (emails, calendars, project
          folders, chat transcripts) into a well-structured memory graph. Covers entity recall,
          backlink fidelity, citation accuracy, frontmatter schema completeness, and setup friction.
        </p>
      </header>

      {ingestionCards.length === 0 && missingBenchmarks.length === INGESTION_BENCHMARKS.length ? (
        <div className="panel panel--empty">
          <p>
            No ingestion benchmark results found. Run one or more ingestion benchmarks to populate
            this view.
          </p>
        </div>
      ) : (
        <>
          <div className="score-grid">
            {ingestionCards.map((card) => (
              <Link key={card.benchmark} to={`/benchmark/${card.benchmark}`}>
                <article className="score-card">
                  <div className="score-card__header">
                    <div>
                      <span className="section-kicker">ingestion</span>
                      <h4>{humanizeIdentifier(card.benchmark)}</h4>
                    </div>
                    <span className="score-card__timestamp">
                      {formatTimestamp(card.latest.timestamp)}
                    </span>
                  </div>

                  <div className="score-card__score-row">
                    <strong>{formatMetricValue(card.latest.primaryScore)}</strong>
                    <span
                      className={`delta-pill${
                        card.delta !== null && card.delta > 0
                          ? " delta-pill--positive"
                          : card.delta !== null && card.delta < 0
                            ? " delta-pill--negative"
                            : ""
                      }`}
                    >
                      {formatDelta(card.delta)}
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
                  </dl>

                  <p className="score-card__desc">
                    {INGESTION_DESCRIPTIONS[card.benchmark] ?? ""}
                  </p>
                </article>
              </Link>
            ))}
          </div>

          {missingBenchmarks.length > 0 && (
            <section className="panel">
              <div className="section-title">
                <span className="section-kicker">Pending</span>
                <h4>Benchmarks not yet run</h4>
              </div>
              <ul className="failure-list">
                {missingBenchmarks.map((id) => (
                  <li key={id}>
                    <strong>{humanizeIdentifier(id)}</strong>
                    <p>{INGESTION_DESCRIPTIONS[id] ?? ""}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section className="panel">
        <div className="section-title">
          <span className="section-kicker">Reference</span>
          <h4>Ingestion benchmark axis</h4>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Benchmark</th>
              <th>Primary metric</th>
              <th>Latest score</th>
              <th>vs. prior</th>
            </tr>
          </thead>
          <tbody>
            {(INGESTION_BENCHMARKS as readonly string[]).map((id) => {
              const card = ingestionCards.find((c) => c.benchmark === id);
              return (
                <tr key={id}>
                  <td>
                    {card ? (
                      <Link to={`/benchmark/${id}`}>{humanizeIdentifier(id)}</Link>
                    ) : (
                      <span className="muted-copy">{humanizeIdentifier(id)}</span>
                    )}
                  </td>
                  <td>{card?.latest.primaryMetric ?? <span className="muted-copy">—</span>}</td>
                  <td>{card ? formatMetricValue(card.latest.primaryScore) : <span className="muted-copy">—</span>}</td>
                  <td>{card ? formatDelta(card.delta) : <span className="muted-copy">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </section>
  );
}
