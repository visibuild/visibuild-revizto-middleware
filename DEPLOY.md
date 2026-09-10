# Deploying to Cloudflare – from scratch

This is the whole path from an empty machine to a running sync: create the two
storage bindings, set two secrets, deploy, register a Revizto application, then
configure everything else in the browser.

Nothing here needs a paid Cloudflare plan. KV, D1 and cron triggers are all
available on the free tier.

- [1. Prerequisites](#1-prerequisites)
- [2. Get the code and install](#2-get-the-code-and-install)
- [3. Log in to Cloudflare](#3-log-in-to-cloudflare)
- [4. Create the KV namespace](#4-create-the-kv-namespace)
- [5. Create the D1 database](#5-create-the-d1-database)
- [6. Deploy](#6-deploy)
- [7. Set the two secrets](#7-set-the-two-secrets)
- [8. Register the Revizto application](#8-register-the-revizto-application)
- [9. Configure it in the browser](#9-configure-it-in-the-browser)
- [10. Set up your first project pair](#10-set-up-your-first-project-pair)
- [Day-to-day](#day-to-day)
- [Local development](#local-development)
- [Troubleshooting](#troubleshooting)

## 1. Prerequisites

- **Node.js 20 or newer** and npm.
- **A Cloudflare account.** The free plan is enough.
- **Visibuild API credentials** – a client ID and secret with the client
  credentials grant and read scope. In Visibuild: Company settings -> API.
- **A Revizto account** that is a member of the projects you want to sync into,
  and access to your organisation account's **Developer portal**.

## 2. Get the code and install

```bash
git clone <your-fork-or-copy> visibuild-revizto-middleware
cd visibuild-revizto-middleware
npm install
```

## 3. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser to authorise Wrangler against your account.

## 4. Create the KV namespace

KV holds the configuration, the per-pair mappings, the Revizto OAuth tokens and
the cached Visibuild lookups.

```bash
npx wrangler kv namespace create CONFIG
```

It prints something like:

```
[[kv_namespaces]]
binding = "CONFIG"
id = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
```

Copy that `id` into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_ID`.

The namespace's _title_ is arbitrary – only the `binding = "CONFIG"` line matters
to the code. If your account already has a namespace called `CONFIG`, create this
one under another title and paste its id in just the same. Do not point two
Workers at one namespace: this app owns the whole `config` document and will
overwrite anything else stored under that key.

## 5. Create the D1 database

D1 holds the sync state: the project pairs, the visi-to-issue links and the run
log.

```bash
npx wrangler d1 create visibuild-revizto-middleware
```

Copy the printed `database_id` into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_ID`. Then create the tables:

```bash
npm run db:migrate
```

`schema.sql` is idempotent, so re-running it after a `git pull` is safe.

## 6. Deploy

```bash
npm run deploy
```

Wrangler prints the URL, e.g. `https://visibuild-revizto-middleware.<you>.workers.dev`.
Note it down – you need it in step 8.

The deploy also registers the hourly cron trigger from `wrangler.toml`.

### Who can reach it

By default Cloudflare serves the Worker at `<name>.<your-subdomain>.workers.dev`
and gives every deployed version its own preview URL as well. Every page is
password-gated and sent with `noindex`, but those hostnames are public and each
preview URL runs the same code against the same KV and D1.

For an internal tool holding API credentials, consider tightening it:

```toml
# wrangler.toml
preview_urls = false   # no per-version hostnames
workers_dev  = false   # no *.workers.dev at all; serve it from a route instead
```

Setting `workers_dev = false` means you must add a custom domain or route,
otherwise the Worker is unreachable. Cloudflare Access in front of the route is
worth considering if you want SSO rather than a shared password.

Note that the `*.workers.dev` subdomain is **per account, not per Worker**:
changing it renames the URL of every Worker on the account at once.

## 7. Set the two secrets

These are the only secrets the Worker itself needs. Everything else is entered
in the app.

```bash
# The admin password: connections, mappings, manual syncs.
npx wrangler secret put ADMIN_PASSWORD

# Signs the login cookies. Piped straight in, so it is never displayed or
# stored anywhere – you never need to see this value.
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
```

The first prompts for the value; nothing is echoed or written to disk.

**Until both exist, nobody can sign in** – `ADMIN_PASSWORD` is undefined, so every
password is rejected. That is the safe default, but it does mean a fresh deploy
looks broken until this step is done.

> Changing `SESSION_SECRET` later signs everyone out, which is the quickest way
> to revoke access if a session leaks.

## 8. Register the Revizto application

Revizto has **no machine-to-machine flow** – every access token belongs to a
user. The sync therefore acts as whoever connects it, so use an account that
will stay a member of the projects you are mirroring into. A shared integration
account is a better choice than a person who might change roles.

1. In Revizto Workspace, open the **Developer portal**
   ([user manual](https://help.revizto.com/hc/en-us/articles/16924350271119-Revizto-developer-portal)).
2. Add an application. When asked for a **redirect URI**, use your Worker URL
   plus `/settings/revizto/callback`, for example:

   ```
   https://visibuild-revizto-middleware.<you>.workers.dev/settings/revizto/callback
   ```

   It must match character for character. A trailing slash, or `http` instead of
   `https`, is enough to be refused as `invalid_client`. The app's Settings page
   shows the exact string to paste.

3. Copy the **client ID** and **client secret**. The secret is shown **exactly
   once** and cannot be retrieved afterwards by anyone, including Revizto
   support – save it before closing the dialog.
4. Set the application to **Active**. An inactive application cannot obtain
   authorisation codes.

Applications are registered per region, and regions are fully independent. If
your licence is in Sydney, register there and choose Sydney in the app.

## 9. Configure it in the browser

Every section on this page saves on its own, so you can get one system working
before you touch the other.

1. Open `https://<your-worker-url>/settings/login`.
2. Sign in with the `ADMIN_PASSWORD` from step 7.
3. **Visibuild connection** – set the API base URL for your region (AU, EU or
   US), paste the client ID and secret, and press **Save & test**. Confirm it
   answers before moving on.
4. **Revizto connection** – choose the region, paste the client ID and secret,
   and press **Save**. Now press **Connect Revizto** and sign in. You are
   returned to Settings, which will show who the sync is acting as.
5. **Sync scope** – decide which visis are eligible. The default is every
   non-archived root visi.
6. **What to carry across** – description, checklist answers, status history and
   photos. Photos are the slowest part of a run; the run limits cap them.
7. **Read-only access** – optionally set a viewer password so others can watch
   the dashboard and sync log without being able to change anything.

## 10. Set up your first project pair

1. Go to **Projects** and pick a Visibuild project, a Revizto licence, then a
   Revizto project. Create the pair.
2. On the pair's mapping page, work down the form:
   - **Statuses** – every Visibuild visi status to a Revizto issue status.
     Set a default so nothing is silently dropped.
   - **Issue types** – by category, type or subtype. Set a default.
   - **People** – anyone whose email matches on both sides needs no mapping and
     is marked as such; map the rest, or let them fall back to a default.
   - **Companies** – a visi can be assigned to a company, but Revizto only
     accepts an individual, so nominate who receives that company's visis.
   - **Locations** – assign each level of the Visibuild location tree to one of
     Revizto's five location tags.
   - **Tags**, **Priority**, **Visibility**, and optionally a per-pair scope.
3. Save, then press **Sync now**.
4. Check the run on the **Sync log** – it lists every visi and what happened.

Start with a small project, or narrow the scope, so the first run is easy to
read.

## Keeping your resource ids out of git

`wrangler.toml` ships with `REPLACE_WITH_YOUR_KV_ID` and `REPLACE_WITH_YOUR_D1_ID`
placeholders. Filling them in is fine for a private repo. For a public one, keep
them out of git instead:

```bash
cp wrangler.toml wrangler.local.toml   # already git-ignored
# put the real ids in wrangler.local.toml, leave wrangler.toml on placeholders
npm run deploy:live                    # deploys with the local config
npm run dev:live                       # same, for local development
```

A KV namespace id and a D1 database id are not credentials – they are useless
without access to the account – but they are account-specific, and a fork has to
replace them anyway.

**The catch:** the two files are independent copies, so anything else you change
in `wrangler.toml` (the cron schedule, a new binding) has to be mirrored into
`wrangler.local.toml`, or your deploys will quietly keep the old value. If that
trade is not worth it, commit the real ids and use plain `npm run deploy`.

## Day-to-day

- The sync runs **hourly** by default. Change `crons` in `wrangler.toml` and
  redeploy to alter that.
- **Sync now** on the dashboard runs everything; the button on a pair's page
  runs just that pair.
- **Pause sync** on a pair stops it without losing the mapping or the links.
- **Re-read everything** clears a pair's watermarks so the next run re-checks
  every visi. Existing issues are updated, not duplicated.
- Update the code with `git pull && npm install && npm run db:migrate && npm run deploy`
  (`npm run deploy:live` if you keep your ids in `wrangler.local.toml`).

## Local development

```bash
cp .dev.vars.example .dev.vars   # then edit the two values
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

Local dev uses a simulated KV store and a local SQLite D1, so no Cloudflare
resources are touched.

To connect Revizto locally, register a second application with this redirect URI
– note there is **no port**:

```
http://localhost/settings/revizto/callback
```

Revizto matches a loopback URI on any port, so one port-less registration covers
whatever port `wrangler dev` ends up on. Pinning the port is a documented
mistake: it breaks the moment 8787 is taken. Loopback URIs also require PKCE,
which this app always sends.

Cron triggers do not fire automatically in local dev. Trigger one by hand:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Troubleshooting

**The dashboard says the database tables are missing.**
Run `npm run db:migrate` (or `db:migrate:local`). If it still fails, check that
the `database_id` in `wrangler.toml` matches the one `wrangler d1 create`
printed.

**Revizto sign-in fails with `invalid_client`.**
The client ID is wrong, or the redirect URI does not match the registration
character for character. Compare them side by side, including the scheme and any
trailing slash.

**The dashboard says "Reconnect needed".**
The refresh token has lapsed – refresh tokens last a month and are revoked if
the client secret is regenerated or the application is deactivated. Press
**Connect Revizto** again. If the user's authorisation is still on file, this
completes without a manual sign-in.

**A visi synced, but its status or type is wrong in Revizto.**
Check the run detail. An unmapped status falls back to the default and says so
in the warnings. If a field did not move at all, someone may have edited it in
Revizto – the sync logs that as an overwrite.

**Nothing is syncing and the log says visis were skipped.**
The scope excludes them. Widen the scope in Settings, or on the pair. Remember
that the scope only gates _creation_: a visi already mirrored keeps syncing.

**Runs are marked "Partial" with "stopped at the per-run cap".**
That is the caps working as intended on a backlog. Each run picks up where the
last stopped, so it clears itself; press **Sync now** a few times, or raise the
limits in Settings.

**Visibuild returns HTTP 429.**
The Visibuild API is rate-limiting this app. Wait about a minute. If it recurs,
lower the visis-per-run limit or pair fewer projects.
