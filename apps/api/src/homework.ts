import { parseSheet } from '../../../shared/homework';
import { lectureMarkdown } from '../../../shared/lecture';
import { BadRequest, NotFound, recordId, type Surreal } from './surreal';

/**
 * Homework for AI clients (mcp.ts): start answering a sheet, read its parts
 * with the student's answers, and write answers part by part. Runs with the
 * student's own session, so SurrealDB's permissions apply as in the app; the
 * app's editor follows the rows live, so a write shows up as it lands.
 *
 * Parts are addressed by their key on the sheet ("1.b.ii"), or by answer id.
 * Writes are compare-and-set against the text that was read, so a part the
 * student changed meanwhile fails instead of being overwritten.
 */

interface PartRow {
  id: string;
  key: string;
  question: string;
  question_title?: string | null;
  label: string;
  points?: number | null;
  page?: number | null;
  prompt: string;
  context?: string | null;
  content: string;
  updated_at: string;
}

export interface HomeworkView {
  id: string;
  title: string;
  course: string;
  sheet: string | null;
  sheet_kind: string | null;
  sheet_url: string | null;
  total_parts: number;
  answered: number;
  parts: Record<string, unknown>[];
}

/** How AI clients see and write answer text: images as absolute URLs. */
export interface AnswerText {
  external: (md: string) => string;
  internal: (md: string) => string;
}

export interface HomeworkLinks {
  material: (courseId: string, materialId: string, page?: number | null) => string;
}

const answered = (content: string) => content.trim().length > 0;

/** The parts the caller asked for, in sheet order; unknown names fail with the valid keys. */
function pick(rows: PartRow[], refs: string[] | null): PartRow[] {
  if (!refs?.length) return rows;
  const wanted = new Set<PartRow>();
  for (const ref of refs) {
    const row = findPart(rows, ref);
    wanted.add(row);
  }
  return rows.filter((r) => wanted.has(r));
}

function findPart(rows: PartRow[], ref: string): PartRow {
  const r = ref.trim();
  const row = rows.find((p) => p.key === r || p.id === r || p.id === `answer:${r}`);
  if (!row) throw new BadRequest(`No part "${ref}" in this homework. Parts: ${rows.map((p) => p.key).join(', ')}.`);
  return row;
}

async function loadHomework(user: Surreal, homeworkId: string) {
  const id = recordId('homework', homeworkId);
  const [hw, rows] = await user.queryAll(
    `SELECT id, title, course, sheet, sheet.kind AS sheet_kind FROM ONLY type::record($id);
     SELECT id, position, key, question, question_title, label, points, page, prompt, context, content, updated_at
       FROM answer WHERE homework = type::record($id) ORDER BY position;`,
    { id },
  ) as [{ id: string; title: string; course: string; sheet?: string | null; sheet_kind?: string | null } | null, PartRow[]];
  if (!hw) throw new NotFound('Homework not found.');
  return { hw, rows: rows ?? [] };
}

/**
 * A homework with its parts. `parts` narrows it to some; `context` (the
 * introduction a part builds on) is left out when it is the same as the
 * previous part's, since sub-parts of a question share it.
 */
export async function readHomework(
  user: Surreal,
  links: HomeworkLinks,
  text: AnswerText,
  homeworkId: string,
  opts: { parts?: string[] | null; answers_only?: boolean } = {},
): Promise<HomeworkView> {
  const { hw, rows } = await loadHomework(user, homeworkId);
  const sheet = hw.sheet ?? null;
  let lastContext: string | null = null;
  const parts = pick(rows, opts.parts ?? null).map((p) => {
    const context = p.context ?? null;
    const sameContext = context === lastContext;
    lastContext = context;
    const base = {
      id: p.id,
      key: p.key,
      label: p.label,
      answer: text.external(p.content ?? ''),
      updated_at: p.updated_at,
    };
    if (opts.answers_only) return base;
    return {
      ...base,
      question: p.question,
      ...(p.question_title ? { question_title: p.question_title } : {}),
      ...(p.points != null ? { points: p.points } : {}),
      ...(p.page != null ? { page: p.page } : {}),
      ...(sheet && p.page != null && hw.sheet_kind === 'pdf' ? { page_url: links.material(hw.course, sheet, p.page) } : {}),
      prompt: text.external(p.prompt),
      ...(context && !sameContext ? { context: text.external(context) } : {}),
    };
  });
  return {
    id: hw.id,
    title: hw.title,
    course: hw.course,
    sheet,
    sheet_kind: hw.sheet_kind ?? null,
    sheet_url: sheet ? links.material(hw.course, sheet) : null,
    total_parts: rows.length,
    answered: rows.filter((p) => answered(p.content ?? '')).length,
    parts,
  };
}

/** The student's homework, newest first: of one course, or of all. */
export async function listHomework(user: Surreal, courseId: string | null): Promise<unknown[]> {
  const rows = await user.query<unknown[]>(
    `SELECT id, title, course, course.title AS course_title, sheet, updated_at,
       count((SELECT id FROM answer WHERE homework = $parent.id)) AS parts,
       count((SELECT id FROM answer WHERE homework = $parent.id AND string::len(string::trim(content)) > 0)) AS answered
     FROM homework ${courseId ? 'WHERE course = type::record($course)' : ''} ORDER BY updated_at DESC`,
    courseId ? { course: recordId('course', courseId) } : {},
  );
  return rows ?? [];
}

/**
 * Starts answering an exercise sheet the way the app does: one homework, an
 * empty answer per part of the sheet. A sheet answered already hands back its
 * homework instead, so this is safe to call again.
 */
export async function startHomework(user: Surreal, sheetId: string): Promise<{ id: string; created: boolean }> {
  const sheet = recordId('material', sheetId);
  const [m, existing] = await user.queryAll(
    `SELECT id, course, title, kind, status, content FROM ONLY type::record($sheet);
     RETURN (SELECT VALUE id FROM homework WHERE sheet = type::record($sheet) LIMIT 1)[0];`,
    { sheet },
  ) as [{ id: string; course: string; title: string; kind: string; status: string; content: string } | null, string | null];
  if (!m) throw new NotFound('Material not found.');
  if (existing) return { id: existing, created: false };
  if (!m.content?.trim()) {
    throw new BadRequest(m.status === 'ready' ? 'The sheet has no text to split into parts.' : 'The sheet is still being processed; list_materials shows when it is ready.');
  }
  const parts = parseSheet(lectureMarkdown(m.kind, m.content));
  const id = `homework:k${crypto.randomUUID().replaceAll('-', '')}`;
  await user.query(
    `BEGIN;
     CREATE type::record($id) CONTENT { owner: $auth.id, course: type::record($course), sheet: type::record($sheet), title: $title };
     FOR $p IN $parts {
       CREATE type::record($p.id) CONTENT {
         owner: $auth.id, homework: type::record($id), position: $p.position, key: $p.key, question: $p.question,
         question_title: $p.question_title, label: $p.label, points: $p.points, prompt: $p.prompt, context: $p.context,
         page: $p.page, anchor: $p.anchor, anchor_page: $p.anchor_page, content: ''
       };
     };
     COMMIT;`,
    {
      id,
      course: m.course,
      sheet,
      title: m.title,
      // Null fields are dropped on the way, so they arrive as NONE.
      parts: parts.map((p, position) => ({
        id: `answer:k${crypto.randomUUID().replaceAll('-', '')}`,
        position,
        key: p.key,
        question: p.question,
        question_title: p.questionTitle,
        label: p.label,
        points: p.points,
        prompt: p.prompt,
        context: p.context,
        page: p.page || null,
        anchor: p.anchor || null,
        anchor_page: p.anchorPage || null,
      })),
    },
  );
  return { id, created: true };
}

export interface AnswerWrite {
  part: string;
  content: string;
  mode?: 'replace' | 'append';
}

export interface AnswerEdit {
  old_text: string;
  new_text: string;
}

/** Applies find-and-replace edits in order; each old_text must occur exactly once. */
export function applyEdits(content: string, edits: AnswerEdit[]): string {
  let next = content;
  for (const [i, e] of edits.entries()) {
    const at = next.indexOf(e.old_text);
    const which = edits.length > 1 ? `Edit ${i + 1}: ` : '';
    if (at < 0) throw new BadRequest(`${which}old_text was not found in the answer.`);
    if (next.indexOf(e.old_text, at + 1) >= 0) throw new BadRequest(`${which}old_text occurs more than once; include more context.`);
    next = next.slice(0, at) + e.new_text + next.slice(at + e.old_text.length);
  }
  return next;
}

/** Joins appended text to an answer as a new paragraph. */
export function appendText(content: string, more: string): string {
  if (!content.trim()) return more;
  return `${content.replace(/\s+$/, '')}\n\n${more.replace(/^\s+/, '')}`;
}

export interface WriteResult {
  key: string;
  label: string;
  status: 'saved' | 'unchanged' | 'conflict';
  characters: number;
}

/** Saves new texts for parts, each only if it is still the text that was read. */
async function save(user: Surreal, changes: { row: PartRow; content: string }[]): Promise<WriteResult[]> {
  const todo = changes.filter((c) => c.content !== (c.row.content ?? ''));
  const vars: Record<string, string> = {};
  const sql = todo.map((c, i) => {
    vars[`id${i}`] = c.row.id;
    vars[`c${i}`] = c.content;
    vars[`b${i}`] = c.row.content ?? '';
    return `UPDATE type::record($id${i}) SET content = $c${i} WHERE content = $b${i} RETURN VALUE id;`;
  });
  const results = sql.length ? await user.queryAll(sql.join('\n'), vars) : [];
  return changes.map((c) => {
    const i = todo.indexOf(c);
    const status = i < 0 ? 'unchanged' : (results[i] as unknown[] | undefined)?.length ? 'saved' : 'conflict';
    return { key: c.row.key, label: c.row.label, status, characters: (status === 'conflict' ? c.row.content ?? '' : c.content).length };
  });
}

const CONFLICT_NOTE = 'conflict: the student changed this part while you wrote. Read it again with get_homework and retry.';

/** Writes whole answers, or appends to them, for any number of parts at once. */
export async function writeAnswers(user: Surreal, text: AnswerText, homeworkId: string, writes: AnswerWrite[]) {
  const { rows } = await loadHomework(user, homeworkId);
  const seen = new Set<string>();
  const changes = writes.map((w) => {
    const row = findPart(rows, w.part);
    if (seen.has(row.id)) throw new BadRequest(`Part ${row.key} is written twice; send one entry per part.`);
    seen.add(row.id);
    const content = text.internal(w.content);
    return { row, content: w.mode === 'append' ? appendText(row.content ?? '', content) : content };
  });
  const results = await save(user, changes);
  return { homework: recordId('homework', homeworkId), results, ...(results.some((r) => r.status === 'conflict') ? { note: CONFLICT_NOTE } : {}) };
}

/** Find-and-replace inside one part's answer. */
export async function editAnswer(user: Surreal, text: AnswerText, homeworkId: string, part: string, edits: AnswerEdit[]) {
  const { rows } = await loadHomework(user, homeworkId);
  const row = findPart(rows, part);
  const current = text.external(row.content ?? '');
  const next = text.internal(applyEdits(current, edits));
  const [result] = await save(user, [{ row, content: next }]);
  if (result.status === 'conflict') throw new BadRequest(CONFLICT_NOTE);
  return { homework: recordId('homework', homeworkId), ...result, answer: text.external(next) };
}
