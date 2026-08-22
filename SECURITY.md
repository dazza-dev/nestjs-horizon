# Security

## Reporting a vulnerability

Please report privately, not in a public issue: open a
[security advisory](https://github.com/dazza-dev/nestjs-sentinel/security/advisories/new) on the
repository.

Include what an attacker can do, the configuration it needs, and a way to reproduce it. You will
get an acknowledgement, and a fix released with credit unless you prefer otherwise.

## Supported versions

The latest minor release. There are no long-term support branches.

## What this package exposes

The dashboard shows job payloads, failure messages and stack traces. Treat it as privileged.

- **It fails closed.** Without `board.auth` it refuses to mount unless the environment is
  `development`, `test` or `local`. An unset `NODE_ENV` reads as development and is served with a
  warning in the log, which is the one case where a missing variable is the only thing standing
  between the dashboard and the network.
- **The gate runs first.** It is mounted straight onto Express, before the routes, so a
  misconfigured Nest middleware pipeline cannot leave the dashboard open.
- **`basicAuth()` compares in constant time** and denies everything when either credential is
  empty, so a deployment that forgot to configure it does not expose the dashboard.
- **The page carries no inline script**, so a strict `script-src 'self'` needs no exception.
  `board.cspNonce` adds a nonce per request if your policy requires one.

Job payloads are written to Redis as JSON. If they carry secrets, that is where they live.
