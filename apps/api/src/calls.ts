import type { Env } from './env';
import { randomKey, sha256Hex } from './auth';
import { claude, FALLBACK, textOf } from './claude';
import { getOwnedCourse, getOwnedMaterial, type CourseRow, type MaterialRow } from './service';
import { BadRequest, NotFound, Surreal, UserError, recordId } from './surreal';
import { type CallMode, firstMessage, headingsOf, RECAP_SYSTEM, tutorSystemPrompt } from './tutor';

export interface CallRow {
  id: string;
  owner: string;
  course: string;
  material?: string | null;
  mode: CallMode;
  status: 'starting' | 'live' | 'ended';
  started_at: string;
  recap?: string | null;
  key_hash?: string;
}

const MODES: CallMode[] = ['explain', 'quiz', 'qa'];

/**
 * Starts a call: records it, and gets a one-time WebRTC conversation token
 * from ElevenLabs. The returned call key travels to the voice agent as a
 * `secret__` dynamic variable and comes back on every LLM request, proving
 * which call (and so which student and course) the request belongs to.
 */
export async function startCall(env: Env, userId: string, input: { courseId?: string; materialId?: string | null; mode?: string }) {
  if (!input.courseId) throw new BadRequest('courseId is required.');
  const mode = (input.mode ?? 'explain') as CallMode;
  if (!MODES.includes(mode)) throw new BadRequest(`mode must be one of ${MODES.join(', ')}.`);

  const course = await getOwnedCourse(env, userId, input.courseId);
  const material = input.materialId ? await getOwnedMaterial(env, userId, input.materialId) : null;
  if (material && material.course !== course.id) throw new BadRequest('That material belongs to another course.');
  if (material && !material.content.trim()) throw new BadRequest('That material has no content yet.');

  const db = Surreal.system(env);
  const studentName =
    (await db.query<string | null>('RETURN (SELECT VALUE name FROM ONLY type::record($u))', { u: userId }))?.split(' ')[0] ||
    'there';

  const callKey = randomKey();
  const callId = `call:k${crypto.randomUUID().replaceAll('-', '')}`;
  await db.query(
    `CREATE type::record($id) CONTENT {
       owner: type::record($owner), course: type::record($course),
       material: IF $material THEN type::record($material) ELSE NONE END,
       mode: $mode, status: 'starting', key_hash: $hash
     }`,
    { id: callId, owner: userId, course: course.id, material: material?.id ?? null, mode, hash: await sha256Hex(callKey) },
  );

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(env.ELEVENLABS_AGENT_ID)}`,
    { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } },
  );
  if (!res.ok) {
    console.error('[calls] ElevenLabs token failed', res.status, await res.text());
    await db.query("UPDATE type::record($id) SET status = 'ended', ended_at = time::now()", { id: callId });
    throw new UserError('The voice service is not reachable right now. Try again in a minute.', 503);
  }
  const { token } = (await res.json()) as { token: string };

  return {
    callId,
    conversationToken: token,
    callKey,
    studentName,
    language: course.language,
    firstMessage: firstMessage(course.language, mode, studentName, material?.title ?? course.title),
  };
}

/** Ends a call and writes its recap. */
export async function endCall(env: Env, userId: string, rawCallId: string, conversationId: string | null) {
  const callId = recordId('call', rawCallId);
  const db = Surreal.system(env);
  const call = await db.query<CallRow | null>(
    'RETURN (SELECT * FROM type::record($id) WHERE owner = type::record($owner))[0]',
    { id: callId, owner: userId },
  );
  if (!call) throw new NotFound('Call not found.');
  // Ending twice (a retry, a second tab) must not pay for a second recap.
  if (call.status === 'ended') return { recap: call.recap ?? null };
  await db.query(
    `UPDATE type::record($id) SET status = 'ended', ended_at = ended_at ?? time::now(),
       conversation_id = conversation_id ?? $conv`,
    { id: callId, conv: conversationId },
  );

  const turns = await db.query<{ role: string; text: string }[]>(
    'SELECT role, text, seq FROM call_turn WHERE call = type::record($id) ORDER BY seq',
    { id: callId },
  );
  if (turns.filter((t) => t.role === 'student').length === 0) return { recap: null };

  const transcript = turns.map((t) => `${t.role === 'tutor' ? 'Tutor' : 'Student'}: ${t.text}`).join('\n');
  try {
    const msg = await claude(env)
      .beta.messages.stream({
        model: env.CLAUDE_MODEL,
        max_tokens: 4000,
        ...FALLBACK,
        output_config: { effort: 'low' },
        system: RECAP_SYSTEM,
        messages: [{ role: 'user', content: `<transcript>\n${transcript}\n</transcript>` }],
      })
      .finalMessage();
    const recap = msg.stop_reason === 'refusal' ? null : textOf(msg).trim() || null;
    if (recap) await db.query('UPDATE type::record($id) SET recap = $recap', { id: callId, recap });
    return { recap };
  } catch (err) {
    // The call is over either way; the transcript is still there to read.
    console.error('[calls] recap failed', err);
    return { recap: null };
  }
}

// ── Per-call tutor context ───────────────────────────────────────────────

export interface CallContext {
  call: CallRow;
  course: CourseRow;
  system: string;
  /** Whether the call's lecture is in the prompt in full (then no per-turn search needed for it). */
  fullLecture: boolean;
  courseHasOtherMaterial: boolean;
}

const contexts = new Map<string, { ctx: CallContext; until: number }>();

/** Checks the call key and builds (or reuses) the tutor prompt for the call. */
export async function callContext(env: Env, rawCallId: string, callKey: string): Promise<CallContext | null> {
  const callId = recordId('call', rawCallId);
  const hash = await sha256Hex(callKey);
  const hit = contexts.get(callId);
  if (hit && hit.until > Date.now() && hit.ctx.call.key_hash === hash) return hit.ctx;

  const db = Surreal.system(env);
  const call = await db.query<CallRow | null>('SELECT * FROM ONLY type::record($id)', { id: callId });
  if (!call || !call.key_hash || call.key_hash !== hash || call.status === 'ended') return null;
  if (Date.now() - new Date(call.started_at).getTime() > 3 * 60 * 60 * 1000) return null;

  const [course, material, outlineRows, name] = await Promise.all([
    db.query<CourseRow>('SELECT * FROM ONLY type::record($id)', { id: call.course }),
    call.material ? db.query<MaterialRow | null>('SELECT * FROM ONLY type::record($id)', { id: call.material }) : null,
    db.query<{ id: string; title: string; headings: string[] }[]>(
      `SELECT id, title, created_at, content.split('\n').filter(|$l| $l.starts_with('#') AND !$l.starts_with('####')) AS headings
       FROM material WHERE course = type::record($c) AND owner = type::record($o) AND status = 'ready' ORDER BY created_at`,
      { c: call.course, o: call.owner },
    ),
    db.query<string | null>('RETURN (SELECT VALUE name FROM ONLY type::record($u))', { u: call.owner }),
  ]);

  const outline = outlineRows.map((m) => ({ title: m.title, headings: headingsOf(m.headings.join('\n')) }));
  const system = tutorSystemPrompt({
    course,
    material,
    outline,
    mode: call.mode,
    studentName: name?.split(' ')[0] || 'the student',
  });
  // Only what each turn needs: the lecture text lives once, inside `system`.
  const ctx: CallContext = {
    call,
    course,
    system,
    fullLecture: !!material && system.includes('<lecture>'),
    courseHasOtherMaterial: outlineRows.some((m) => m.id !== call.material),
  };
  if (contexts.size > 50) contexts.clear();
  // Short-lived, so an ended call stops being served soon after.
  contexts.set(callId, { ctx, until: Date.now() + 2 * 60 * 1000 });
  return ctx;
}

/** Saves spoken turns of the conversation, idempotently by position. */
export async function saveTurns(env: Env, call: CallRow, turns: { seq: number; role: 'student' | 'tutor'; text: string }[]) {
  const rows = turns.filter((t) => t.text.trim());
  if (!rows.length) return;
  const key = call.id.slice(call.id.indexOf(':') + 1);
  await Surreal.system(env).query(
    `FOR $t IN $rows {
       UPSERT type::record($t.id) CONTENT {
         owner: type::record($owner), call: type::record($call), seq: $t.seq, role: $t.role, text: $t.text
       };
     };
     UPDATE type::record($call) SET status = 'live' WHERE status = 'starting';`,
    {
      owner: call.owner,
      call: call.id,
      rows: rows.map((t) => ({ id: `call_turn:${key}_${t.seq}`, seq: t.seq, role: t.role, text: t.text.trim() })),
    },
  );
}

