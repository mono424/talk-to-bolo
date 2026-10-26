import { appendText, applyEdits, type AnswerEdit, type AnswerText } from './homework';
import { BadRequest, NotFound, recordId, type Surreal } from './surreal';

/**
 * Documents for AI clients (mcp.ts): free writing in a course, such as a
 * research proposal, with the papers it cites (schema `document`, `paper`).
 * Runs with the student's own session, so SurrealDB's permissions apply as in
 * the app, whose editor follows the row live. The text cites a paper as
 * `[@<paper key>]` or `[@<paper key>, p. 4]`, several as `[@a; @b]`.
 *
 * Writes are compare-and-set against the text that was read, so text the
 * student typed meanwhile fails the write instead of being overwritten.
 */

interface DocumentRow {
  id: string;
  title: string;
  course: string;
  content: string;
  cite_style?: string | null;
  updated_at: string;
}

interface PaperRow {
  id: string;
  material?: string | null;
  material_course?: string | null;
  material_kind?: string | null;
  title: string;
  authors?: string | null;
  year?: string | null;
  venue?: string | null;
  url?: string | null;
}

export interface DocumentLinks {
  material: (courseId: string, materialId: string, page?: number | null) => string;
  document: (courseId: string, documentId: string) => string;
}

const key = (id: string) => id.slice(id.indexOf(':') + 1);
const CITE = /\[(@[A-Za-z0-9_]+(?:,[^\]\n;]*)?(?:;\s*@[A-Za-z0-9_]+(?:,[^\]\n;]*)?)*)\]/g;

function citeCounts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(CITE)) {
    for (const part of m[1].split(';')) {
      const k = /@([A-Za-z0-9_]+)/.exec(part)?.[1];
      if (k) out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

const present = (v: string | null | undefined) => (v?.trim() ? v.trim() : undefined);

async function loadDocument(user: Surreal, documentId: string) {
  const id = recordId('document', documentId);
  const [doc, papers] = await user.queryAll(
    `SELECT id, title, course, content, cite_style, updated_at FROM ONLY type::record($id);
     SELECT id, created_at, material, material.course AS material_course, material.kind AS material_kind, title, authors, year, venue, url
       FROM paper WHERE document = type::record($id) ORDER BY created_at;`,
    { id },
  ) as [DocumentRow | null, PaperRow[]];
  if (!doc) throw new NotFound('Document not found.');
  return { doc, papers: papers ?? [] };
}

/** A document with its text and its papers, each with the citation to write for it. */
export async function readDocument(user: Surreal, links: DocumentLinks, text: AnswerText, documentId: string) {
  const { doc, papers } = await loadDocument(user, documentId);
  const counts = citeCounts(doc.content ?? '');
  return {
    id: doc.id,
    title: doc.title,
    course: doc.course,
    url: links.document(doc.course, doc.id),
    cite_style: doc.cite_style ?? 'author-year',
    updated_at: doc.updated_at,
    content: text.external(doc.content ?? ''),
    papers: papers.map((p) => ({
      id: p.id,
      cite: `[@${key(p.id)}]`,
      title: p.title,
      authors: present(p.authors),
      year: present(p.year),
      venue: present(p.venue),
      url: present(p.url),
      ...(p.material ? { material: p.material, material_kind: p.material_kind ?? undefined } : {}),
      ...(p.material && p.material_course ? { material_url: links.material(p.material_course, p.material) } : {}),
      cited: counts.get(key(p.id)) ?? 0,
    })),
  };
}

/** The student's documents, newest first: of one course, or of all. */
export async function listDocuments(user: Surreal, courseId: string | null): Promise<unknown[]> {
  const rows = await user.query<unknown[]>(
    `SELECT id, title, course, course.title AS course_title, updated_at,
       string::len(content) AS characters,
       count((SELECT id FROM paper WHERE document = $parent.id)) AS papers
     FROM document ${courseId ? 'WHERE course = type::record($course)' : ''} ORDER BY updated_at DESC`,
    courseId ? { course: recordId('course', courseId) } : {},
  );
  return rows ?? [];
}

/** Starts a document in a course, optionally with its first text. */
export async function createDocument(user: Surreal, text: AnswerText, input: { course_id: string; title: string; content?: string }) {
  const id = `document:k${crypto.randomUUID().replaceAll('-', '')}`;
  const rows = await user.query<unknown[]>(
    `CREATE type::record($id) CONTENT { owner: $auth.id, course: type::record($course), title: $title, content: $content } RETURN VALUE id;`,
    { id, course: recordId('course', input.course_id), title: input.title.trim() || 'Untitled document', content: text.internal(input.content ?? '') },
  );
  if (!rows?.length) throw new NotFound('Course not found.');
  return id;
}

const CONFLICT = 'conflict: the student changed the document while you wrote. Read it again with get_document and retry.';

/** Saves new text, only if the document still holds `before`. */
async function save(user: Surreal, id: string, before: string, content: string) {
  if (content === before) return 'unchanged' as const;
  const rows = await user.query<unknown[]>('UPDATE type::record($id) SET content = $content WHERE content = $before RETURN VALUE id;', {
    id,
    content,
    before,
  });
  if (!rows?.length) throw new BadRequest(CONFLICT);
  return 'saved' as const;
}

/** Replaces the whole text, or appends a paragraph to it. */
export async function writeDocument(user: Surreal, text: AnswerText, documentId: string, content: string, mode: 'replace' | 'append' = 'replace') {
  const { doc } = await loadDocument(user, documentId);
  const before = doc.content ?? '';
  const incoming = text.internal(content);
  const next = mode === 'append' ? appendText(before, incoming) : incoming;
  const status = await save(user, doc.id, before, next);
  return { document: doc.id, status, characters: next.length };
}

/** Find-and-replace inside the text. */
export async function editDocument(user: Surreal, text: AnswerText, documentId: string, edits: AnswerEdit[]) {
  const { doc } = await loadDocument(user, documentId);
  const before = doc.content ?? '';
  const next = text.internal(applyEdits(text.external(before), edits));
  const status = await save(user, doc.id, before, next);
  return { document: doc.id, status, content: text.external(next) };
}

export interface PaperDetails {
  title?: string;
  authors?: string;
  year?: string;
  venue?: string;
  url?: string;
}

/** Adds a paper to a document: a course material, a reference by hand, or both. Returns its citation. */
export async function addPaper(user: Surreal, documentId: string, input: PaperDetails & { material_id?: string }) {
  const document = recordId('document', documentId);
  const material = input.material_id ? recordId('material', input.material_id) : null;
  let title = input.title?.trim();
  if (material) {
    const [m, existing] = await user.queryAll(
      `SELECT title FROM ONLY type::record($material);
       RETURN (SELECT VALUE id FROM paper WHERE document = type::record($document) AND material = type::record($material) LIMIT 1)[0];`,
      { material, document },
    ) as [{ title: string } | null, string | null];
    if (!m) throw new NotFound('Material not found.');
    if (existing) return { id: existing, cite: `[@${key(existing)}]`, created: false };
    title ||= m.title;
  }
  if (!title) throw new BadRequest('A paper needs a title, or a material_id to take it from.');
  const id = `paper:k${crypto.randomUUID().replaceAll('-', '')}`;
  // Null fields are dropped on the way, so they arrive as NONE.
  const rows = await user.query<unknown[]>(
    `CREATE type::record($id) CONTENT {
       owner: $auth.id, document: type::record($document), material: IF $material { type::record($material) } ELSE { NONE },
       title: $title, authors: $authors, year: $year, venue: $venue, url: $url
     } RETURN VALUE id;`,
    {
      id,
      document,
      material,
      title,
      authors: present(input.authors) ?? null,
      year: present(input.year) ?? null,
      venue: present(input.venue) ?? null,
      url: present(input.url) ?? null,
    },
  );
  if (!rows?.length) throw new NotFound('Document not found.');
  return { id, cite: `[@${key(id)}]`, created: true };
}

/** Changes a paper's bibliography details. An empty string clears a field. */
export async function updatePaper(user: Surreal, paperId: string, details: PaperDetails) {
  const id = recordId('paper', paperId);
  const set: Record<string, string> = {};
  for (const field of ['title', 'authors', 'year', 'venue', 'url'] as const) {
    const v = details[field];
    if (v !== undefined) set[field] = v.trim();
  }
  if (set.title === '') throw new BadRequest('A paper keeps its title.');
  if (!Object.keys(set).length) throw new BadRequest('Nothing to change.');
  const rows = await user.query<unknown[]>('UPDATE type::record($id) MERGE $set RETURN VALUE id;', { id, set });
  if (!rows?.length) throw new NotFound('Paper not found.');
  return { id, cite: `[@${key(id)}]`, updated: Object.keys(set) };
}
