import type Anthropic from '@anthropic-ai/sdk';
import type { Env } from './env';
import { bearer, safeEqual } from './auth';
import { callContext, saveTurns, type CallContext } from './calls';
import { claude, FALLBACK } from './claude';
import { searchCourse } from './service';

/**
 * The voice agent's "Custom LLM": an OpenAI Chat Completions compatible
 * endpoint (POST /llm/v1/chat/completions, streamed as SSE) that ElevenLabs
 * calls on every student turn. It
 *
 *   1. authenticates the agent (shared secret) and the call (per-call key),
 *   2. rebuilds the tutor prompt from the course in SurrealDB,
 *   3. searches the course for the student's last turn,
 *   4. streams Claude's reply back in OpenAI's chunk format,
 *   5. stores the transcript (which the web app shows live through sync).
 */

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | { type: string; text?: string }[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface OpenAIRequest {
  messages: OpenAIMessage[];
  tools?: { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  max_tokens?: number;
}

export async function handleChatCompletions(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = bearer(req.headers.get('authorization'));
  if (!secret || !safeEqual(secret, env.LLM_SHARED_SECRET)) return json({ error: { message: 'Unauthorized' } }, 401);

  const callId = req.headers.get('x-call-id');
  const callKey = req.headers.get('x-call-key');
  const call = callId && callKey ? await callContext(env, callId, callKey) : null;
  if (!call) return json({ error: { message: 'Unknown or expired call' } }, 403);

  const body = (await req.json()) as OpenAIRequest;
  const history = (body.messages ?? []).filter((m) => m.role !== 'system');
  const spoken = spokenTurns(history);
  const lastStudent = [...spoken].reverse().find((t) => t.role === 'student')?.text ?? '';

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const sse = new SseWriter(writer, 'studycall-tutor');

  ctx.waitUntil(
    (async () => {
      let reply = '';
      let stream: ReturnType<ReturnType<typeof claude>['beta']['messages']['stream']> | undefined;
      try {
        // The student's turn (and the tutor's previous one, as actually spoken,
        // since ElevenLabs trims interrupted replies) go to the transcript now.
        ctx.waitUntil(saveTurns(env, call.call, spoken.slice(-3)).catch((e) => console.error('[llm] transcript', e)));

        await sse.role();
        const excerpts = await retrieve(env, call, lastStudent);
        const messages = toAnthropic(history);
        // Passages ride along with the student's turn (they are the student's
        // own material, and every model accepts them there).
        const last = messages[messages.length - 1];
        if (excerpts && Array.isArray(last.content)) last.content.push({ type: 'text', text: excerpts });

        stream = claude(env).beta.messages.stream({
          model: env.CLAUDE_MODEL,
          max_tokens: 4096,
          ...FALLBACK,
          // A spoken reply: fast beats deep.
          output_config: { effort: 'low' },
          system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
          messages,
          tools: (body.tools ?? []).map((t) => ({
            name: t.function.name,
            description: t.function.description ?? '',
            input_schema: (t.function.parameters as Anthropic.Beta.BetaTool.InputSchema) ?? { type: 'object', properties: {} },
          })),
        });

        const toolIndex = new Map<number, number>();
        let finish: 'stop' | 'tool_calls' | 'length' = 'stop';
        for await (const ev of stream) {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            const n = toolIndex.size;
            toolIndex.set(ev.index, n);
            await sse.delta({
              tool_calls: [{ index: n, id: ev.content_block.id, type: 'function', function: { name: ev.content_block.name, arguments: '' } }],
            });
          } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            reply += ev.delta.text;
            await sse.delta({ content: ev.delta.text });
          } else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') {
            const n = toolIndex.get(ev.index);
            if (n !== undefined) await sse.delta({ tool_calls: [{ index: n, function: { arguments: ev.delta.partial_json } }] });
          } else if (ev.type === 'message_delta' && ev.delta.stop_reason) {
            finish = ev.delta.stop_reason === 'tool_use' ? 'tool_calls' : ev.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
            if (ev.delta.stop_reason === 'refusal' && !reply) {
              reply = "Let's leave that one and get back to the material.";
              await sse.delta({ content: reply });
            }
          }
        }
        await sse.finish(finish);
      } catch (err) {
        if (sse.closed) {
          // The agent hung up on this turn (the student interrupted): stop generating.
          stream?.abort();
        } else {
          console.error('[llm] generation failed', err);
          const sorry = 'Sorry, I lost my train of thought there. Could you say that again?';
          reply ||= sorry;
          await sse.delta({ content: sorry }).catch(() => {});
          await sse.finish('stop').catch(() => {});
        }
      } finally {
        await sse.done();
        if (reply.trim()) {
          await saveTurns(env, call.call, [{ seq: spoken.length, role: 'tutor', text: reply }]).catch((e) =>
            console.error('[llm] transcript', e),
          );
        }
      }
    })(),
  );

  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
}

/** Course passages for the student's turn, as a mid-conversation system note. */
async function retrieve(env: Env, call: CallContext, studentTurn: string): Promise<string | null> {
  // The whole lecture is already in the prompt and there is nothing else to search.
  if (call.fullLecture && !call.courseHasOtherMaterial) return null;
  if (studentTurn.replace(/\W/g, '').length < 4) return null;
  try {
    const hits = await searchCourse(env, call.course.id, studentTurn, { k: 5, ownerId: call.call.owner });
    if (!hits.length) return null;
    const body = hits
      .map((h) => `<passage source="${escapeAttr(h.materialTitle)}${h.heading ? ` > ${escapeAttr(h.heading)}` : ''}">\n${h.text}\n</passage>`)
      .join('\n');
    return `<course_passages>\nPassages from the course material that may help with this turn. Use them if relevant; do not read them out verbatim.\n${body}\n</course_passages>`;
  } catch (err) {
    console.error('[llm] search failed', err);
    return null;
  }
}

const escapeAttr = (s: string) => s.replaceAll('"', "'");

const textOfContent = (c: OpenAIMessage['content']): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '';

/** The conversation as spoken, numbered for the transcript. */
function spokenTurns(history: OpenAIMessage[]) {
  return history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && textOfContent(m.content).trim())
    .map((m, seq) => ({ seq, role: m.role === 'user' ? ('student' as const) : ('tutor' as const), text: textOfContent(m.content) }));
}

/** OpenAI chat history to Anthropic messages (tool calls and results included). */
function toAnthropic(history: OpenAIMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  const push = (role: 'user' | 'assistant', blocks: Anthropic.Beta.BetaContentBlockParam[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of history) {
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: textOfContent(m.content) || 'ok' }]);
    } else if (m.role === 'assistant') {
      const text = textOfContent(m.content);
      push('assistant', [
        ...(text.trim() ? [{ type: 'text' as const, text }] : []),
        ...(m.tool_calls ?? []).map((tc) => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.function.name,
          input: safeParse(tc.function.arguments),
        })),
      ]);
    } else if (m.role === 'user') {
      push('user', [{ type: 'text', text: textOfContent(m.content).trim() || '(silence)' }]);
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(The call has connected.)' }] });
  if (out[out.length - 1]?.role !== 'user') out.push({ role: 'user', content: [{ type: 'text', text: '(silence)' }] });
  return out;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Writes OpenAI `chat.completion.chunk` events. */
class SseWriter {
  private readonly id = `chatcmpl-${crypto.randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly enc = new TextEncoder();
  closed = false;

  constructor(
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
    private readonly model: string,
  ) {}

  private async write(payload: string) {
    if (this.closed) throw new Error('stream closed');
    try {
      await this.writer.write(this.enc.encode(payload));
    } catch (err) {
      this.closed = true;
      throw err;
    }
  }

  private chunk(delta: Record<string, unknown>, finish: string | null) {
    return `data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  }

  role() {
    return this.write(this.chunk({ role: 'assistant', content: '' }, null));
  }

  delta(delta: Record<string, unknown>) {
    return this.write(this.chunk(delta, null));
  }

  finish(reason: string) {
    return this.write(this.chunk({}, reason));
  }

  async done() {
    if (this.closed) return;
    try {
      await this.writer.write(this.enc.encode('data: [DONE]\n\n'));
      await this.writer.close();
    } catch {
      /* the agent already hung up */
    }
    this.closed = true;
  }
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
