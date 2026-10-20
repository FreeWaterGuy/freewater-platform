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
  /** For file uploads: the body is the file itself, up to this many bytes. */
  rawBodyLimit?: number;
  handler: Handler;
}

export const S = {
  str: { type: 'string', minLength: 1, maxLength: 200 },
  int: { type: 'integer', minimum: 0 },
  bool: { type: 'boolean' },
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
