import type { Env } from './env';
import serverSchema from './server-schema.surql';
import { BadRequest, NotFound, Surreal, UserError, recordId, toBase64 } from './surreal';

export interface CourseRow {
  id: string;
  owner: string;
  title: string;
  description?: string | null;
  language: string;
  tutor_notes?: string | null;
}

export interface MaterialRow {
  id: string;
  owner: string;
  course: string;
  title: string;
  kind: 'text' | 'markdown' | 'pdf';
  content: string;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  page_count?: number | null;
  chunk_count: number;
  image_count: number;
  index_rev: number;
  source_name?: string | null;
}

let schemaApplied = false;

/**
 * Applies server-schema.surql once per isolate (it is idempotent). A flag, not
 * a shared promise: a Worker must not await I/O that another request started.
 */
export async function ensureServerSchema(env: Env): Promise<void> {
  if (schemaApplied) return;
  await Surreal.system(env).queryAll(serverSchema);
  schemaApplied = true;
}

export async function getOwnedCourse(env: Env, userId: string, courseId: string): Promise<CourseRow> {
  const id = recordId('course', courseId);
  const row = await Surreal.system(env).query<CourseRow | null>(
    'RETURN (SELECT * FROM type::record($id) WHERE owner = type::record($owner))[0]',
    { id, owner: userId },
  );
  if (!row) throw new NotFound('Course not found.');
  return row;
}

export async function getOwnedMaterial(env: Env, userId: string, materialId: string): Promise<MaterialRow> {
  const id = recordId('material', materialId);
  // A material the browser just created may still be on its way to the
  // database (sp00ky writes locally first), so give it a moment.
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await Surreal.system(env).query<MaterialRow | null>(
      'RETURN (SELECT * FROM type::record($id) WHERE owner = type::record($owner))[0]',
      { id, owner: userId },
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new NotFound('Material not found.');
}

// ── Embeddings ────────────────────────────────────────────────────────────

type EmbeddingOutput = { data?: number[][]; shape?: number[] };

/** Embeds texts with Workers AI. `kind` picks the query or document side. */
export async function embed(env: Env, texts: string[], kind: 'documents' | 'queries'): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = env.EMBEDDING_MODEL;
  // qwen3-embedding is asymmetric (separate query/document inputs); the bge
  // family takes plain `text`.
  const input = model.includes('qwen3-embedding') ? { [kind]: texts } : { text: texts };
  const out = (await env.AI.run(model as Parameters<Ai['run']>[0], input as never)) as EmbeddingOutput;
  if (!out.data || out.data.length !== texts.length) throw new Error(`Embedding model returned no vectors (${model}).`);
  return out.data;
}

// ── Search ────────────────────────────────────────────────────────────────

export interface SearchHit {
  material: string;
  materialTitle: string;
  heading: string | null;
  text: string;
  score: number;
}

/**
 * Hybrid search over one course: vector (HNSW) and keyword (BM25) hits fused
 * with reciprocal rank fusion. Optionally limited to one material. Chunks of a
 * material deleted mid-indexing are skipped (their `material` no longer
 * resolves).
 */
export async function searchCourse(
  env: Env,
  courseId: string,
  query: string,
  opts: { k?: number; materialId?: string | null; ownerId: string },
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  await ensureServerSchema(env);
  const k = Math.min(Math.max(opts.k ?? 6, 1), 20);
  const [vec] = await embed(env, [q], 'queries');
  const filter = `course = $course AND owner = $owner AND material.owner = $owner ${opts.materialId ? 'AND material = type::record($material)' : ''}`;
  const result = await Surreal.system(env).query<{
    hits: { id: string; rrf_score: number }[];
    rows: { id: string; text: string; heading: string | null; material: string; material_title: string }[];
  }>(
    `LET $course = type::record($course_id);
     LET $owner = type::record($owner_id);
     LET $vs = SELECT id, vector::distance::knn() AS distance FROM chunk WHERE ${filter} AND embedding <|${k * 2},64|> $vec;
     LET $ft = SELECT id, search::score(1) AS score FROM chunk WHERE ${filter} AND text @1@ $q ORDER BY score DESC LIMIT ${k * 2};
     LET $hits = search::rrf([$vs, $ft], ${k}, 60);
     RETURN {
       hits: $hits.map(|$h| { id: $h.id, rrf_score: $h.rrf_score }),
       rows: SELECT id, text, heading, material, material.title AS material_title FROM $hits.id
     };`,
    { course_id: courseId, owner_id: opts.ownerId, material: opts.materialId ?? null, vec, q },
  );
  const rows = new Map((result?.rows ?? []).map((r) => [r.id, r]));
  return (result?.hits ?? []).flatMap((h) => {
    const r = rows.get(h.id);
    return r ? [{ material: r.material, materialTitle: r.material_title, heading: r.heading, text: r.text, score: h.rrf_score }] : [];
  });
}

// ── Indexing ──────────────────────────────────────────────────────────────

/**
 * Takes over a material for a new processing run: bumps `index_rev` (any run
 * still going for an older rev stops at its next step) and marks it
 * processing, in one statement.
 */
async function claimRev(env: Env, materialId: string, detail: string): Promise<number> {
  const rows = await Surreal.system(env).query<{ index_rev: number }[]>(
    `UPDATE type::record($id) SET index_rev += 1, status = 'processing', status_detail = $detail, error = NONE RETURN index_rev`,
    { id: materialId, detail },
  );
  if (!rows?.length) throw new NotFound('Material not found.');
  return rows[0].index_rev;
}

async function failRev(env: Env, materialId: string, rev: number, err: unknown) {
  const message = err instanceof UserError ? err.message : 'Processing could not start. Try again.';
  console.error(`[ingest] ${materialId} rev ${rev} could not start`, err);
  await Surreal.system(env)
    .query(
      `UPDATE type::record($id) SET status = 'failed', status_detail = NONE, error = $error WHERE index_rev = $rev`,
      { id: materialId, rev, error: message },
    )
    .catch(() => {});
}

/** Marks a material failed unless a processing run is under way. */
export async function markFailed(env: Env, materialId: string, message: string) {
  await Surreal.system(env)
    .query(`UPDATE type::record($id) SET status = 'failed', error = $error WHERE status != 'processing'`, { id: materialId, error: message })
    .catch((err) => console.error('[ingest] could not mark failed', err));
}

async function launch(env: Env, materialId: string, rev: number, convert: boolean) {
  const key = materialId.slice(materialId.indexOf(':') + 1);
  await env.INGEST.create({ id: `${key}-${rev}-${Date.now().toString(36)}`, params: { materialId, rev, convert } });
}

/**
 * (Re)builds a material's search index from its current Markdown, e.g. after
 * an edit. Never re-converts a PDF, so edits to converted text are kept.
 */
export async function startIngest(env: Env, materialId: string, detail = 'Queued'): Promise<number> {
  await ensureServerSchema(env);
  const rev = await claimRev(env, materialId, detail);
  try {
    await launch(env, materialId, rev, false);
  } catch (err) {
    await failRev(env, materialId, rev, err);
    throw err;
  }
  return rev;
}

export const MAX_PDF_BYTES = 30 * 1024 * 1024;
const PART_BYTES = 1024 * 1024;

const isPdf = (b: Uint8Array) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

/** Throws a user-facing error unless `bytes` looks like a PDF we can take. */
export function validatePdf(bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw new BadRequest('The file is empty.');
  if (bytes.byteLength > MAX_PDF_BYTES) throw new BadRequest('PDFs up to 30 MB are supported.');
  if (!isPdf(bytes)) throw new BadRequest('That file is not a PDF.');
}

/** Stores a PDF for a material (replacing any earlier one) and converts it. */
export async function storePdfAndIngest(
  env: Env,
  material: Pick<MaterialRow, 'id' | 'owner'>,
  bytes: Uint8Array,
  fileName: string | null,
): Promise<void> {
  validatePdf(bytes);
  await ensureServerSchema(env);
  // Claim first, so a run still converting the previous upload stops before
  // it can read the parts being replaced.
  const rev = await claimRev(env, material.id, 'Uploading the PDF');
  try {
    const db = Surreal.system(env);
    await db.query('DELETE source_part WHERE material = type::record($m)', { m: material.id });
    for (let idx = 0, off = 0; off < bytes.byteLength; idx++, off += PART_BYTES) {
      await db.query(
        `CREATE source_part CONTENT {
           owner: type::record($owner), material: type::record($m), idx: $idx,
           data: encoding::base64::decode($b64)
         }`,
        { owner: material.owner, m: material.id, idx, b64: toBase64(bytes.subarray(off, off + PART_BYTES)) },
      );
    }
    await db.query(
      `UPDATE type::record($m) SET kind = 'pdf', source_name = $name, source_size = $size, status_detail = 'Reading the PDF'`,
      { m: material.id, name: fileName, size: bytes.byteLength },
    );
    await launch(env, material.id, rev, true);
  } catch (err) {
    await failRev(env, material.id, rev, err);
    throw err;
  }
}

/** Reads a request or response body, refusing more than `max` bytes. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new BadRequest(`Files up to ${Math.round(max / 1024 / 1024)} MB are supported.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Downloads a PDF the user pointed an AI client at. https only, size-capped. */
export async function fetchPdf(url: string): Promise<{ bytes: Uint8Array; name: string }> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new BadRequest('Only https:// URLs are supported.');
  const res = await fetch(u, { redirect: 'follow', headers: { accept: 'application/pdf' } });
  if (new URL(res.url || u.href).protocol !== 'https:') throw new BadRequest('The URL redirected away from https.');
  if (!res.ok) throw new BadRequest(`Download failed (${res.status}).`);
  const bytes = await readLimited(res.body, MAX_PDF_BYTES);
  validatePdf(bytes);
  const name = decodeURIComponent(u.pathname.split('/').pop() || 'document.pdf');
  return { bytes, name };
}

// ── API keys ──────────────────────────────────────────────────────────────

export async function createApiKey(env: Env, userId: string, name: string): Promise<{ id: string; key: string }> {
  await ensureServerSchema(env);
  const { randomKey, sha256Hex } = await import('./auth');
  const key = `sc_${randomKey(30)}`;
  const id = `api_key:k${crypto.randomUUID().replaceAll('-', '')}`;
  await Surreal.system(env).query(
    `CREATE type::record($id) CONTENT { owner: type::record($owner), name: $name, prefix: $prefix, key_hash: $hash }`,
    { id, owner: userId, name: name.trim().slice(0, 80) || 'AI client', prefix: key.slice(0, 7), hash: await sha256Hex(key) },
  );
  return { id, key };
}
