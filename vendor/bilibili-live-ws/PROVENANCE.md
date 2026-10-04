# Vendored dependency

Upstream: https://github.com/simon300000/bilibili-live-ws
Commit: 39bd334bc03c8f340ed158bb1e6118b4f23fca41 (2026-08-12)
Upstream source version: 7.0.0. npm registry still published 6.3.1 when checked.
License: MIT; original LICENSE and author attribution are retained.

The monitor uses this pinned official-only version; it never fetches webpage
WebSocket tokens. `package-lock.json` links the checked-in source directory.
`UPSTREAM-package.json` retains the original manifest.

Local adaptations:
- Drop upstream development/test dependencies from the local package manifest.
- Build only the Node entrypoint with the project's TypeScript compiler; skip
  dependency declaration checking. The browser entrypoint is not used.
- Reject truncated/invalid packet lengths instead of looping on malformed frames.
- Decode uncompressed operation 5/8 JSON in protocol 1 as well as protocol 0.
- Reject unsuccessful authentication; propagate decoder errors through the
  existing error event rather than an unhandled promise rejection.

The application manages session heartbeats, reauthentication, retry backoff,
room verification, and session end itself. It deliberately uses LiveWS rather
than KeepLiveWS so stale session credentials are not reused indefinitely.
