import { Hono } from 'hono';
import type { AppEnv, Env } from './env';
import { bearer, safeEqual } from './auth';
import { endCall } from './calls';
import { setLectureProgress } from './progress';
import { BadRequest, NotFound, Surreal, recordId } from './surreal';
import { startIngest, type MaterialRow } from './service';

/**
 * Background work the web app asks for by writing a row to the `job` outbox
 * (schema/src/outbox/api.surql). sp00ky's job runner POSTs the row's payload
 * here with the backend's token, retries anything but a 2xx, and records the
 * outcome on the row. These paths are never exposed publicly (sp00ky.yml
 * `expose`), and openapi.yml describes them.
 *
 * Nobody signs in on a job: the outbox permission only lets a student create a
 * job whose `assigned_to` is their own material or call and whose `payload.id`
 * is that same record. So the record's owner is the caller.
 */
export const jobs = new Hono<AppEnv>();

jobs.use('*', async (c, next) => {
  const token = bearer(c.req.header('authorization'));
  // No JOB_TOKEN configured refuses every job rather than accepting any.
  if (!c.env.JOB_TOKEN || !token || !safeEqual(token, c.env.JOB_TOKEN)) return c.json({ error: 'Unauthorized.' }, 401);
  await next();
});

type Payload = Record<string, unknown> & { id?: unknown };

/** The material a job is about, read as the API (the outbox checked ownership). */
async function jobMaterial(env: Env, raw: unknown): Promise<MaterialRow> {
  const row = await Surreal.system(env).query<MaterialRow | null>('SELECT * FROM ONLY type::record($id)', { id: recordId('material', raw) });
  if (!row) throw new NotFound('Material not found.');
  return row;
}

// (Re)builds a material's search index after its text was added or edited.
jobs.post('/materials/index', async (c) => {
  const body = await c.req.json<Payload>();
  const material = await jobMaterial(c.env, body.id);
  if (material.kind === 'pdf' && !material.content.trim()) throw new BadRequest('Upload the PDF first.');
  const rev = await startIngest(c.env, material.id);
  return c.json({ ok: true, rev });
});

// Records the last lecture section the student reached.
jobs.post('/materials/progress', async (c) => {
  const body = await c.req.json<Payload>();
  const material = await jobMaterial(c.env, body.id);
  return c.json(await setLectureProgress(c.env, material.owner, material.id, { through: body.through, rev: body.rev }));
});

// Ends a call and writes its recap with Claude, which takes a while.
jobs.post('/calls/end', async (c) => {
  const body = await c.req.json<Payload>();
  const id = recordId('call', body.id);
  const owner = await Surreal.system(c.env).query<string | null>('RETURN (SELECT VALUE owner FROM ONLY type::record($id))', { id });
  if (!owner) throw new NotFound('Call not found.');
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null;
  const { recap } = await endCall(c.env, owner, id, conversationId);
  return c.json({ ok: true, recap: recap !== null });
});
