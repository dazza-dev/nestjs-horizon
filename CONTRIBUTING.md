# Contributing

Thanks for taking the time. Issues and pull requests are both welcome.

## Getting set up

You need Node 22 or newer, pnpm, and a Redis you can write to.

```bash
pnpm install
pnpm build
```

`pnpm demo` boots the whole package against Redis database 13 and fills it with work worth
looking at, then serves the dashboard on <http://127.0.0.1:3333/sentinel>. It is the fastest way
to see what a change does.

## Running the tests

```bash
pnpm typecheck          # the package and the dashboard
pnpm lint
pnpm test:ui            # dashboard components, no Redis needed
pnpm test:integration   # real workers against a real Redis
```

The integration suite writes to `REDIS_TEST_DB` (15 by default) and cleans up after itself. Point
it elsewhere with `REDIS_HOST`, `REDIS_PORT` and `REDIS_TEST_DB`.

The Redis Cluster suite needs three extra nodes:

```bash
pnpm cluster:up         # three throwaway nodes on 7381-7383
pnpm test:integration
pnpm cluster:down
```

Without them that suite reports as skipped rather than passing quietly, so a run that never
exercised the cluster does not read as coverage.

## What a good pull request looks like

**Tests that fail without the fix.** The suites here are written to catch regressions, not to
report coverage. If you fix a bug, show the test failing first; if you add a feature, cover the
behaviour someone would rely on.

**Comments only where they earn their place.** A comment should say something the code cannot:
a Redis or BullMQ behaviour that surprised you, an ordering constraint, why a guard exists. One
or two lines. Delete anything that restates the line beneath it.

**English, everywhere.** Code, comments, test names, commit messages.

**No new dependencies without a reason.** The package deliberately carries very few.

## Commit messages

A short subject line in the imperative, then a body explaining what changed and why. Say what
the code did before if that is what makes the change make sense.

## Reporting a bug

Include the version, your Node and Redis versions, the relevant part of your configuration, and
what you expected instead. A failing test is worth more than a description.

For anything security-related, read [SECURITY.md](SECURITY.md) first — please do not open a
public issue.
