import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Env } from '../src/env.ts';
import type { CallRow } from '../src/calls.ts';
import { Surreal } from '../src/surreal.ts';
import { ensureServerSchema, searchCourse } from '../src/service.ts';
import { learningContext, permittedSpokenTurns, recordReached, rememberConfirmedExchange, saveLearningFocus } from '../src/learning.ts';
import { setLectureProgress } from '../src/progress.ts';
import { tutorSystemPrompt } from '../src/tutor.ts';

test('cached tutor instructions do not contain future lecture text or outlines', () => {
  const prompt = tutorSystemPrompt({
    course: { id: 'course:c1', owner: 'user:u1', title: 'Math', language: 'en' },
    material: { title: 'Lecture', content: 'FUTURE_SECRET' } as never,
    mode: 'explain', studentName: 'Student',
  });
  assert.ok(!prompt.includes('FUTURE_SECRET'));
  assert.ok(prompt.includes('not evidence of the student'));
});

test('local SurrealDB enforces lecture boundaries, progress and evidence receipts', {
  skip: !process.env.BOLO_TEST_SURREAL,
}, async (t) => {
  const namespace = `bolo_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
  const env = {
    SPKY_DB_URL: 'http://127.0.0.1:8666', SPKY_DB_NS: namespace, SPKY_DB_NAME: 'main', SPKY_DB_USER: 'root', SPKY_DB_PASS: 'root',
    EMBEDDING_MODEL: 'test', AI: { run: async () => ({ data: [vector] }) },
  } as unknown as Env;
  const db = Surreal.system(env);
  const schema = await readFile(new URL('../../../schema/src/schema.surql', import.meta.url), 'utf8');
  const call: CallRow = { id: 'call:k1', owner: 'user:u1', course: 'course:c1', material: 'material:m1', mode: 'explain', status: 'live', started_at: new Date().toISOString() };
  try {
    await db.query(`DEFINE NAMESPACE ${namespace}; DEFINE DATABASE main;`);
    await db.queryAll(schema);
    await ensureServerSchema(env);
    // A second apply catches non-idempotent server schema statements.
    await db.queryAll(await readFile(new URL('../src/server-schema.surql', import.meta.url), 'utf8'));
    await db.query(`
      CREATE user:u1 CONTENT {email:'student@example.test',name:'Student',password:'test'};
      CREATE user:u2 CONTENT {email:'other@example.test',name:'Other',password:'test'};
      CREATE course:c1 CONTENT {owner:user:u1,title:'Math'};
      CREATE course:c2 CONTENT {owner:user:u2,title:'Other course'};
      CREATE material:m1 CONTENT {owner:user:u1,course:course:c1,title:'Lecture',kind:'markdown',content:'Source',status:'ready',index_rev:1,chunk_count:3};
      CREATE material:m2 CONTENT {owner:user:u2,course:course:c2,title:'Other lecture',kind:'markdown',status:'ready',index_rev:1,chunk_count:1,learned_through:0};
      CREATE call:k1 CONTENT {owner:user:u1,course:course:c1,material:material:m1,mode:'explain',key_hash:'test'};
      FOR $c IN $chunks {
        CREATE type::record($c.id) CONTENT {
          owner: type::record($c.owner),course:type::record($c.course),material:type::record($c.material),
          rev:$c.rev,position:$c.position,text:$c.text,embedding:$vector
        };
      };`, { vector, chunks: [
        { id: 'chunk:c0', owner: 'user:u1', course: 'course:c1', material: 'material:m1', rev: 1, position: 0, text: 'INTRODUCTION_MARKER derivatives describe the rate of change.' },
        { id: 'chunk:c1', owner: 'user:u1', course: 'course:c1', material: 'material:m1', rev: 1, position: 1, text: 'FUTURE_MARKER gradients generalize derivatives to several variables.' },
        { id: 'chunk:c2', owner: 'user:u1', course: 'course:c1', material: 'material:m1', rev: 1, position: 2, text: 'LATER_MARKER eigenvectors preserve a direction under a transformation.' },
        { id: 'chunk:stale', owner: 'user:u1', course: 'course:c1', material: 'material:m1', rev: 0, position: 0, text: 'OBSOLETE_MARKER derivatives.' },
        { id: 'chunk:foreign', owner: 'user:u2', course: 'course:c2', material: 'material:m2', rev: 1, position: 0, text: 'FOREIGN_MARKER derivatives.' },
      ] });

    await t.test('upload does not mark sections reached; explain gets only the first teaching section', async () => {
      const learning = await learningContext(env, call, '');
      assert.equal(learning.materials[0].learned_through, -1);
      assert.ok(learning.note.includes('INTRODUCTION_MARKER'));
      for (const secret of ['FUTURE_MARKER', 'LATER_MARKER', 'OBSOLETE_MARKER', 'FOREIGN_MARKER']) assert.ok(!learning.note.includes(secret), secret);
      assert.equal(learning.next?.position, 0);
      await assert.rejects(recordReached(env, call, learning, { materialId: 'material:m1', rev: 1, position: 0, confirmation: 'Yes' }, 'Yes'), /Explain this section/);
    });

    await t.test('confirmed advancement is limited to the prior tutor section and atomic previous frontier', async () => {
      const learning = await learningContext(env, call, '');
      await saveLearningFocus(env, call, 0, learning);
      await assert.rejects(recordReached(env, call, learning, { materialId: 'material:m1', rev: 1, position: 0, confirmation: 'Yes' }, 'Yes', 0), /Explain this section/);
      await saveLearningFocus(env, call, 1, learning, true);
      await recordReached(env, call, learning, { materialId: 'material:m1', rev: 1, position: 0, confirmation: 'covered it' }, 'I covered it', 1);
      await assert.rejects(recordReached(env, call, learning, { materialId: 'material:m1', rev: 1, position: 0, confirmation: 'covered it' }, 'I covered it', 1), /lecture changed/);
      const next = await learningContext(env, call, '');
      await assert.rejects(recordReached(env, call, next, { materialId: 'material:m1', rev: 1, position: 1, confirmation: 'Yes' }, 'Yes', 1), /Explain this section/);
    });

    await t.test('quiz, QA and hybrid search exclude future, obsolete and foreign chunks', async () => {
      for (const mode of ['quiz', 'qa'] as const) {
        const learning = await learningContext(env, { ...call, material: null, mode }, 'derivatives');
        assert.ok(learning.note.includes('INTRODUCTION_MARKER'));
        assert.equal(learning.next, null);
        for (const secret of ['FUTURE_MARKER', 'LATER_MARKER', 'OBSOLETE_MARKER', 'FOREIGN_MARKER']) assert.ok(!learning.note.includes(secret), secret);
      }
      const hits = await searchCourse(env, call.course, 'derivatives', { ownerId: call.owner, reachedOnly: true });
      assert.ok(hits.length > 0);
      assert.ok(hits.every((h) => h.text.includes('INTRODUCTION_MARKER')));
    });

    await t.test('progress can rewind manually but stale, oversized and foreign changes fail', async () => {
      await assert.rejects(setLectureProgress(env, call.owner, 'material:m1', { through: 3, rev: 1 }), /Choose a section/);
      await assert.rejects(setLectureProgress(env, call.owner, 'material:m1', { through: 0, rev: 0 }), /lecture changed/);
      await assert.rejects(setLectureProgress(env, call.owner, 'material:m2', { through: 0, rev: 1 }), /Material not found/);
      await setLectureProgress(env, call.owner, 'material:m1', { through: -1, rev: 1 });
      const learning = await learningContext(env, { ...call, mode: 'qa' }, '');
      assert.ok(!learning.note.includes('INTRODUCTION_MARKER'));
      const permitted = await permittedSpokenTurns(env, call, learning, [
        { seq: 1, role: 'tutor', text: 'Derivative discussion' },
        { seq: 2, role: 'student', text: 'Prior answer' },
        { seq: 3, role: 'student', text: 'Current request' },
      ]);
      assert.deepEqual([...permitted], [3], 'Rewinding also hides later conversation evidence.');
      await setLectureProgress(env, call.owner, 'material:m1', { through: 0, rev: 1 });
    });

    await t.test('whole-course QA evidence uses prior tutor focus and stable receipts across retries', async () => {
      const qa = { ...call, material: null, mode: 'qa' as const };
      const learning = await learningContext(env, qa, '');
      await saveLearningFocus(env, qa, 3, learning);
      const requests: { path: string; body: Record<string, unknown> }[] = [];
      const original = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).startsWith('https://memory.example/')) return original(url, init);
        const body = JSON.parse(init?.body as string);
        const path = new URL(String(url)).pathname;
        requests.push({ path, body });
        return Response.json(path.endsWith('/scopes') ? { path: body.path } : { mode: 'full' });
      });
      const memoryEnv = { ...env, AGENT_MEMORY_URL: 'https://memory.example/api/v1/test', AGENT_MEMORY_API_KEY: 'test' };
      const turns = [{ seq: 3, role: 'tutor' as const, text: 'What does a derivative represent?' }, { seq: 4, role: 'student' as const, text: 'A rate of change.' }];
      await rememberConfirmedExchange(memoryEnv, qa, learning, turns);
      await rememberConfirmedExchange(memoryEnv, qa, learning, turns);
      const writes = requests.filter((r) => r.path.endsWith('/facts'));
      assert.equal(writes.length, 1);
      assert.ok((writes[0].body.scopes as string[][])[0][0].endsWith('/student/section/p0'));
      assert.ok(Number.isFinite(Date.parse(writes[0].body.observed_at as string)));
      await db.query('DELETE call:k1');
      assert.equal(await db.query('RETURN count(SELECT * FROM learning_exchange)'), 0);
      assert.equal(await db.query('RETURN count(SELECT * FROM learning_focus)'), 0);
    });
  } finally {
    await db.query(`REMOVE NAMESPACE ${namespace};`);
  }
});
