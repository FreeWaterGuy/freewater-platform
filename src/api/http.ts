import type { FastifyRequest } from 'fastify';
import type { ApiKey, Scope } from '../db/store';

// ---------- small helpers ----------

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found.`);

export type Handler = (req: FastifyRequest, key: ApiKey | null) => Promise<{ status?: number; body?: unknown; type?: string; raw?: string }>;
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

