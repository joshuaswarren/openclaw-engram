import { useEffect, useState } from "react";

function formatNumber(value, digits = 1) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function ResultCard({ summary }) {
  return (
    <article className="result-card">
      <header className="result-card__header">
        <div>
          <p className="eyebrow">{summary.mode}</p>
          <h2>{summary.benchmark}</h2>
        </div>
        <span className="timestamp">{formatTimestamp(summary.timestamp)}</span>
      </header>
      <dl className="stats-grid">
        <div>
          <dt>Tasks</dt>
          <dd>{summary.taskCount}</dd>
        </div>
        <div>
          <dt>Mean latency</dt>
          <dd>{formatNumber(summary.meanQueryLatencyMs)} ms</dd>
        </div>
        <div>
          <dt>Total latency</dt>
          <dd>{formatNumber(summary.totalLatencyMs)} ms</dd>
        </div>
        <div>
          <dt>Run id</dt>
          <dd className="run-id">{summary.id}</dd>
        </div>
      </dl>
      {summary.metricHighlights.length > 0 ? (
        <ul className="metric-list">
          {summary.metricHighlights.map((metric) => (
            <li key={metric.name}>
              <span>{metric.name}</span>
              <strong>{formatNumber(metric.mean, 3)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No aggregate metrics were found in this summary.</p>
      )}
    </article>
  );
}

export function App() {
  const [state, setState] = useState({
    loading: true,
    error: "",
    payload: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/results");
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const payload = await response.json();
        if (!cancelled) {
          setState({ loading: false, error: "", payload });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            error: error instanceof Error ? error.message : String(error),
            payload: null,
          });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page-shell">
      <header className="hero">
        <p className="eyebrow">Phase 4 foundation</p>
        <h1>Benchmark overview</h1>
        <p className="muted">
          Minimal local shell for browsing stored benchmark result summaries.
        </p>
      </header>

      {state.loading ? <p className="panel">Loading benchmark summaries...</p> : null}
      {state.error ? <p className="panel panel--error">{state.error}</p> : null}

      {state.payload ? (
        <>
          <section className="panel meta-panel">
            <div>
              <span className="meta-label">Results directory</span>
              <code>{state.payload.resultsDir}</code>
            </div>
            <div>
              <span className="meta-label">Runs found</span>
              <strong>{state.payload.summaries.length}</strong>
            </div>
          </section>

          {state.payload.summaries.length === 0 ? (
            <p className="panel">
              No benchmark result summaries were found in this directory yet.
            </p>
          ) : (
            <section className="results-grid">
              {state.payload.summaries.map((summary) => (
                <ResultCard key={summary.id} summary={summary} />
              ))}
            </section>
          )}
        </>
      ) : null}
    </main>
  );
}
