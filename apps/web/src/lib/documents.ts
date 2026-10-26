import { ApiError, uploadPdf } from './api';
import { newId, whenSynced } from './ids';
import type { Db } from './query';

/**
 * Documents: free writing in a course (a research proposal, an essay), with
 * the papers it draws on (schema `document`, `paper`). Written here, in the
 * browser, like any other write.
 */

export async function createDocument(db: Db, input: { owner: string; course: string; title?: string }): Promise<string> {
  const id = newId('document');
  await db.create(id, { owner: input.owner, course: input.course, title: input.title?.trim() || 'Untitled document', content: '' });
  return id;
}

/**
 * Adds a PDF to a course as material: the row at once, the file once the
 * row has synced, then the API processes it. `uploaded` rejects when the
 * request itself fails; a file the API refuses (400) is marked failed on
 * its row instead.
 */
export async function addPdfMaterial(db: Db, input: { owner: string; course: string; file: File }) {
  const title = input.file.name.replace(/\.pdf$/i, '') || 'Paper';
  const id = newId('material');
  await db.create(id, { owner: input.owner, course: input.course, title, kind: 'pdf', content: '', status: 'pending' });
  const uploaded = (async () => {
    await whenSynced(db);
    try {
      await uploadPdf(db, id, input.file);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }
  })();
  return { id, title, uploaded };
}
