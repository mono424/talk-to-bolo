import { type SyncedDb, useQuery } from '@spooky-sync/client-solid';
import type { schema } from '../schema.gen';

/**
 * Every read the app makes lives here as a named live query (`q*`), so screens
 * that need the same shape share one synced registration. Screens register
 * them with `useQuery(() => qX(db, ...))`. No one-shot remote reads.
 */
export type Db = SyncedDb<typeof schema>;

/**
 * The row of a by-id query, kept a plain list rather than `.one()`. sp00ky's
 * useQuery (canary.333) writes a switched query's rows into the rows core
 * still caches for the previous one, and a `.one()` query then showed the
 * record seen before. Pages also remount per id (`perParam` in App.tsx).
 * Both can go once the sp00ky fix ships.
 * Wrap the `useQuery` of a by-id query: `firstRow(useQuery(() => qMaterial(db, id)))`.
 */
export function firstRow<Q extends { data: () => readonly unknown[] | null | undefined }>(result: Q): Omit<Q, 'data'> & { data: () => RowOf<Q> | undefined } {
  return { ...result, data: () => result.data()?.[0] as RowOf<Q> | undefined };
}
type RowOf<Q> = Q extends { data: () => infer D } ? (NonNullable<D> extends readonly (infer R)[] ? R : never) : never;

export const qMe = (db: Db, userId: string) => db.query('user').where({ id: userId }).build();

export const qCourses = (db: Db, userId: string) =>
  db.query('course').where({ owner: userId }).orderBy('created_at', 'asc').build();

/**
 * One course, picked from the user's course list (the sidebar's live query)
 * rather than a by-id query that the sidebar and the page shared: one of them
 * switching courses wrote into the other's rows (see firstRow).
 */
export function useCourse(db: Db, userId: () => string | null | undefined, courseId: () => string | null | undefined) {
  const courses = useQuery(() => (userId() ? qCourses(db, userId()!) : null));
  return {
    data: () => {
      const id = courseId();
      return id ? courses.data()?.find((c) => String(c.id) === id) : undefined;
    },
    isLoading: () => courses.isLoading(),
  };
}

export const qMaterials = (db: Db, courseId: string) =>
  db.query('material').where({ course: courseId }).orderBy('created_at', 'asc').build();

/** One window of a course's material for the course page's list. The id breaks ties so windows never overlap. */
export const qMaterialsPage = (db: Db, courseId: string, page: number, size: number) =>
  db.query('material').where({ course: courseId }).orderBy('created_at', 'asc').orderBy('id', 'asc').limit(size).offset(page * size).build();

export const qMaterial = (db: Db, materialId: string) => db.query('material').where({ id: materialId }).build();

/** A course's homework, newest first. */
export const qHomeworkList = (db: Db, courseId: string) =>
  db.query('homework').where({ course: courseId }).orderBy('updated_at', 'desc').build();

export const qHomework = (db: Db, homeworkId: string) => db.query('homework').where({ id: homeworkId }).build();

/** The homework answering one sheet, if the student started it. */
export const qSheetHomework = (db: Db, sheetId: string) => db.query('homework').where({ sheet: sheetId }).limit(1).build();

/** The parts of a homework with their answers, in sheet order. */
export const qAnswers = (db: Db, homeworkId: string) =>
  db.query('answer').where({ homework: homeworkId }).orderBy('position', 'asc').build();

/** A course's documents (free writing: a proposal, an essay), newest first. */
export const qDocumentList = (db: Db, courseId: string) =>
  db.query('document').where({ course: courseId }).orderBy('updated_at', 'desc').build();

export const qDocument = (db: Db, documentId: string) => db.query('document').where({ id: documentId }).build();

/** The papers a document draws on, in the order they were added. */
export const qPapers = (db: Db, documentId: string) =>
  db.query('paper').where({ document: documentId }).orderBy('created_at', 'asc').orderBy('id', 'asc').build();

/** A course's sources (bCourses courses, web pages that import material by themselves). */
export const qFetchers = (db: Db, courseId: string) =>
  db.query('fetcher').where({ course: courseId }).orderBy('created_at', 'asc').build();

/** A source's latest checks, newest first. */
export const qFetchRuns = (db: Db, fetcherId: string) =>
  db.query('fetch_run').where({ fetcher: fetcherId }).orderBy('started_at', 'desc').limit(10).build();

/** A material's latest jobs on one outbox path (jobs.ts), newest first. */
export const qMaterialJobs = (db: Db, materialId: string, path: string) =>
  db.query('job').where({ assigned_to: materialId, path }).orderBy('created_at', 'desc').limit(5).build();

/** One study session (a `call` row): saved by ChatGPT, or an earlier voice call. */
export const qCall = (db: Db, callId: string) => db.query('call').where({ id: callId }).build();

export const qTurns = (db: Db, callId: string) =>
  db.query('call_turn').where({ call: callId }).orderBy('seq', 'asc').build();

/** The lecture passages the tutor cited in an earlier voice call, for the transcript's links. */
export const qTurnSources = (db: Db, callId: string) =>
  db.query('turn_source').where({ call: callId }).orderBy('seq', 'asc').orderBy('at', 'asc').build();

export const qApiKeys = (db: Db, userId: string) =>
  db.query('api_key').where({ owner: userId }).orderBy('created_at', 'desc').build();

/** Material that is not ready yet, across all courses: the sidebar's "Needs attention". */
export const qAttention = (db: Db, userId: string) =>
  db
    .query('material')
    .where({ owner: userId, status: { _op: '!=', _val: 'ready' } })
    .orderBy('updated_at', 'desc')
    .limit(10)
    .build();

/** The latest study sessions across all courses, with their course and lecture. */
export const qRecentCalls = (db: Db, userId: string, limit = 8) =>
  db.query('call').where({ owner: userId }).related('course').related('material').orderBy('started_at', 'desc').limit(limit).build();
