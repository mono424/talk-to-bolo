import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './env';
import { chunkMarkdown, embedText } from './chunk';
import { convertPages, extractPageImages, loadPdf, pageCount, placeMissingImages, type PageImageRef } from './pdf';
import { embed, ensureServerSchema, type MaterialRow } from './service';
import { Surreal, UserError, toBase64 } from './surreal';

export interface IngestParams {
  materialId: string;
  /** The material's `index_rev` when this run was started. */
  rev: number;
  /** Convert the uploaded PDF to Markdown first (a new upload), or only re-index the current Markdown (an edit). */
  convert: boolean;
}

const PAGES_PER_IMAGE_STEP = 20;
const PAGES_PER_CONVERT_STEP = 10;
const CHUNKS_PER_EMBED_STEP = 48;
const EMBED_BATCH = 16;

const RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '15 minutes' } as const;

/** Step result when a newer upload or edit has taken over this material. */
const STOP = '__superseded__' as const;
type Stop = typeof STOP;

/**
 * Turns a material into something the tutor can teach from, durably, one
 * retryable step at a time:
 *
 *   PDF:  extract images -> convert pages to markdown with Claude -> save
 *   all:  chunk the markdown -> embed with Workers AI -> write the search index
 *
 * Progress is written to `material.status_detail`, which the web app shows
 * live through sync. A newer upload or edit bumps `index_rev`; this run then
 * stops at its next step.
 */
export class IngestMaterial extends WorkflowEntrypoint<Env, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const { materialId, rev, convert } = event.payload;
    const db = Surreal.system(this.env);

    // The material, or null once a newer run owns it.
    const current = async (): Promise<MaterialRow | null> => {
      const m = await db.query<MaterialRow | null>('SELECT * FROM ONLY type::record($id)', { id: materialId });
      return m && m.index_rev === rev ? m : null;
    };
    const progress = (detail: string) =>
      db.query('UPDATE type::record($id) SET status_detail = $detail WHERE index_rev = $rev', { id: materialId, detail, rev });
    const stopped = { superseded: true };

    try {
      const meta = await step.do('load', RETRY, async () => {
        await ensureServerSchema(this.env);
        const m = await current();
        return m ? { kind: m.kind, owner: m.owner, course: m.course, title: m.title } : STOP;
      });
      if (meta === STOP) return stopped;

      if (meta.kind === 'pdf' && convert) {
        const pages = await step.do('count pages', RETRY, async (): Promise<number | Stop> => {
          if (!(await current())) return STOP;
          const n = await pageCount(await loadPdf(this.env, materialId));
          await db.query('UPDATE type::record($id) SET page_count = $n; DELETE asset WHERE material = type::record($id);', {
            id: materialId,
            n,
          });
          return n;
        });
        if (pages === STOP) return stopped;

        for (let from = 1; from <= pages; from += PAGES_PER_IMAGE_STEP) {
          const to = Math.min(pages, from + PAGES_PER_IMAGE_STEP - 1);
          const r = await step.do(`images ${from}-${to}`, RETRY, async (): Promise<number | Stop> => {
            if (!(await current())) return STOP;
            await progress(`Extracting images, pages ${from}-${to} of ${pages}`);
            const images = await extractPageImages(await loadPdf(this.env, materialId), from, to);
            // Extraction takes a while: make sure no newer upload took over meanwhile.
            if (!(await current())) return STOP;
            // A retried step must not duplicate its images.
            await db.query('DELETE asset WHERE material = type::record($m) AND page >= $from AND page <= $to', {
              m: materialId,
              from,
              to,
            });
            for (const im of images) {
              await db.query(
                `CREATE type::record($id) CONTENT {
                   owner: type::record($owner), material: type::record($m), page: $page,
                   mime: 'image/png', width: $w, height: $h, hash: $hash,
                   data: encoding::base64::decode($b64)
                 }`,
                {
                  id: `asset:a${crypto.randomUUID().replaceAll('-', '')}`,
                  owner: meta.owner,
                  m: materialId,
                  page: im.page,
                  w: im.width,
                  h: im.height,
                  hash: im.hash,
                  b64: toBase64(im.png),
                },
              );
            }
            return images.length;
          });
          if (r === STOP) return stopped;
        }

        const images = await step.do('drop repeated images', RETRY, async () => {
          // A picture on three or more pages is a logo or decoration, not content.
          await db.query(
            `LET $per_page = SELECT hash, page FROM asset WHERE material = type::record($m) GROUP BY hash, page;
             LET $repeated = (SELECT hash, count() AS n FROM $per_page GROUP BY hash).filter(|$r| $r.n >= 3).hash;
             DELETE asset WHERE material = type::record($m) AND hash IN $repeated;`,
            { m: materialId },
          );
          return db.query<PageImageRef[]>(
            'SELECT record::id(id) AS id, page, width, height FROM asset WHERE material = type::record($m) ORDER BY page',
            { m: materialId },
          );
        });

        const parts: string[] = [];
        for (let from = 1; from <= pages; from += PAGES_PER_CONVERT_STEP) {
          const to = Math.min(pages, from + PAGES_PER_CONVERT_STEP - 1);
          const md = await step.do(`convert ${from}-${to}`, RETRY, async (): Promise<string | Stop> => {
            if (!(await current())) return STOP;
            await progress(`Converting pages ${from}-${to} of ${pages}`);
            const pageImages = images.filter((im) => im.page >= from && im.page <= to);
            return convertPages(this.env, await loadPdf(this.env, materialId), from, to, pages, meta.title, pageImages);
          });
          if (md === STOP) return stopped;
          parts.push(md);
        }

        const saved = await step.do('save markdown', RETRY, async (): Promise<true | Stop> => {
          if (!(await current())) return STOP;
          await db.query('UPDATE type::record($id) SET content = $content, image_count = $n', {
            id: materialId,
            content: placeMissingImages(parts.join('\n\n'), images),
            n: images.length,
          });
          return true;
        });
        if (saved === STOP) return stopped;
      }

      const total = await step.do('chunk', RETRY, async (): Promise<number | Stop> => {
        const m = await current();
        if (!m) return STOP;
        await progress('Building the search index');
        return chunkMarkdown(m.content).length;
      });
      if (total === STOP) return stopped;

      for (let from = 0; from < total; from += CHUNKS_PER_EMBED_STEP) {
        const to = Math.min(total, from + CHUNKS_PER_EMBED_STEP);
        const r = await step.do(`embed ${from}-${to}`, RETRY, async (): Promise<true | Stop> => {
          const m = await current();
          if (!m) return STOP;
          await progress(`Indexing sections ${from + 1}-${to} of ${total}`);
          const chunks = chunkMarkdown(m.content).slice(from, to);
          for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
            const batch = chunks.slice(i, i + EMBED_BATCH);
            const vectors = await embed(this.env, batch.map(embedText), 'documents');
            await db.query(
              `FOR $c IN $rows {
                 UPSERT type::record($c.id) CONTENT {
                   owner: type::record($owner), course: type::record($course), material: type::record($m),
                   rev: $rev, position: $c.position, heading: $c.heading, text: $c.text, embedding: $c.embedding
                 };
               };`,
              {
                owner: meta.owner,
                course: meta.course,
                m: materialId,
                rev,
                rows: batch.map((c, j) => ({
                  id: `chunk:${materialId.split(':')[1]}_${rev}_${from + i + j}`,
                  position: from + i + j,
                  heading: c.heading,
                  text: c.text,
                  embedding: vectors[j],
                })),
              },
            );
          }
          return true;
        });
        if (r === STOP) return stopped;
      }

      await step.do('finish', RETRY, async () => {
        // Only while this run still owns the material: a newer run's chunks
        // must survive an older run finishing late.
        await db.query(
          `BEGIN TRANSACTION;
           IF (SELECT VALUE index_rev FROM ONLY type::record($m)) = $rev {
             DELETE chunk WHERE material = type::record($m) AND rev != $rev;
             UPDATE type::record($m) SET status = 'ready', status_detail = NONE, error = NONE, chunk_count = $n;
           };
           COMMIT TRANSACTION;`,
          { m: materialId, rev, n: total },
        );
      });
      return { ok: true, chunks: total };
    } catch (err) {
      const message = err instanceof UserError ? err.message : 'Processing failed. Upload the file again to retry.';
      console.error(`[ingest] ${materialId} failed`, err);
      await step.do('mark failed', async () => {
        await db.query(
          `UPDATE type::record($m) SET status = 'failed', status_detail = NONE, error = $error WHERE index_rev = $rev`,
          { m: materialId, rev, error: message.slice(0, 500) },
        );
      });
      return { failed: message };
    }
  }
}
