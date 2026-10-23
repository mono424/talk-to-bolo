import type { Db } from './query';

/**
 * The API's public routes (apps/api, `expose` in sp00ky.yml): PDF upload and
 * download, search, assets. Every request carries the user's SurrealDB token;
 * the API checks it against the database before doing anything. Background
 * work goes through the job outbox instead (jobs.ts).
 */
// Production serves API, MCP and extracted images under the app's own origin.
// An explicit override supports deployments with a separate API Worker.
export const API_URL = (import.meta.env.VITE_API_URL?.trim() || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/+$/, '');
export const MCP_URL = `${API_URL}/mcp`;

export const assetUrl = (id: string) => `${API_URL}/material-assets/${encodeURIComponent(id)}`;

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
    if (res.status === 405) throw new ApiError('The app could not reach its API service. Please reload and try again.', res.status);
    const msg = body && typeof body === 'object' && 'error' in body ? String(body.error) : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  if (res.headers.get('content-type')?.includes('text/html')) {
    throw new ApiError('The app could not reach its API service. Please reload and try again.', 503);
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

/** Uploads a PDF for a material that already exists; processing starts at once. */
export const uploadPdf = (db: Db, materialId: string, file: File) =>
  api<{ ok: true }>(db, `/api/materials/${encodeURIComponent(materialId)}/pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  });

// The last few PDFs opened, so going back to a lecture does not download it again.
const pdfCache = new Map<string, Promise<ArrayBuffer>>();
const PDF_STALL_MS = 30_000;

/**
 * The original PDF of a material, for the viewer. A material's PDF never
 * changes, so it is cached by id and size. pdf.js takes ownership of the
 * buffer it is given: pass it a copy.
 */
export function fetchPdf(db: Db, materialId: string, size: number | null | undefined): Promise<ArrayBuffer> {
  const key = `${materialId}:${size ?? ''}`;
  const hit = pdfCache.get(key);
  if (hit) {
    pdfCache.delete(key);
    pdfCache.set(key, hit);
    return hit;
  }
  const load = (async () => {
    const token = db.auth.token;
    if (!token) throw new ApiError('You are signed out. Sign in again to continue.', 401);
    // A request that stops making progress is given up, or the viewer (and
    // this cache) would wait on it forever. Each chunk restarts the clock, so
    // a large PDF on a slow connection still loads.
    const abort = new AbortController();
    let timer = setTimeout(() => abort.abort(), PDF_STALL_MS);
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), PDF_STALL_MS);
    };
    try {
      const res = await fetch(`${API_URL}/api/materials/${encodeURIComponent(materialId)}/pdf`, {
        headers: { authorization: `Bearer ${token}` },
        signal: abort.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new ApiError(body?.error ?? `The PDF could not be loaded (${res.status}).`, res.status);
      }
      if (!res.body) return await res.arrayBuffer();
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        progress();
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
      const out = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out.buffer;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        abort.signal.aborted ? 'The PDF is taking too long to load. Try again.' : 'The PDF could not be loaded. Check your connection and try again.',
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  })();
  pdfCache.set(key, load);
  load.catch(() => pdfCache.delete(key));
  while (pdfCache.size > 3) pdfCache.delete(pdfCache.keys().next().value!);
  return load;
}

export interface SearchHit {
  material: string;
  materialTitle: string;
  materialKind: 'text' | 'markdown' | 'pdf';
  position: number;
  rev: number;
  heading: string | null;
  text: string;
  /** PDF pages the passage comes from; null for typed and Markdown material. */
  page: number | null;
  pageEnd: number | null;
  score: number;
}

/** The app path of a material, opening a PDF at `page`. */
export const materialPath = (courseId: string, materialId: string, page?: number | null) =>
  `/courses/${courseId.slice(courseId.indexOf(':') + 1)}/materials/${materialId.slice(materialId.indexOf(':') + 1)}${page ? `?page=${page}` : ''}`;

/** "p. 12" or "pp. 12-13" for a cited passage, or null without pages. */
export const pageLabel = (page?: number | null, pageEnd?: number | null) =>
  page ? (pageEnd && pageEnd !== page ? `pp. ${page}-${pageEnd}` : `p. ${page}`) : null;

export const searchCourse = (db: Db, courseId: string, query: string) =>
  api<{ hits: SearchHit[] }>(db, `/api/courses/${encodeURIComponent(courseId)}/search`, {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
