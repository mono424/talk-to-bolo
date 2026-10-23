import type { Chunk } from './chunk';
import type { Env } from './env';
import type { MaterialRow } from './service';

/** The Agent Memory data plane is separate from the application's SurrealDB SQL endpoint. */
export type MemoryMaterial = Pick<MaterialRow, 'id' | 'owner' | 'course' | 'title' | 'index_rev'>;

export interface MemoryFactHit {
  id: string;
  text: string;
  source: 'attribute' | 'action';
  score: number;
  occurredAt: string;
}

export interface MemoryDocument {
  status: string;
  error?: string | null;
}

const NARRATIVE_START = Date.UTC(2000, 0, 1);
const REQUEST_TIMEOUT_MS = 30_000;

export function memoryConfigured(env: Env): boolean {
  return !!env.AGENT_MEMORY_URL?.trim() && !!env.AGENT_MEMORY_API_KEY?.trim();
}

// Hex makes record identifiers into collision-free scope segments, including ids
// containing slashes, colons or Unicode. Do not shorten or normalise these ids.
function segment(id: string): string {
  if (!id) throw new Error('Agent Memory scope requires a record identifier.');
  return Array.from(new TextEncoder().encode(id), (b) => b.toString(16).padStart(2, '0')).join('');
}

function materialScope(owner: string, course: string, material: string, rev: number): string {
  if (!Number.isSafeInteger(rev) || rev < 0) throw new Error('Invalid Agent Memory material revision.');
  return `talktobolo/owners/${segment(owner)}/courses/${segment(course)}/materials/${segment(material)}/revisions/${rev}`;
}

export function courseMemoryScope(owner: string, course: string, material: string, rev: number): string {
  return `${materialScope(owner, course, material, rev)}/course`;
}

function studentMemoryScope(material: MemoryMaterial, position: number): string {
  if (!Number.isSafeInteger(position) || position < 0) throw new Error('Invalid student evidence section.');
  return `${materialScope(material.owner, material.course, material.id, material.index_rev)}/student/section/p${position}`;
}

/** Section order is a synthetic known-time axis, independent of upload time. */
export function lectureStamp(position: number): string {
  if (!Number.isSafeInteger(position) || position < -1) throw new Error('Invalid lecture section position.');
  const time = NARRATIVE_START + (position + 1) * 1000;
  if (!Number.isSafeInteger(time) || !Number.isFinite(new Date(time).getTime())) throw new Error('Invalid lecture section time.');
  return new Date(time).toISOString();
}

function endpoint(env: Env, path: string): string {
  const base = new URL(env.AGENT_MEMORY_URL!.trim());
  if (!/^\/api\/v1\/[^/]+\/?$/.test(base.pathname) || base.search || base.hash || base.username || base.password) {
    throw new Error('AGENT_MEMORY_URL must be the Context API base URL ending in /api/v1/{context_id}.');
  }
  return `${base.href.replace(/\/$/, '')}${path}`;
}

async function request(env: Env, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${env.AGENT_MEMORY_API_KEY!.trim()}`);
  const res = await fetch(endpoint(env, path), {
    ...init,
    headers,
    // Workers reject redirect: 'error'. A redirect is not ok, so it fails below.
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Keep credentials and transcript contents out of application error messages.
    throw new Error(`Agent Memory ${init.method ?? 'GET'} ${path} failed (${res.status}).`);
  }
  return res.json();
}

function post(env: Env, path: string, body: unknown): Promise<unknown> {
  return request(env, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Registration auto-creates ancestors; registering the same named path is safe to repeat. */
async function registerScope(env: Env, scope: string): Promise<void> {
  const result = await post(env, '/scopes', { path: scope });
  if (!isObject(result) || typeof result.path !== 'string' || result.path.replace(/\/$/, '') !== scope || result.tombstonedAt) {
    throw new Error('Agent Memory did not register the requested scope.');
  }
}

/** Queue one lecture section for real document extraction into Agent Memory's graph. */
export async function indexMemorySection(
  env: Env,
  material: MemoryMaterial,
  position: number,
  chunk: Chunk,
): Promise<string | null> {
  if (!memoryConfigured(env)) return null;
  if (position < 0) throw new Error('A lecture section must have a non-negative position.');
  const scope = courseMemoryScope(material.owner, material.course, material.id, material.index_rev);
  const observedAt = lectureStamp(position);
  await registerScope(env, scope);

  // Content-addressed uploads deduplicate on bytes, not metadata. Include stable
  // owner/material/revision/position provenance in the bytes so equal excerpts
  // at different course positions cannot inherit another excerpt's known time.
  const text = [
    `<!-- TalkToBolo ${JSON.stringify({ owner: material.owner, course: material.course, material: material.id, revision: material.index_rev, position })} -->`,
    `# ${material.title}`,
    chunk.heading ? `## ${chunk.heading}` : '',
    chunk.text,
  ].filter(Boolean).join('\n\n');
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/markdown' }), `section-${position}.md`);
  form.append('metadata', JSON.stringify({
    title: `${material.title}: section ${position + 1}`,
    source: `${material.id}@${material.index_rev}#${position}`,
    mimeType: 'text/markdown',
    scopes: [[scope]],
    labels: [`section=${position}`],
    observedAt,
  }));
  const result = await request(env, '/documents', { method: 'POST', body: form });
  if (!isObject(result) || typeof result.id !== 'string' || !result.id ||
    (result.observedAt != null && result.observedAt !== observedAt)) {
    throw new Error('Agent Memory upload returned no document or a different lecture timestamp.');
  }
  return result.id;
}

/** The ingestion Workflow polls this outside its upload step until ready or failed. */
export async function getMemoryDocument(env: Env, id: string): Promise<MemoryDocument | null> {
  if (!memoryConfigured(env)) return null;
  if (!id) throw new Error('Agent Memory document id is required.');
  const result = await request(env, `/documents/${encodeURIComponent(id)}`);
  if (!isObject(result) || typeof result.status !== 'string') throw new Error('Invalid Agent Memory document response.');
  return { status: result.status, ...(typeof result.error === 'string' ? { error: result.error } : {}) };
}

/**
 * asOf gates graph facts, but raw passages retain their upload-time metadata.
 * Never use /context or include passages for this temporal course boundary.
 * https://surrealdb.com/docs/agent-memory/cookbooks/patterns/spoiler-safe-narrative-memory
 */
export async function queryCourseMemory(
  env: Env,
  material: MemoryMaterial,
  throughPosition: number,
  query: string,
): Promise<MemoryFactHit[]> {
  if (!memoryConfigured(env) || throughPosition < 0 || !query.trim()) return [];
  const scope = courseMemoryScope(material.owner, material.course, material.id, material.index_rev);
  return queryFacts(env, [[scope]], query, lectureStamp(throughPosition), lectureStamp(0));
}

/** Student evidence uses real observation time, independently of the course timeline. */
export async function recallStudentMemory(
  env: Env,
  material: MemoryMaterial,
  query: string,
  asOf = new Date().toISOString(),
  throughPosition = -1,
): Promise<MemoryFactHit[]> {
  if (!memoryConfigured(env) || !query.trim() || throughPosition < 0) return [];
  lectureStamp(throughPosition); // Validate before allocating a bounded section lens.
  const lens = Array.from({ length: throughPosition + 1 }, (_, position) => [studentMemoryScope(material, position)]);
  return queryFacts(env, lens, query, asOf);
}

async function queryFacts(env: Env, lens: string[][], query: string, asOf: string, since?: string): Promise<MemoryFactHit[]> {
  const cutoff = Date.parse(asOf);
  const lower = since ? Date.parse(since) : -Infinity;
  if (!Number.isFinite(cutoff)) throw new Error('Invalid Agent Memory recall time.');
  const result = await post(env, '/query', {
    query: query.trim(),
    k: 10,
    lens,
    scopeView: 'strict',
    asOf,
    include: ['facts'],
    mode: 'graph',
    source: 'talktobolo',
  });
  if (!isObject(result) || !Array.isArray(result.hits)) throw new Error('Invalid Agent Memory query response.');

  // Do not feed expanded context, entity fact cards, turns, or unbounded source
  // text to the tutor. Each returned assertion needs its own known-time stamp.
  return result.hits.flatMap((hit): MemoryFactHit[] => {
    if (!isObject(hit) || (hit.source !== 'attribute' && hit.source !== 'action') ||
      typeof hit.id !== 'string' || typeof hit.text !== 'string' || !hit.text.trim() ||
      typeof hit.score !== 'number' || !Number.isFinite(hit.score) || typeof hit.occurredAt !== 'string') return [];
    const occurred = Date.parse(hit.occurredAt);
    if (!Number.isFinite(occurred) || occurred > cutoff || occurred < lower) return [];
    return [{ id: hit.id, text: hit.text, source: hit.source, score: hit.score, occurredAt: hit.occurredAt }];
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
