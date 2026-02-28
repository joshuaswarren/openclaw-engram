# Live Graph Dashboard (v8.8)

The live graph dashboard is an optional sidecar process for graph observability.

It serves:
- `GET /api/graph` — current parsed graph snapshot
- `GET /api/health` — runtime health/status payload
- WebSocket stream (same host/port) — patch updates after graph file changes

## Start / Stop / Status

```bash
openclaw engram dashboard start --host 127.0.0.1 --port 4319
openclaw engram dashboard status
openclaw engram dashboard stop
```

Default behavior:
- Separate process boundary from gateway hot path.
- Loopback bind by default (`127.0.0.1`).
- Graceful degradation when graph files are missing/corrupt (health endpoint remains available).

## Safety Notes

- Keep loopback bind unless you explicitly need remote access.
- If you expose non-loopback binds, place the service behind network controls.
- Dashboard is read-only and does not mutate memory artifacts.

