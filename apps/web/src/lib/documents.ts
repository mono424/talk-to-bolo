import { lectureMarkdown } from '../../../../shared/lecture';
import { draftMarkdown, findReferences, matchMaterials } from '../../../../shared/references';
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
 * Starts a document from a material of the course (a draft uploaded as
 * LaTeX, Markdown or a PDF): its text as Markdown on the left, and on the
 * right the papers it mentions ("Stark et al. (2019): [title](link)"), each
 * linked to the course material holding it when there is one.
 */
export async function createDocumentFromMaterial(
  db: Db,
  input: {
    owner: string;
    material: { id: string; course: string; title: string; kind: string; content: string };
    materials: readonly { id: string; title: string }[];
  },
): Promise<string> {
  const content = draftMarkdown(lectureMarkdown(input.material.kind, input.material.content));
  const id = newId('document');
  await db.create(id, { owner: input.owner, course: input.material.course, source: input.material.id, title: input.material.title, content });
  const refs = findReferences(content);
  const matches = matchMaterials(refs, input.materials.filter((m) => m.id !== input.material.id));
  for (const [i, ref] of refs.entries()) {
    const material = matches[i];
    await db.create(newId('paper'), {
      owner: input.owner,
      document: id,
      ...(material ? { material: material.id } : {}),
      title: ref.title,
      authors: ref.authors,
      year: ref.year,
      url: ref.url,
    });
  }
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
