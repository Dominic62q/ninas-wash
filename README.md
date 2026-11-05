# Niinas Wash

Car wash management for a single location in Ghana: jobs, split payments (cash + MoMo), commissions, tips, expenses and the daily cash-up.

## What is in here

| Folder | What it is |
|---|---|
| `apps/web` | The app people use. React + Vite, installable as a PWA, works on desktop and phones. |
| `apps/api` | The server. Fastify + Drizzle on PostgreSQL. It owns every rule about money and permissions. |
| `packages/shared` | Code both sides use: money helpers, roles and permissions, validation schemas. |

The app is **online-only** by design. If the connection drops, the screen says so and nothing is saved.

## Run it

You need Node 22 or newer. No Docker.

```bash
npm install
npm run dev           # terminal 1: PostgreSQL (port 5433, data in .pgdata/), the API (3001) and the web app (5173)
npm run db:migrate    # terminal 2, once, and again after pulling new migrations
npm run db:seed       # terminal 2, once: creates an owner, a manager and a cashier
```

Each part also runs alone: `npm run dev:db`, `npm run dev:api`, `npm run dev:web`.

The seed writes random passwords to `.dev-credentials.txt` (git-ignored). Open http://localhost:5173 and sign in.

To use another database, set `DATABASE_URL` in `apps/api/.env`.

## Going live

See [DEPLOY.md](DEPLOY.md): the web app on Vercel and the API on a VPS in Docker (Caddy for HTTPS, PostgreSQL), nightly backups, and how updates reach people (a "new version is ready" prompt, never a surprise reload).

## Everyday commands

```bash
npm run typecheck     # TypeScript check, all packages
npm test              # all tests (the API tests start their own throwaway Postgres)
npm run db:generate   # after editing apps/api/src/db/schema.ts: writes a new migration
```

## Rules that hold everywhere

- Money is a whole number of pesewas. GH₵12.50 is `1250`. Only the screen turns it into text.
- Records that matter are voided, never deleted. The database refuses deletes.
- The audit log can only be added to. The database refuses edits and deletes.
- The server decides what each role may do (`packages/shared/src/roles.ts`). The web app only uses the same table to hide buttons.
