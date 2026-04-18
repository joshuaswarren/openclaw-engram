import {
  HashRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import type { ReactNode } from "react";

const navigationItems = [
  { label: "Overview", path: "/" },
  { label: "Runs", path: "/runs" },
  { label: "Compare", path: "/compare" },
  { label: "Benchmark detail", path: "/benchmark/latency-ladder" },
  { label: "Providers", path: "/providers" },
];

const overviewCards = [
  { label: "Tracked runs", value: "12", detail: "Latest benchmark summaries" },
  { label: "Active providers", value: "4", detail: "Configured adapters" },
  { label: "Regression delta", value: "0.8%", detail: "Current compare view" },
];

const runRows = [
  ["longmemeval", "complete", "2m 14s"],
  ["latency-ladder", "complete", "58s"],
  ["provider-smoke", "queued", "Pending"],
];

const providerRows = [
  ["@remnic/core", "Built-in memory engine"],
  ["@remnic/server", "Standalone HTTP + MCP server"],
  ["@remnic/plugin-openclaw", "OpenClaw host adapter"],
];

function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-kicker">@remnic/bench-ui</span>
          <h1>Benchmark shell</h1>
          <p>
            Routed scaffold for browsing benchmark summaries, comparisons, and
            provider notes.
          </p>
        </div>

        <nav className="nav-list" aria-label="Bench navigation">
          {navigationItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                `nav-item${isActive ? " nav-item--active" : ""}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="status-chip">local scaffold</span>
            <h2>Remnic benchmark workspace</h2>
          </div>
          <p className="topbar-copy">
            Minimal Vite shell, no data wiring, no publish flow.
          </p>
        </header>

        {children}
      </main>
    </div>
  );
}

function PageFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="section-kicker">Bench UI</span>
          <h3>{title}</h3>
        </div>
        <p>{description}</p>
      </header>

      {children}
    </section>
  );
}

function OverviewPage() {
  return (
    <PageFrame
      title="Overview"
      description="A compact entrypoint for benchmark runs, trend snapshots, and status notes."
    >
      <div className="card-grid">
        {overviewCards.map((card) => (
          <article className="stat-card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.detail}</p>
          </article>
        ))}
      </div>
    </PageFrame>
  );
}

function RunsPage() {
  return (
    <PageFrame
      title="Runs"
      description="Placeholder list for queued and completed benchmark executions."
    >
      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Benchmark</th>
              <th>Status</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runRows.map(([benchmark, status, duration]) => (
              <tr key={benchmark}>
                <td>{benchmark}</td>
                <td>{status}</td>
                <td>{duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageFrame>
  );
}

function ComparePage() {
  return (
    <PageFrame
      title="Compare"
      description="Reserved for side-by-side run comparison once data wiring lands."
    >
      <div className="panel compare-grid">
        <div>
          <span className="section-kicker">Baseline</span>
          <p>Previous run set</p>
        </div>
        <div>
          <span className="section-kicker">Current</span>
          <p>Latest run set</p>
        </div>
        <div>
          <span className="section-kicker">Delta</span>
          <p>Comparison summary placeholder</p>
        </div>
      </div>
    </PageFrame>
  );
}

function BenchmarkDetailPage() {
  const { benchmarkId } = useParams();

  return (
    <PageFrame
      title="Benchmark detail"
      description="Route scaffold for an individual benchmark run."
    >
      <div className="panel detail-card">
        <span className="section-kicker">Benchmark</span>
        <h4>{benchmarkId ?? "unknown"}</h4>
        <p>
          This page is intentionally lightweight. It exists so downstream work
          can attach real benchmark metadata later.
        </p>
      </div>
    </PageFrame>
  );
}

function ProvidersPage() {
  return (
    <PageFrame
      title="Providers"
      description="Placeholder registry for benchmark provider backends and adapters."
    >
      <div className="panel">
        <ul className="provider-list">
          {providerRows.map(([name, detail]) => (
            <li key={name}>
              <strong>{name}</strong>
              <span>{detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </PageFrame>
  );
}

function NotFoundPage() {
  return (
    <PageFrame
      title="Page not found"
      description="This route is not part of the current bench UI scaffold."
    >
      <div className="panel">
        <p>Use the navigation to move between the scaffolded routes.</p>
      </div>
    </PageFrame>
  );
}

export function App() {
  return (
    <HashRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route
            path="/benchmark/:benchmarkId"
            element={<BenchmarkDetailPage />}
          />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/benchmark" element={<Navigate to="/benchmark/latency-ladder" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AppShell>
    </HashRouter>
  );
}
