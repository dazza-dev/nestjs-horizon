import type { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';
import type { SentinelAuthCallback } from '../sentinel.types';

export interface BasicAuthOptions {
  username: string;
  password: string;
}

const equals = (expected: string, given: string): boolean => {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);

  return a.length === b.length && timingSafeEqual(a, b);
};

const credentials = (request: IncomingMessage): [string, string] => {
  const header = request.headers.authorization ?? '';
  const match = /^Basic\s+(.+)$/i.exec(header);

  if (!match) {
    return ['', ''];
  }

  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');

  return separator === -1
    ? ['', '']
    : [decoded.slice(0, separator), decoded.slice(separator + 1)];
};

/**
 * Marks a gate as credential-based; the guard answers those with a 401 challenge rather
 * than a 403. `Symbol.for` keeps two copies of this package in agreement. A wrapping
 * gate can carry it:
 *
 * ```ts
 * const gate = Object.assign((req) => allowed(req) && mine(req), { [BASIC_AUTH]: true });
 * ```
 */
export const BASIC_AUTH = Symbol.for('nestjs-sentinel.basicAuth');

export const isBasicAuth = (gate?: SentinelAuthCallback): boolean =>
  gate !== undefined && BASIC_AUTH in gate;

/**
 * Guards the dashboard with HTTP basic auth. An empty username or password denies every
 * request; unconfigured credentials never open the gate.
 */
export const basicAuth = (options: BasicAuthOptions): SentinelAuthCallback => {
  const gate: SentinelAuthCallback = (request) => {
    if (!options.username || !options.password) {
      return false;
    }

    const [user, password] = credentials(request);

    // Both compared before returning; which of the two failed is not timeable.
    const userOk = equals(options.username, user);
    const passwordOk = equals(options.password, password);

    return userOk && passwordOk;
  };

  return Object.assign(gate, { [BASIC_AUTH]: true });
};
