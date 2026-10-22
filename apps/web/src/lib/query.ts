import type { SyncedDb } from '@spooky-sync/client-solid';
import type { schema } from '../schema.gen';

/**
 * Every read the app makes lives here as a named live query (`q*`), so screens
 * that need the same shape share one synced registration. Screens register
 * them with `useQuery(() => qX(db, ...))`. No one-shot remote reads.
 */
export type Db = SyncedDb<typeof schema>;

/**
 * The row of a by-id query, which stays a plain list rather than `.one()`:
 * sp00ky (canary.333) leaves a `.one()` (LIMIT 1) view stale when a page comes
 * back to an id it showed before, so switching courses kept the old course.
 * Wrap the `useQuery` of a by-id query: `firstRow(useQuery(() => qCourse(db, id)))`.
 */
export function firstRow<Q extends { data: () => readonly unknown[] | null | undefined }>(result: Q) {
  type Row = NonNullable<ReturnType<Q['data']>>[number];
  return { ...result, data: (): Row | undefined => result.data()?.[0] };
}

export const qMe = (db: Db, userId: string) => db.query('user').where({ id: userId }).build();

export const qCourses = (db: Db, userId: string) =>
  db.query('course').where({ owner: userId }).orderBy('created_at', 'asc').build();

export const qCourse = (db: Db, courseId: string) => db.query('course').where({ id: courseId }).build();

export const qMaterials = (db: Db, courseId: string) =>
  db.query('material').where({ course: courseId }).orderBy('created_at', 'asc').build();

/** One window of a course's material for the course page's list. The id breaks ties so windows never overlap. */
export const qMaterialsPage = (db: Db, courseId: string, page: number, size: number) =>
  db.query('material').where({ course: courseId }).orderBy('created_at', 'asc').orderBy('id', 'asc').limit(size).offset(page * size).build();

/** A course's material that is ready for calls: the call card's topics. */
export const qReadyMaterials = (db: Db, courseId: string) =>
  db.query('material').where({ course: courseId, status: 'ready' }).orderBy('created_at', 'asc').build();

export const qMaterial = (db: Db, materialId: string) => db.query('material').where({ id: materialId }).build();

/** A course's calls with their lecture: the sidebar's history on a call. */
export const qCallHistory = (db: Db, courseId: string) =>
  db.query('call').where({ course: courseId }).related('material').orderBy('started_at', 'desc').limit(30).build();

export const qCall = (db: Db, callId: string) => db.query('call').where({ id: callId }).build();

export const qTurns = (db: Db, callId: string) =>
  db.query('call_turn').where({ call: callId }).orderBy('seq', 'asc').build();

/** The lecture passages the tutor cited in a call, for the transcript's links. */
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

/** The latest calls across all courses, with their course and lecture. */
export const qRecentCalls = (db: Db, userId: string, limit = 8) =>
  db.query('call').where({ owner: userId }).related('course').related('material').orderBy('started_at', 'desc').limit(limit).build();
