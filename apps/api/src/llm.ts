import type Anthropic from '@anthropic-ai/sdk';
import type { Env } from './env';
import { bearer, safeEqual } from './auth';
import { CitationFilter } from './citations';
import { callContext, saveTurnSources, saveTurns } from './calls';
import { claude, FALLBACK } from './claude';
import { learningContext, permittedSpokenTurns, progressTool, teachingTool, PREPARE_SECTION, prepareExplanation, RECORD_SECTION, recordReached, rememberConfirmedExchange, saveLearningFocus, type LearningContext } from './learning';

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
      // Citation markers come out of the text before it is spoken.
      const citer = new CitationFilter();
      let learning: LearningContext | undefined;
      let stream: ReturnType<ReturnType<typeof claude>['beta']['messages']['stream']> | undefined;
      try {
        // The student's turn (and the tutor's previous one, as actually spoken,
        // since ElevenLabs trims interrupted replies) go to the transcript now.
        ctx.waitUntil(saveTurns(env, call.call, spoken.slice(-3)).catch((e) => console.error('[llm] transcript', e)));

        await sse.role();
        learning = await learningContext(env, call.call, lastStudent);
        ctx.waitUntil(rememberConfirmedExchange(env, call.call, learning, spoken).catch((e) => console.error('[learning] evidence write failed', e)));
        const permitted = await permittedSpokenTurns(env, call.call, learning, spoken);
        let seq = 0;
        const boundedHistory = history.filter((m) => {
          if ((m.role === 'user' || m.role === 'assistant') && textOfContent(m.content).trim()) return permitted.has(seq++);
          return true;
        });
        const messages = toAnthropic(boundedHistory);
        // Passages ride along with the student's turn (they are the student's
        // own material, and every model accepts them there).
        const last = messages[messages.length - 1];
        if (Array.isArray(last.content)) last.content.push({ type: 'text', text: learning.note });

        // Internal progress tools run here. Voice-agent tools such as end_call
        // keep their existing streaming contract with ElevenLabs.
        let progressRecorded = false;
        let teaching = false;
        let focusSaved = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          const tools: Anthropic.Beta.BetaTool[] = [...(body.tools ?? []).filter((t) => ![RECORD_SECTION, PREPARE_SECTION].includes(t.function.name)).map((t) => ({
            name: t.function.name,
            description: t.function.description ?? '',
            input_schema: (t.function.parameters as Anthropic.Beta.BetaTool.InputSchema) ?? { type: 'object', properties: {} },
          })), ...(learning.next && attempt < 3 ? [teachingTool, ...(!progressRecorded ? [progressTool] : [])] : [])];
          stream = claude(env).beta.messages.stream({
            model: env.CLAUDE_MODEL,
            max_tokens: 4096,
            ...FALLBACK,
            // A spoken reply: fast beats deep.
            output_config: { effort: 'low' },
            system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
            messages,
            ...(tools.length ? { tools, tool_choice: { type: 'auto' as const, disable_parallel_tool_use: true } } : {}),
          });

          const toolIndex = new Map<number, number>();
          const internal = new Set<number>();
          let finish: 'stop' | 'tool_calls' | 'length' = 'stop';
          for await (const ev of stream) {
            if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
              if ([RECORD_SECTION, PREPARE_SECTION].includes(ev.content_block.name)) {
                internal.add(ev.index);
                continue;
              }
              const n = toolIndex.size;
              toolIndex.set(ev.index, n);
              await sse.delta({
                tool_calls: [{ index: n, id: ev.content_block.id, type: 'function', function: { name: ev.content_block.name, arguments: '' } }],
              });
            } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
              const text = citer.push(ev.delta.text);
              if (!text) continue;
              // Persist before speech is exposed: an interruption may trigger the
              // student's next request before this response reaches its finalizer.
              if (!focusSaved) {
                await saveLearningFocus(env, call.call, spoken.length, learning, teaching);
                focusSaved = true;
              }
              reply += text;
              await sse.delta({ content: text });
            } else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') {
              if (internal.has(ev.index)) continue;
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
          const held = citer.flush();
          if (held) {
            reply += held;
            await sse.delta({ content: held });
          }
          const final: Anthropic.Beta.BetaMessage = await stream.finalMessage();
          const progress = final.content.find((b) => b.type === 'tool_use' && [RECORD_SECTION, PREPARE_SECTION].includes(b.name));
          if (progress?.type === 'tool_use') {
            if (attempt === 3) { await sse.finish('stop'); break; }
            let result: string;
            let isError = false;
            try {
              if (progress.name === PREPARE_SECTION) {
                prepareExplanation(learning, progress.input as Record<string, unknown>);
                teaching = true;
                focusSaved = false;
                result = 'Explain this prepared section now, then check understanding. Wait for the student before recording it as reached.';
              } else {
                if (progressRecorded) throw new Error('Progress has already been recorded for this student turn.');
                const confirmedTutor = spoken.slice(0, -1).reverse().find((t) => t.role === 'tutor');
                await recordReached(env, call.call, learning, progress.input as Record<string, unknown>, lastStudent, confirmedTutor?.seq);
                progressRecorded = true;
                const oldNote = learning.note;
                learning = await learningContext(env, call.call, lastStudent, learning.refs);
                teaching = false;
                if (Array.isArray(last.content)) last.content = last.content.filter((b) => b.type !== 'text' || b.text !== oldNote);
                result = `Section recorded as reached, not mastered.\n${learning.note}`;
              }
            } catch (err) {
              isError = true;
              result = err instanceof Error ? err.message : 'Progress could not be saved.';
            }
            messages.push({ role: 'assistant', content: final.content });
            messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: progress.id, content: result, is_error: isError }] });
            continue;
          }
          await sse.finish(finish);
          break;
        }
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
          // Offsets into the saved (trimmed) text; each passage once, where first cited.
          const lead = reply.length - reply.trimStart().length;
          const refs = learning?.refs;
          const seen = new Set<number>();
          const sources = refs ? citer.citations.flatMap((c) => {
            const source = refs.get(c.ref);
            if (!source || seen.has(c.ref)) return [];
            seen.add(c.ref);
            return [{ ...source, at: Math.max(0, c.at - lead) }];
          }) : [];
          await saveTurnSources(env, call.call, spoken.length, sources).catch((e) => console.error('[llm] sources', e));
        }
      }
    })(),
  );

  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' },
  });
}

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
