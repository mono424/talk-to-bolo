import type { SyncedDb } from '@spooky-sync/client-solid';
import type { schema } from '../schema.gen';

/**
 * Every read the app makes lives here as a named live query (`q*`), so screens
 * that need the same shape share one synced registration. Screens register
 * them with `useQuery(() => qX(db, ...))`. No one-shot remote reads.
 */
export type Db = SyncedDb<typeof schema>;

export const qMe = (db: Db, userId: string) => db.query('user').where({ id: userId }).one().build();

export const qCourses = (db: Db, userId: string) =>
  db.query('course').where({ owner: userId }).orderBy('created_at', 'asc').build();

export const qCourse = (db: Db, courseId: string) => db.query('course').where({ id: courseId }).one().build();

export const qMaterials = (db: Db, courseId: string) =>
  db.query('material').where({ course: courseId }).orderBy('created_at', 'asc').build();

export const qMaterial = (db: Db, materialId: string) =>
  db.query('material').where({ id: materialId }).one().build();

export const qCalls = (db: Db, courseId: string) =>
  db.query('call').where({ course: courseId }).orderBy('started_at', 'desc').limit(20).build();

export const qCall = (db: Db, callId: string) => db.query('call').where({ id: callId }).one().build();

export const qTurns = (db: Db, callId: string) =>
  db.query('call_turn').where({ call: callId }).orderBy('seq', 'asc').build();

export const qApiKeys = (db: Db, userId: string) =>
  db.query('api_key').where({ owner: userId }).orderBy('created_at', 'desc').build();
