import { A, useNavigate, useParams, useSearchParams } from '@solidjs/router';
import { createEffect, createMemo, For, Match, on, Show, Switch } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ArrowLeft, Mic, MicOff, PhoneCall, PhoneOff } from 'lucide-solid';
import type { schema } from '../schema.gen';
import type { CallMode } from '../lib/api';
import { useTutorCall } from '../lib/call';
import { idKey } from '../lib/ids';
import { renderMarkdown } from '../lib/markdown';
import { modeLabel } from '../lib/modes';
import { qCall, qCourse, qMaterial, qTurns } from '../lib/query';
import { Button, buttonClass, Card, Dot, formatDate, IconButton } from '../components/ui';

/**
 * A voice call with the tutor (/courses/:courseKey/call?mode=&material=), or a
 * past one (/calls/:callKey). The transcript is read from SurrealDB through a
 * live query: the API writes each turn as the call runs.
 */
export default function CallPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const db = useDb<typeof schema>();
  const navigate = useNavigate();
  const call = useTutorCall(db);

  // A past call by URL, or the one started on this page.
  const callId = () => (params.callKey ? `call:${params.callKey}` : call.callId());
  const record = useQuery(() => {
    const id = callId();
    return id ? qCall(db, id) : null;
  });
  const turns = useQuery(() => {
    const id = callId();
    return id ? qTurns(db, id) : null;
  });

  const courseKey = () => params.courseKey ?? (record.data()?.course ? idKey(record.data()!.course) : '');
  const materialKey = () =>
    params.callKey ? (record.data()?.material ? idKey(record.data()!.material) : '') : String(search.material ?? '');
  const mode = () => ((params.callKey ? record.data()?.mode : search.mode) ?? 'explain') as CallMode;

  const course = useQuery(() => (courseKey() ? qCourse(db, `course:${courseKey()}`) : null));
  const material = useQuery(() => (materialKey() ? qMaterial(db, `material:${materialKey()}`) : null));

  const isPast = () => !!params.callKey;
  const live = () => call.phase() === 'live' || call.phase() === 'connecting';
  const topic = () => material.data()?.title ?? course.data()?.title ?? '';

  const start = () =>
    call.start({ courseId: `course:${courseKey()}`, materialId: materialKey() ? `material:${materialKey()}` : null, mode: mode() });
  const again = () =>
    navigate(`/courses/${courseKey()}/call?mode=${mode()}${materialKey() ? `&material=${materialKey()}` : ''}`, { replace: !isPast() });

  // Keep the newest line in view.
  let transcriptEnd: HTMLDivElement | undefined;
  createEffect(on(() => turns.data()?.length, () => transcriptEnd?.scrollIntoView({ behavior: 'smooth', block: 'end' })));

  const lastTutorSeq = createMemo(() => [...(turns.data() ?? [])].reverse().find((t) => t.role === 'tutor')?.seq);
  const recapHtml = createMemo(() => (record.data()?.recap ? renderMarkdown(record.data()!.recap!) : ''));

  const status = () => {
    if (isPast()) return 'This call has ended';
    return {
      idle: 'Ready when you are',
      connecting: 'Calling your tutor…',
      live: call.speaking() ? 'Tutor is speaking' : call.muted() ? 'You are muted' : 'Listening',
      ending: 'Hanging up and writing your recap…',
      ended: 'Call ended',
      error: call.error() ?? 'The call could not start',
    }[call.phase()];
  };

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-6">
        <Show when={!live()} fallback={<span class="px-2 text-[15px] font-medium">{course.data()?.title}</span>}>
          <A href={courseKey() ? `/courses/${courseKey()}` : '/'} class={`${buttonClass('ghost', 'sm')} -ml-1 text-muted`}>
            <ArrowLeft size={16} stroke-width={1.75} /> {course.data()?.title ?? 'Course'}
          </A>
        </Show>
        <span class="ml-auto truncate text-[14px] text-muted">
          {modeLabel(mode())}: {topic()}
          <Show when={isPast() && record.data()?.started_at}>, {formatDate(record.data()!.started_at, true)}</Show>
        </span>
      </div>

      <div class="grid flex-1 lg:grid-cols-[minmax(20rem,28rem)_1fr]">
        {/* The call */}
        <section class="flex flex-col items-center justify-center gap-7 border-b border-line px-6 py-14 lg:border-b-0 lg:border-r" aria-live="polite">
          <Orb phase={isPast() ? 'ended' : call.phase()} speaking={call.speaking()} level={call.level()} />

          <div class="text-center">
            <p class={`text-[17px] font-medium ${call.phase() === 'error' ? 'text-red' : ''}`}>{status()}</p>
            <Show when={!live()}>
              <p class="mt-1 text-[15px] text-muted">
                {modeLabel(mode())}, {topic()}
              </p>
            </Show>
          </div>

          <div class="flex items-center gap-3">
            <Switch>
              <Match when={live()}>
                <IconButton
                  label={call.muted() ? 'Unmute' : 'Mute'}
                  size="lg"
                  class={call.muted() ? '!bg-solid !text-solid-fg' : '!bg-soft !text-fg'}
                  aria-pressed={call.muted()}
                  onClick={call.toggleMute}
                >
                  {call.muted() ? <MicOff size={21} stroke-width={1.75} /> : <Mic size={21} stroke-width={1.75} />}
                </IconButton>
                <Button variant="danger" size="lg" onClick={() => call.finish()}>
                  <PhoneOff size={18} stroke-width={1.9} /> End call
                </Button>
              </Match>
              <Match when={isPast() || call.phase() === 'ended'}>
                <Button size="lg" onClick={again} disabled={!courseKey()}>
                  <PhoneCall size={18} stroke-width={1.9} /> {isPast() ? 'Call again' : 'New call'}
                </Button>
              </Match>
              <Match when={call.phase() === 'idle' || call.phase() === 'error'}>
                <Button size="lg" onClick={() => void start()}>
                  <PhoneCall size={18} stroke-width={1.9} /> {call.phase() === 'error' ? 'Try again' : 'Start call'}
                </Button>
              </Match>
            </Switch>
          </div>
          <Show when={call.phase() === 'idle' && !isPast()}>
            <p class="max-w-xs text-center text-[13px] text-muted">
              Your browser asks for the microphone. Headphones keep the tutor from hearing itself.
            </p>
          </Show>
        </section>

        {/* Recap and transcript */}
        <section class="scroll-quiet min-h-[50vh] overflow-y-auto bg-canvas/50 px-5 py-8 sm:px-8" aria-label="Transcript">
          <div class="mx-auto max-w-2xl">
            <Show when={recapHtml()}>
              <Card class="mb-8 p-6">
                <div class="mb-3 flex items-center gap-2 text-[13px] text-muted">
                  <Dot tone="ready" /> Recap
                </div>
                <div class="lecture" innerHTML={recapHtml()} />
              </Card>
            </Show>

            <ol class="space-y-3">
              <For
                each={turns.data() ?? []}
                fallback={
                  <li class="py-10 text-center text-[15px] text-muted">
                    {isPast() ? 'Nothing was said in this call.' : 'The conversation appears here as you talk.'}
                  </li>
                }
              >
                {(t) => {
                  const current = () => t.role === 'tutor' && t.seq === lastTutorSeq() && call.speaking();
                  return (
                    <li class={`flex ${t.role === 'student' ? 'justify-end' : 'justify-start'}`}>
                      <p
                        class={`max-w-[85%] rounded-[20px] px-4 py-2.5 text-[15px] leading-relaxed ${
                          t.role === 'student'
                            ? 'rounded-br-md bg-solid text-solid-fg'
                            : `rounded-bl-md border bg-surface ${current() ? 'border-blue/50 shadow-card' : 'border-line'}`
                        }`}
                      >
                        <span class="sr-only">{t.role === 'tutor' ? 'Tutor: ' : 'You: '}</span>
                        {t.text}
                      </p>
                    </li>
                  );
                }}
              </For>
            </ol>
            <div ref={transcriptEnd} />
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The call's presence. Speaking: a solid disc that swells with the tutor's
 * voice. Listening: a ring that follows the microphone. Idle: a quiet gray
 * circle.
 */
function Orb(props: { phase: string; speaking: boolean; level: number }) {
  const active = () => props.phase === 'live';
  const scale = () => (active() ? 1 + Math.min(props.level, 1) * 0.4 : 1);
  return (
    <div class="relative flex h-52 w-52 items-center justify-center" aria-hidden="true">
      <div
        class="absolute inset-4 rounded-full transition-[transform,background-color] duration-150 ease-out"
        classList={{
          'bg-solid': active() && props.speaking,
          'bg-soft': !(active() && props.speaking),
          'dot-breathe': props.phase === 'connecting',
        }}
        style={{ transform: `scale(${active() && props.speaking ? scale() : 1})` }}
      />
      <div
        class="absolute inset-4 rounded-full border-2 border-blue/60 transition-transform duration-100 ease-out"
        classList={{ hidden: !active() || props.speaking }}
        style={{ transform: `scale(${scale()})` }}
      />
      <PhoneCall
        size={34}
        stroke-width={1.6}
        class={`relative ${active() && props.speaking ? 'text-solid-fg' : props.phase === 'live' ? 'text-blue' : 'text-muted'}`}
      />
    </div>
  );
}
