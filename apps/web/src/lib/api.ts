import type { Db } from './query';

/**
 * The API Worker (apps/api): voice calls, PDF processing, search, assets.
 * Every call carries the user's SurrealDB token; the Worker checks it against
 * the database before doing anything.
 */
export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/\/+$/, '');

export const assetUrl = (id: string) => `${API_URL}/assets/${encodeURIComponent(id)}`;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(db: Db, path: string, init: RequestInit = {}): Promise<T> {
  const token = db.auth.token;
  if (!token) throw new ApiError('You are signed out. Sign in again to continue.', 401);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const msg = body && typeof body === 'object' && 'error' in body ? String(body.error) : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type CallMode = 'explain' | 'quiz' | 'qa';

export interface StartedCall {
  callId: string;
  conversationToken: string;
  callKey: string;
  firstMessage: string;
  language: string;
  studentName: string;
}

export const startCall = (db: Db, input: { courseId: string; materialId?: string | null; mode: CallMode }) =>
  api<StartedCall>(db, '/api/calls', { method: 'POST', body: JSON.stringify(input) });

export const endCall = (db: Db, callId: string, conversationId?: string | null) =>
  api<{ ok: true; recap: string | null }>(db, `/api/calls/${encodeURIComponent(callId)}/end`, {
    method: 'POST',
    body: JSON.stringify({ conversationId: conversationId ?? null }),
  });

/** Uploads a PDF for a material that already exists; processing starts at once. */
export const uploadPdf = (db: Db, materialId: string, file: File) =>
  api<{ ok: true }>(db, `/api/materials/${encodeURIComponent(materialId)}/pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  });

/** (Re)builds the search index of a text or markdown material after an edit. */
export const reindexMaterial = (db: Db, materialId: string) =>
  api<{ ok: true }>(db, `/api/materials/${encodeURIComponent(materialId)}/index`, { method: 'POST' });

export interface SearchHit {
  material: string;
  materialTitle: string;
  heading: string | null;
  text: string;
  score: number;
}

export const createApiKey = (db: Db, name: string) =>
  api<{ id: string; key: string }>(db, '/api/keys', { method: 'POST', body: JSON.stringify({ name }) });

export const searchCourse = (db: Db, courseId: string, query: string) =>
  api<{ hits: SearchHit[] }>(db, `/api/courses/${encodeURIComponent(courseId)}/search`, {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
