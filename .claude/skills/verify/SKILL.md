---
name: verify
description: Build, run, and drive Trailin (server + web UI) to verify changes end-to-end.
---

# Verifying Trailin changes

## Cheapest first: unit tests

`pnpm --filter @trailin/server test` (vitest; tests in `apps/server/test/`,
mirroring `src/`). Run these before spinning up a server.

## Launch an isolated server instance

The Fastify server serves the built web UI itself when `apps/web/dist` exists,
so one process gives you both the API and the SPA:

```sh
pnpm --filter @trailin/web build          # ~1s; refresh dist after UI changes
cd apps/server
DATABASE_PATH=/tmp/<scratch>/verify.db PORT=3111 pnpm exec tsx src/index.ts
```

- `DATABASE_PATH` isolates SQLite state (tables are auto-created). The user's
  real data is `apps/server/data/` — never point tests there.
- Config env vars (`PIPEDREAM_*`, `ANTHROPIC_API_KEY`, …) can be set per
  instance to simulate .env fallback states. App-saved settings live in the
  `settings` table of the SQLite DB and win over env.
- `TRAILIN_DEMO=1` gives a fully seeded fake mailbox — the way to exercise
  email flows (drafts, sync, waiting, briefing) without real credentials.
- Don't reuse :3001/:5173 — those may be the user's own `pnpm dev`.

## Drive the API

Plain curl against `http://127.0.0.1:<port>/api/...`. Useful states:
- Pipedream config: `GET/PUT/DELETE /api/pipedream` (PUT verifies credentials
  against Pipedream's real OAuth endpoint — fake creds get a 401-wrapped 400,
  so the happy save path needs real credentials).
- Seed app-saved settings directly when real creds are unavailable:
  `sqlite3 verify.db "INSERT INTO settings (key,value) VALUES ('pipedream.clientId','x'),…"`

## Drive the UI headlessly

No Playwright in the repo, but chromium is cached at
`~/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
In a scratch dir: `npm i playwright-core`, then
`chromium.launch({ executablePath: <above>, headless: true })` and open
`http://127.0.0.1:<port>/`. It's a SPA — navigate via the sidebar buttons
(`getByRole("button", { name: "Settings" })`). Screenshot for evidence.
