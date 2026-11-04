# Upstream attribution and unchanged signing assets

`lightweight-session.mjs` and `douyin-wire.mjs` adapt the lightweight session,
room parsing and transport schema from **DyHub**, commit
`21251a1150b7320abaac7ab8222cfa6856abcee2` (2026-11-03).
Copyright (c) 2026 DyHub Contributors. The original MIT license is reproduced in
`DYHUB-LICENSE`.

Source: https://github.com/ymstar/dyhub/tree/21251a1150b7320abaac7ab8222cfa6856abcee2

The following files were copied **without changes** from that commit's
`third_party/douyin-sign/` directory:

- `sign.js`: Git blob `eef7918321d0938b9851eaafe6c4d22e8ea4cdaf`.
- `a_bogus.js`: Git blob `f5b901f2f1771ef3244a6c8fa0c9f28238a8231e`.

DyHub identifies these signing assets as originating from
https://github.com/saermart/DouyinLiveWebFetcher under **AGPL-3.0**. The upstream
license is reproduced in `LICENSE` (Git blob
`e20b431bcb69267acc39eaf8fdb94c30f40e3223`). They retain their separate license;
the surrounding MIT code does not relicense them. This integration uses the
unchanged local signing asset, not a remote signing service.

Modifications to the MIT collector: bounded framing/inflation/deduplication,
credential-preserving cookies, cancellable HTTP and timers, bounded reconnect
backoff, isolated signing VM with execution deadlines, and callbacks carrying
only transport messages or sanitized state. No upstream dashboard, account
manager, browser collector or Docker deployment is included.
