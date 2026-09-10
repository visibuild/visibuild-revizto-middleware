# Visibuild -> Revizto middleware

Keeps recently created or updated **visis** in a [Visibuild](https://visibuild.com)
project mirrored into a [Revizto](https://revizto.com) project as **issues**,
with a small web UI for the mapping that makes the mirror meaningful – which
person, which location, which status, which issue type.

It runs on [Cloudflare Workers](https://workers.cloudflare.com): a KV namespace
for configuration, a D1 database for sync state, and an hourly cron trigger.

## How the sync works

Visibuild does not yet emit a webhook event for visi changes, so each run polls
`GET /projects/{projectId}/visis?updatedAfter=…` and works through what came
back. Per project pair, in order:

1. **Read Revizto first.** Sweep the issues changed since the last run. Revizto
   edits are diffs of `{old, new}` pairs and it _silently drops_ a pair whose
   `old` is wrong, so knowing the current value before writing is not optional.
2. **Read Visibuild.** The visis changed since the last run, plus that batch's
   tags, checklist answers, status history and attachments.
3. **Create or update.** A new visi becomes a new issue plus its comments; a
   changed one becomes a `diff` comment, with any new comments appended.
4. **Advance the watermarks** – only over visis that actually succeeded – and
   write the run log.

One direction only: Visibuild is the source of truth. If someone edits a field
in Revizto that the sync also manages, Visibuild wins and the sync log records
exactly what was written over.

## What maps to what

| Visibuild                                              | Revizto                                                 |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `alias` + `title`                                      | Issue title, via a template you control                 |
| `status`                                               | Issue status (mapped per pair)                          |
| `type` / `category` / subtype                          | Issue type (subtype rule beats type beats category)     |
| assignee (person or company)                           | Assignee email                                          |
| creator                                                | Reporter email                                          |
| `dueDate`                                              | Deadline                                                |
| location tree                                          | Revizto's location tags: level, room, area, zone, space |
| tags, plus derived ones                                | Issue tags                                              |
| description, checklist answers, status history, photos | Comments                                                |

A few Revizto facts shape all of this, and are worth knowing before you
configure it:

- **An issue has no description field** – only a title and comments. The visi
  description, checklist and history are therefore written as comments.
- **Location tags can only be set when the issue is created.** There is no diff
  for them. That is why the location path is also written as a tag by default,
  so a visi that later moves still shows the move in Revizto.
- **A visi carries no priority**, so Revizto's priority is derived from the
  visi's category or type through a rule table.
- **Revizto has no machine-to-machine grant.** Every access token belongs to a
  user, so an admin connects once through OAuth and the sync acts as them.
  Access tokens last an hour and refresh tokens a month, rotating on every use.

## Pages

| Route                | Who    | What                                                                                      |
| -------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `/`                  | viewer | Connection health, the project pairs and their progress, the last run, **Sync now**       |
| `/pairs`             | viewer | The pairs; admins can add one                                                             |
| `/pairs/:id`         | viewer | The mapping editor for that pair                                                          |
| `/runs`, `/runs/:id` | viewer | Every run, and what it did to each visi                                                   |
| `/settings`          | admin  | Both connections, the sync scope, run limits, branding – each section saves independently |
| `/healthz`           | anyone | Returns `ok`. The only unauthenticated route, for uptime checks                           |

Two passwords, no user accounts:

| Password   | Set where                           | Unlocks                                   |
| ---------- | ----------------------------------- | ----------------------------------------- |
| **Admin**  | `ADMIN_PASSWORD` secret (at deploy) | Everything                                |
| **Viewer** | Settings page (stored in KV)        | The dashboard and the sync log, read-only |

## Quick start (local)

```bash
npm install
cp .dev.vars.example .dev.vars      # then edit the two values
npm run db:migrate:local            # create the local D1 tables
npm run dev                         # http://localhost:8787
```

Open `http://localhost:8787/settings/login`, sign in with the `ADMIN_PASSWORD`
from `.dev.vars`, then add the Visibuild credentials and connect Revizto.

> Local dev uses a simulated KV store and a local SQLite D1, so you don't need a
> Cloudflare account to try it. You do need a Visibuild OAuth client and a
> Revizto developer-portal application to move real data.

## Deploy to Cloudflare

See **[DEPLOY.md](./DEPLOY.md)** for the complete from-scratch guide, including
registering the Revizto application and the exact redirect URI it needs.

## Scripts

```bash
npm run dev              # local dev server (wrangler)
npm run deploy           # deploy to Cloudflare
npm run dev:live         # ...using wrangler.local.toml, if you keep ids out of git
npm run deploy:live      # ...same, for deploys (see DEPLOY.md)
npm run db:migrate       # apply schema.sql to the remote D1
npm run db:migrate:local # apply schema.sql to the local D1
npm test                 # unit tests (vitest)
npm run test:watch       # ...in watch mode
npm run typecheck        # type-check with tsc
```

## How it fits together

| File                      | Responsibility                                                                  |
| ------------------------- | ------------------------------------------------------------------------------- |
| `src/index.ts`            | Hono app: routes, auth gates, security headers, the cron handler                |
| `src/auth.ts`             | HMAC-signed session cookies (Web Crypto), constant-time password check          |
| `src/config.ts`           | Config and per-pair mappings, stored in KV                                      |
| `src/db.ts`               | D1 sync state: pairs, visi -> issue links, run log                              |
| `src/env.ts`              | The Worker bindings                                                             |
| `src/labels.ts`           | Turning API vocabulary into readable text, acronyms included                    |
| `src/visibuild/`          | Read-only Core API client, resolvers (location tree, users), webhook management |
| `src/revizto/`            | OAuth (with rotation handling) and the v5 API client                            |
| `src/sync/mapping.ts`     | Pure visi -> Revizto field mapping and diffing                                  |
| `src/sync/engine.ts`      | The run loop                                                                    |
| `src/sync/attachments.ts` | Visibuild CDN -> Revizto file comment                                           |
| `src/views/*.ts`          | Server-rendered HTML pages                                                      |
| `schema.sql`              | The D1 tables                                                                   |

Nothing is persisted except the configuration you enter, the sync state, and the
run log.

`src/visibuild/webhooks.ts` and its two routes are built but not exposed: there
is no Visibuild event worth subscribing to yet, so the Settings section that
registers endpoints is hidden behind `SHOW_WEBHOOKS` in `src/views/settings.ts`.
Flip that constant when those events land.

## Where credentials live

Worth being explicit, since this app holds keys to two other systems:

|                                    | Stored in                 | Set by                           |
| ---------------------------------- | ------------------------- | -------------------------------- |
| `ADMIN_PASSWORD`, `SESSION_SECRET` | Cloudflare Worker secrets | `wrangler secret put`, at deploy |
| Visibuild client ID and secret     | KV                        | Settings page                    |
| Revizto client ID and secret       | KV                        | Settings page                    |
| Revizto access and refresh tokens  | KV, under their own key   | The OAuth flow                   |
| Viewer password                    | KV                        | Settings page                    |

Nothing sensitive is committed. `.dev.vars` is git-ignored, and `wrangler.toml`
ships with placeholder resource ids: put your real ones in a git-ignored
`wrangler.local.toml` and deploy with `npm run deploy:live`, or just fill them in
if your repo is private. See [DEPLOY.md](./DEPLOY.md) for the trade-off.

Both secrets are only ever written, never read back. Rotating `SESSION_SECRET`
signs everyone out immediately, which is the fastest way to revoke access.

## Contributing

`npm run typecheck && npm test` should pass before a PR. The sync's field mapping
lives in `src/sync/mapping.ts` and is deliberately pure – no network, no
bindings, no clock beyond what is passed in – so new mapping behaviour should
come with tests in `test/mapping.test.ts`.

## Licence

MIT – see [LICENSE](./LICENSE).
