# Lightweight Douyin collector: source and licenses

This application adapts the lightweight WebSocket collector, transport field
definitions and event mapping from [ymstar/dyhub](https://github.com/ymstar/dyhub),
pinned to commit `21251a1150b7320abaac7ab8222cfa6856abcee2` (2026-11-03).
The relevant upstream sources are `src/collector/lightweightSession.ts`,
`src/proto/douyin.proto.ts` and `src/pipeline/normalizer.ts`.
Copyright (c) 2026 DyHub Contributors. Their MIT license is reproduced at
`third_party/douyin-sign/DYHUB-LICENSE`.

The adapted modules are `lightweight-session.mjs`, `douyin-wire.mjs`,
`douyin-events.mjs` and `collector-runtime.mjs`. Changes include cancellable
startup and reconnects, strict transport limits, incremental gift-combo counts,
event deduplication, bounded caches, separate capture status and integration
with this application's existing printing data bridge. DyHub's dashboard,
Docker deployment and account management are not included.

The **unchanged** `third_party/douyin-sign/sign.js` and `a_bogus.js` assets
originate from [saermart/DouyinLiveWebFetcher](https://github.com/saermart/DouyinLiveWebFetcher)
and retain their **AGPL-3.0** license. The full license is included at
`third_party/douyin-sign/LICENSE`; provenance and original Git blob hashes are
recorded in that directory's `NOTICE.md`. These files have a separate license
from DyHub's MIT collector. Signing runs locally; there is no signing-service
subscription or remote signing API in this integration.

The bundled Node dependencies and full licenses are:

- `ws` 8.22.1 — MIT; `node_modules/ws/LICENSE`.
- `protobufjs` 8.8.1 — BSD-3-Clause; `node_modules/protobufjs/LICENSE`.
- `long` 5.3.2 — Apache-2.0; `node_modules/long/LICENSE`.

Exact npm dependency versions and integrity values are recorded in
`package-lock.json`. All paths above are relative to the source root, or to the
`app` directory inside the portable Windows package. This notice describes
third-party components; it does not assign a license to the rest of this project.
