# Trailin — local email agent

A locally-run AI email agent for **Gmail and Outlook / Microsoft 365**, built on:

- **[pi](https://github.com/badlogic/pi-mono)** (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`) — the agent loop and LLM layer
- **Pipedream Connect + MCP** — managed OAuth for Google/Microsoft; email tools come from Pipedream's MCP server, one session per connected account, so **several Gmail and Outlook accounts work at the same time**
- **Fastify** API server with **SQLite** (Drizzle) persistence and a **node-cron** automation scheduler
- **Vite + React + shadcn-style UI** (Tailwind v4)

```
apps/
  server/   Fastify API: chat (SSE), Pipedream Connect, mail sync, automations + scheduler
  web/      Vite/React UI: Home briefing, Automations, Settings + a persistent chat rail
packages/
  shared/   Types shared between server and web
```

## Setup

1. **Install** (Node 20+, pnpm):

   ```sh
   pnpm install
   ```

2. **Run** (starts server on :3001 and web on :5173):

   ```sh
   pnpm dev
   ```

3. **Configure in the app** — open http://localhost:5173 → **Settings**:

   1. Sign in to an AI provider (Claude/Copilot/ChatGPT subscription, or an API key) and pick a model.
   2. Under **Connect email**, follow the one-time Pipedream setup: create a free account, create an OAuth client under [Settings → API](https://pipedream.com/settings/api) (copy Client ID + Secret), create a [project](https://pipedream.com/projects) and paste its URL. The form checks the values with Pipedream before saving.
   3. Hit **Connect an account**, pick a provider (Gmail and Outlook are suggested; the search covers Pipedream's full catalog) and finish the sign-in. Repeat to add more accounts — several from the same provider is fine. The Outlook connector covers outlook.com and Microsoft 365 / Exchange Online work accounts.

## Hosted / single-process mode

`pnpm build` builds the web app; when `apps/web/dist` exists, the server serves it itself:

```sh
pnpm build
pnpm start   # everything on http://localhost:3001
```

## How it works

- Each chat conversation gets its own **pi Agent**. On creation, the server connects to Pipedream's MCP server (`https://remote.mcp.pipedream.net/v3`) **once per connected account**, pinned with `x-pd-account-id` and in `tools-only` mode (structured parameters, no sub-agent), lists the tools, and bridges them into pi `AgentTool`s. With several accounts of the same app, tool names carry an account suffix (`gmail-find-email__work`) and every description names the account it acts as.
- **Automations** are cron-scheduled standing instructions ("summarize unread mail every weekday at 8am"). Each run spins up a fresh agent, executes the instruction, and stores the result in SQLite (visible under *Recent runs*).
- A **local mail mirror** syncs each connected account into SQLite (`mail_*` tables + FTS5 full-text search) through provider registries (Gmail, Outlook, demo). It currently powers waiting-for detection; briefing and enrichment build on it.
- Provider-specific code (drafts, sync, attachments) lives behind registries in `src/email/` — new providers register in the `register*.ts` files, nothing else hardcodes a provider.
- Conversation transcripts, automations, and the mail mirror live in `data/trailin.db`. Agent context (tool-call history) is in-memory per conversation and resets on server restart.

## Development

- **Demo mode:** `TRAILIN_DEMO=1` runs against a seeded fake mailbox — no Pipedream or email credentials needed.
- **Tests:** `pnpm --filter @trailin/server test` (vitest). Tests live in `apps/server/test/`, mirroring `src/` — never colocated.

## Current limitations (v1)

- Single user (one `PIPEDREAM_EXTERNAL_USER_ID`) — fine for desktop, needs per-user ids before multi-tenant hosting.
- Automations only *run and report*; triggers (e.g. "on new email") would use Pipedream triggers/webhooks — a natural next step.
- MCP sessions are created per conversation; a very long-lived conversation may need a new conversation once the Pipedream access token expires (~1h).
