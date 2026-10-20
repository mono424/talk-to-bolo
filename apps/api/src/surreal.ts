import type { Env } from './env';

/**
 * Minimal SurrealDB client over HTTP JSON-RPC (`POST /rpc`). Two identities:
 *
 * - `system`: the database user from SURREAL_USER / SURREAL_PASS, for the
 *   server-only work (writing chunks, assets, calls, transcripts). Every query
 *   run this way filters by owner explicitly.
 * - `as(token)`: a user's own session token, so SurrealDB applies that user's
 *   table permissions.
 *
 * Values cross as JSON: record ids are `table:key` strings (turn them into
 * records with `type::record($id)` in the query) and bytes go in and out as
 * base64 (`encoding::base64::decode/encode`).
 */
export class Surreal {
  constructor(
    private readonly env: Env,
    private readonly authorization: string,
  ) {}

  static system(env: Env) {
    return new Surreal(env, `Basic ${btoa(`${env.SURREAL_USER}:${env.SURREAL_PASS}`)}`);
  }

  static as(env: Env, token: string) {
    return new Surreal(env, `Bearer ${token}`);
  }

  /** Runs one or more statements and returns every statement's result. */
  async queryAll(sql: string, vars: Record<string, unknown> = {}): Promise<unknown[]> {
    const res = await fetch(`${baseUrl(this.env)}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'surreal-ns': this.env.SURREAL_NS,
        'surreal-db': this.env.SURREAL_DB,
        authorization: this.authorization,
      },
      // JSON null reaches SurrealDB as NULL, which an option<T> field rejects;
      // a missing key is NONE. So nulls are dropped, at any depth.
      body: JSON.stringify({ id: 1, method: 'query', params: [sql, vars] }, (_k, v) => (v === null ? undefined : v)),
    });
    if (res.status === 401 || res.status === 403) throw new SurrealAuthError(await res.text());
    const text = await res.text();
    let body: { result?: { status: string; result: unknown }[]; error?: { message?: string } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`SurrealDB answered ${res.status}: ${text.slice(0, 300)}`);
    }
    if (body.error) {
      const msg = body.error.message ?? JSON.stringify(body.error);
      if (/authentication|token|expired/i.test(msg)) throw new SurrealAuthError(msg);
      throw new Error(`SurrealDB: ${msg}`);
    }
    const results = body.result ?? [];
    const failed = results.find((r) => r.status !== 'OK');
    if (failed) throw new Error(`SurrealDB: ${String(failed.result)}`);
    return results.map((r) => r.result);
  }

  /** Runs the statements and returns the result of the last one. */
  async query<T = unknown>(sql: string, vars: Record<string, unknown> = {}): Promise<T> {
    const all = await this.queryAll(sql, vars);
    return all[all.length - 1] as T;
  }
}

export class SurrealAuthError extends Error {}

const baseUrl = (env: Env) => env.SURREAL_URL.replace(/\/+$/, '').replace(/^ws(s?):\/\//, 'http$1://').replace(/\/rpc$/, '');

/**
 * Signs in through a record access method and returns the session token, e.g.
 * the `agent` access with an API key.
 */
export async function signinRecord(env: Env, access: string, params: Record<string, string>): Promise<string | null> {
  const res = await fetch(`${baseUrl(env)}/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ns: env.SURREAL_NS, db: env.SURREAL_DB, ac: access, ...params }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: string };
  return body.token ?? null;
}

/** Record ids pass through JSON as strings; this rejects anything else. */
export function recordId(table: string, raw: unknown): string {
  const s = String(raw ?? '');
  const id = s.includes(':') ? s : `${table}:${s}`;
  if (!id.startsWith(`${table}:`) || !/^[a-z_]+:[A-Za-z0-9_]+$/.test(id)) {
    throw new BadRequest(`Not a ${table} id: ${s}`);
  }
  return id;
}

/** An error whose message is safe to show to the caller. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 503 = 400,
  ) {
    super(message);
  }
}
export class BadRequest extends UserError {}
export class NotFound extends UserError {
  constructor(message: string) {
    super(message, 404);
  }
}

export const toBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export const fromBase64 = (b64: string): Uint8Array => {
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
