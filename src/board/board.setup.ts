import { Inject, Injectable, Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { SENTINEL_OPTIONS, DEFAULT_BOARD_PATH } from '../sentinel.constants';
import type { SentinelAuthCallback, SentinelOptions } from '../sentinel.types';
import { ApiRouter } from '../api/api.router';
import { isBasicAuth } from './basic-auth';

/** Escapes a value for markup. `$` included, or `String.replace` expands `$&` in it. */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\$/g, '&#36;');

/** The nonce lands in markup unescaped; anything not base64-ish is refused. */
const SAFE_NONCE = /^[A-Za-z0-9+/=_-]{8,128}$/;

/** Puts the request's nonce on every script and style tag in the page. */
const withNonce = (html: string, nonce: string | undefined): string => {
  if (!nonce || !SAFE_NONCE.test(nonce)) {
    return html;
  }

  return html
    .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`)
    .replace(/<style(?=[\s>])/g, `<style nonce="${nonce}"`)
    .replace(/<link rel="stylesheet"/g, `<link nonce="${nonce}" rel="stylesheet"`);
};

/**
 * Mounts the dashboard, its API and the gate that protects both. Straight onto the
 * Express instance: Nest's middleware pipeline runs after the routes, which would let
 * requests reach the dashboard ungated.
 */
@Injectable()
export class BoardSetup {
  private readonly logger = new Logger('Sentinel');

  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    private readonly api: ApiRouter,
  ) {}

  mount(app: INestApplication): void {
    const board = this.options.board ?? {};

    if (board.enabled === false) {
      return;
    }

    const path = board.path ?? DEFAULT_BOARD_PATH;
    const gate = board.auth;

    // Resolved as `resolveOptions` resolves it. An unguarded dashboard on staging hands
    // every job payload to whoever finds the URL.
    const declared = this.options.env ?? process.env.NODE_ENV;
    const env = declared || 'development';
    const unguardedIsSafe = env === 'development' || env === 'test' || env === 'local';

    if (!gate && !unguardedIsSafe) {
      this.logger.warn(
        `Dashboard disabled: set board.auth to serve it with env="${env}".`,
      );

      return;
    }

    // An unset NODE_ENV reads as development: the one case where a missing variable
    // alone leaves the dashboard ungated.
    if (!gate && !declared) {
      this.logger.warn(
        'Dashboard is served without an auth gate because no environment is set. ' +
          'Set NODE_ENV, or board.auth, before exposing it.',
      );
    }

    if (board.domain) {
      app.use(path, this.onlyOnDomain(board.domain));
    }

    for (const middleware of board.middleware ?? []) {
      app.use(path, middleware);
    }

    app.use(path, this.guard(gate));
    app.use(`${path}/api`, this.api.build());
    this.mountUi(app, path);

    this.logger.log(`Dashboard on ${path}`);
  }

  /** Serves the compiled dashboard, falling back to index.html for client-side routes. */
  private mountUi(app: INestApplication, path: string): void {
    const ui = join(__dirname, '..', '..', 'ui');
    const indexFile = join(ui, 'index.html');

    if (!existsSync(indexFile)) {
      this.logger.warn('Dashboard assets are missing; only the API is served.');

      return;
    }

    const title = this.options.board?.title ?? this.options.name ?? 'Sentinel';
    // The public prefix may differ from the mount path when a proxy rewrites it.
    const base = this.options.board?.proxyPath || path;
    const index = readFileSync(indexFile, 'utf8')
      .replace(/__SENTINEL_BASE__/g, escapeHtml(base))
      .replace(/__SENTINEL_NAME__/g, escapeHtml(title))
      .replace(/"\/assets\//g, `"${escapeHtml(base)}/assets/`);

    const nonceFor = this.options.board?.cspNonce;

    app.use(path, express.static(ui, { index: false }));
    app.use(path, (req: Request, res: Response) => {
      // A missing asset is a 404, not the page. HTML served where a module is expected
      // fails silently and leaves the dashboard blank.
      if (req.path.startsWith('/assets/')) {
        res.status(404).end();

        return;
      }

      res.type('html').send(nonceFor ? withNonce(index, nonceFor(req)) : index);
    });
  }

  /** The dashboard answers on one host and 404s everywhere else. */
  private onlyOnDomain(domain: string) {
    return (req: Request, res: Response, next: NextFunction) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();

      return host === domain.toLowerCase() ? next() : res.status(404).end();
    };
  }

  private guard(gate?: SentinelAuthCallback) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!gate) {
        return next();
      }

      Promise.resolve(gate(req))
        .then((allowed) => {
          if (allowed) {
            return next();
          }

          // Challenge only when the gate wants credentials. A token check must not pop
          // a browser login box that cannot satisfy it.
          if (isBasicAuth(gate)) {
            res.set('WWW-Authenticate', 'Basic realm="Sentinel"').status(401);
          } else {
            res.status(403);
          }

          res.send(isBasicAuth(gate) ? 'Unauthorized.' : 'Forbidden.');
        })
        .catch(() => res.status(401).send('Unauthorized.'));
    };
  }
}
