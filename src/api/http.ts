import type { FastifyRequest } from 'fastify';
import type { ApiKey, Scope } from '../db/store';

// ---------- small helpers ----------

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found.`);

export type Handler = (req: FastifyRequest, key: ApiKey | null) => Promise<{ status?: number; body?: unknown; type?: string; raw?: string | Uint8Array; headers?: Record<string, string> }>;
export interface RouteDef {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  scope: Scope | Scope[] | 'public';
  summary: string;
  body?: Record<string, unknown>; // JSON schema
  /** Query parameters: name → schema (strings, since nothing is coerced; see `Q`). Others are ignored, not refused. */
  query?: Record<string, unknown>;
  /** Path parameters that are more than any string: name → schema. */
  params?: Record<string, unknown>;
  /** For file uploads: the body is the file itself, up to this many bytes. */
  rawBodyLimit?: number;
  handler: Handler;
}

/** A real calendar day, YYYY-MM-DD (the pattern keeps the year plausible; the format refuses 2026-02-31). */
const day = { type: 'string', pattern: '^(19|20|21)\\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$', format: 'date' };
export const S = {
  str: { type: 'string', minLength: 1, maxLength: 200 },
  day,
  /** A whole number that fits every integer column (Postgres `int` stops at 2,147,483,647): bigger is refused, not a 500. */
  int: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
  bool: { type: 'boolean' },
};
/** Query and path values arrive as text and aren't coerced, so they're checked as text. One value each: a repeated
 * parameter (?limit=1&limit=2) arrives as a list and is refused. */
export const Q = {
  /** A count, page size, version or index: up to 9 digits, so it fits an `int` column. */
  count: { type: 'string', pattern: '^[0-9]{1,9}$' },
  /** A position in a `bigint` sequence (?after=): up to 15 digits, exact as a JavaScript number. */
  seq: { type: 'string', pattern: '^[0-9]{1,15}$' },
  day,
  text: { type: 'string', maxLength: 200 },
};

export const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties: props, required });


/**
 * A signed-in owner of the company: a person (a session, never a service key) whose role carries `admin`. Changing
 * who is on the team, or making keys that can do that, must be a person, so a leaked key can't make itself people.
 * The owners' second sign-in step, when the company turns it on, is checked by `authenticate` before this runs.
 */
export const signedInOwner = (key: ApiKey | null, what: string): ApiKey => {
  if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.');
  if (!key.userId || !key.scopes.includes('admin')) throw new ApiError(403, 'person_needed', `${what} is done by an owner signed in, not a service key.`);
  return key;
};
