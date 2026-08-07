# Burndown Engine for Jira Cloud

A burndown chart that rebuilds **day-by-day progress history** from Jira Cloud, plus a
**Signboard** grid showing which function is late at which step.

> **Note on language.** The app UI is in English. The design and operations documents under
> [`docs/`](./docs) are written in Vietnamese for the team that runs this system.

---

## The one idea that makes this different: no baseline

Most burndown charts freeze a plan on day one and measure drift against it. This one does not.

The **Planned** line is recomputed after every sync — *including the part already in the past* —
because it follows the latest plan in Jira. A deadline that moves is not hidden; it is redrawn.

That is a deliberate trade-off, and it has a cost: an Epic whose deadline slips every week can
still look "on schedule" on the chart. So the system carries two counterweights:

- **⚑ markers** on the chart show exactly when a planned date moved and which sub-task caused it.
- **Plan shift history** (`/api/epic/:key/plan-shift-history`) totals how many working days the plan
  has slipped, and warns past 20% of the Phase length.

Every chart response also carries `planIsFloating: true` and a note saying so, so nobody has to
learn this from a surprise.

## How a day's number is decided

For each sub-task, on each day, exactly one of three rules applies — and the API will tell you
which one, per row, in plain sentences:

| Rule | When | Result |
|---|---|---|
| 1 | The sub-task was already in the **Done** status category | 0 hours remain |
| 2 | Someone **manually edited** the remaining estimate | that value wins |
| 3 | Otherwise | `max(0, original estimate − hours logged)` |

**Rule 2 deliberately beats Rule 3.** A human-entered number outranks arithmetic, so logging more
hours does not push it down. This is the single most common source of "the chart looks wrong", which
is why `GET /api/burndown/epic/:key/day/:date/explain` exists: it recomputes the day from raw data,
compares against the stored snapshot, and names the culprit — who edited the estimate, and when.

## Screens

| Screen | What it answers |
|---|---|
| **Epics** | Which Epics are tracked, how each is syncing, and what data is missing |
| **Burndown chart** | Whole Epic, a single Phase, or several Phases side by side |
| **Signboard** | Function × task-type grid — which function is late, at which step |
| **Signboard columns** | Which task types become columns |
| **Phase settings** | Title patterns and matching rules, with a preview before saving |
| **Monitoring** | Nightly jobs, Jira rate limits, data quality, plan drift |

Phase settings are edited by the PM in the browser — no code change, no deploy. Saving is a
two-step flow (**Preview** → **Confirm save**) because a rule change reclassifies real Tasks, and
you should see which ones before it happens.

---

## Quick start

Requires **Node ≥ 20.11** and **pnpm 9.15**. PostgreSQL and Redis are needed to *run* the system,
but not to run the tests — see below.

```bash
pnpm install
cp .env.example .env          # fill in your Jira token, database and Redis URLs
pnpm db:generate
pnpm db:migrate
pnpm dev                      # API :3000 · web :5180 · worker (BullMQ consumer)
```

`pnpm dev` starts the **API** (Fastify, listening on :3000), the **web app** (Vite on :5180) and the
**worker** (BullMQ consumer) in parallel. The web dev server uses port **5180**, not Vite's default
5173 — deliberately, so it never collides with another project on the same machine. The API and
worker each need PostgreSQL, Redis and reachable Jira credentials to start; missing any of them
stops the process with a clear message rather than a half-running server.

> **Why the API and worker run through [`tsx`](https://tsx.is) and not `node --watch`:** Node's
> built-in TypeScript support is *strip-only* — it deletes type annotations but refuses syntax that
> compiles to runtime code, such as constructor parameter properties (`constructor(readonly x)`). So
> `node --watch src/*.ts` crashes with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on Node 22+/24. `tsx`
> fully transpiles the TypeScript, so the dev entry points run on any supported Node.

Full setup instructions, including seeding, are in
[`docs/ONBOARDING.md`](./docs/ONBOARDING.md) *(Vietnamese)*.

### Everyday commands

| Command | What it does |
|---|---|
| `pnpm test` | Every unit test |
| `pnpm test:engine` | Just the pure computation engine — **runs in under 10 seconds** |
| `pnpm e2e` | Playwright, against a stubbed API on port 5199 |
| `pnpm typecheck` | TypeScript across every package |
| `pnpm lint` | ESLint, including the two architecture guardrails below |
| `pnpm smoke` | Post-deploy health check; exits non-zero on failure |
| `pnpm reconcile -- --epic=KEY` | Compare stored totals against Jira. Prints only — add `--fix` to act |

---

## Layout

```
packages/
  shared/   types and zod schemas shared by front-end and back-end
  engine/   pure computation — the burndown logic itself
  db/       Prisma schema and repositories
  jira/     Jira Cloud REST v3 client, rate limiting, retries
apps/
  api/      Fastify — read API and operations endpoints
  worker/   BullMQ — nightly sync, history rebuild, weekly reconciliation
  web/      React + Vite + TanStack Query + Recharts
```

### Two guardrails enforced by the linter

`packages/engine` holds the logic that decides every number on the chart, and it is fenced off from
the rest of the system by rules in [`eslint.config.js`](./eslint.config.js):

**1. The engine cannot import `db` or `jira`.** If it could, running its tests would require a live
PostgreSQL and a Jira sandbox. The test suite would go from seconds to minutes, and then nobody
would run it. Today `pnpm test:engine` finishes in about 7 seconds.

**2. The engine cannot read the clock.** No `new Date()`, no `Date.now()`, no `DateTime.now()`.
Anything that needs "today" receives it as an `asOfDate` parameter. Signboard status depends on what
day it is, and a test that does not freeze time is green today and red next week — the most
expensive kind of failure to chase.

Both rules are also checked by [`tools/arch-tests/`](./tools/arch-tests), so they survive someone
disabling a lint rule.

---

## Tests

| Suite | Count | Notes |
|---|---|---|
| Unit | **839** (838 pass, 1 skipped) | The skip needs a live PostgreSQL |
| End-to-end | **64** | Playwright with a stubbed API — no infrastructure needed |
| Golden datasets | **20** | Hand-computed expected values, each with a `README.md` explaining *why* |
| Property-based | fast-check | Invariants that must hold for any generated scenario |

The engine is held at **≥ 90% coverage**. The rest of the codebase is not measured — it is wiring,
and averaging it in would only dilute the number that matters.

The golden datasets are worth a look if you want to understand the engine: each folder holds an
input, an expected output, and prose explaining how the number was reached by hand.
Nine of the twenty caught a real mistake during development.

---

## Documentation

All under [`docs/`](./docs), in Vietnamese:

| File | For whom |
|---|---|
| [`PRD_Burndown_Engine.md`](./docs/PRD_Burndown_Engine.md) | The full product spec — rules, edge cases, risks |
| [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Package boundaries and why they exist |
| [`ONBOARDING.md`](./docs/ONBOARDING.md) | A new developer, day one |
| [`RUNBOOK.md`](./docs/RUNBOOK.md) | Whoever is on call, possibly at 2am |
| [`UAT-CHECKLIST.md`](./docs/UAT-CHECKLIST.md) | The PM, at acceptance |
| [`tasks/`](./docs/tasks) | 34 task cards — the build log, with what went wrong in each |

The runbook has one section per alert code, and a test that fails if a documented command or button
label no longer exists. Documentation that nothing checks rots within three months.

---

## What is not finished

Stated plainly, because a green test suite can hide this:

- **The worker's job processors are not wired.** Both apps now have a real composition root
  (`main.ts`): the API listens and serves, and the worker connects Prisma + ioredis, creates the
  BullMQ queues and consumes the `sync` queue with graceful shutdown. What is still missing is the
  production adapter layer binding the job ports to `@app/db`/`@app/jira`/`@app/engine` (PRD §4.2
  phases 4–5, cards T-15/T-18). Until it lands the worker starts and reports ready, but each job
  fails loudly with a "pending adapter layer" error rather than silently succeeding.
- **Prisma adapters for reconciliation and ops health** are not implemented, for the same reason.
  The logic behind those ports is tested; the SQL is not written.
- **The p95 ≤ 800 ms target is unmeasured.** It needs PostgreSQL loaded with realistic volume.
- **`ONBOARDING.md` has never been followed on a clean machine** by someone new. File-scanning tests
  catch documentation that has gone stale; they cannot catch documentation that was never complete.
