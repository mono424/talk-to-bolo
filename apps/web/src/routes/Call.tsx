import { A, useNavigate, useParams, useSearchParams } from '@solidjs/router';
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ArrowLeft, Mic, MicOff, PhoneCall, PhoneOff } from 'lucide-solid';
import type { schema } from '../schema.gen';
import type { CallMode } from '../lib/api';
import { useTutorCall } from '../lib/call';
import { idKey } from '../lib/ids';
import { renderMarkdown } from '../lib/markdown';
import { courseColor } from '../lib/palette';
import { qCall, qCourse, qMaterial, qTurns } from '../lib/query';
import { Button, formatDate } from '../components/ui';
import { MODES } from './Course';

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
  const materialKey = () => (params.callKey ? (record.data()?.material ? idKey(record.data()!.material) : '') : String(search.material ?? ''));
  const mode = () => ((params.callKey ? record.data()?.mode : search.mode) ?? 'explain') as CallMode;

  const course = useQuery(() => (courseKey() ? qCourse(db, `course:${courseKey()}`) : null));
  const material = useQuery(() => (materialKey() ? qMaterial(db, `material:${materialKey()}`) : null));

  const isPast = () => !!params.callKey;
  const live = () => call.phase() === 'live' || call.phase() === 'connecting';
  const modeLabel = () => MODES.find((m) => m.value === mode())?.label ?? '';
  const topic = () => material.data()?.title ?? 'The whole course';

  const start = () =>
    call.start({ courseId: `course:${courseKey()}`, materialId: materialKey() ? `material:${materialKey()}` : null, mode: mode() });

  // Keep the newest line in view.
  let transcriptEnd: HTMLDivElement | undefined;
  createEffect(on(() => turns.data()?.length, () => transcriptEnd?.scrollIntoView({ behavior: 'smooth', block: 'end' })));

  const lastTutorSeq = createMemo(() => [...(turns.data() ?? [])].reverse().find((t) => t.role === 'tutor')?.seq);
  const recapHtml = createMemo(() => (record.data()?.recap ? renderMarkdown(record.data()!.recap!) : ''));

  return (
    <div class="min-h-screen flex flex-col">
      <div class="border-b border-rule px-6 sm:px-10 py-3 flex items-center gap-3" style={{ 'box-shadow': `inset 0 3px 0 0 ${courseColor(course.data()?.color)}` }}>
        <Show when={!live()}>
          <A href={courseKey() ? `/courses/${courseKey()}` : '/'} class="inline-flex items-center gap-1.5 text-sm text-pencil hover:text-graphite">
            <ArrowLeft size={16} /> {course.data()?.title ?? 'Course'}
          </A>
        </Show>
        <Show when={live()}>
          <span class="text-sm font-bold">{course.data()?.title}</span>
        </Show>
        <span class="ml-auto text-sm text-pencil truncate">
          {modeLabel()}: {topic()}
          <Show when={isPast() && record.data()?.started_at}>, {formatDate(record.data()!.started_at, true)}</Show>
        </span>
      </div>

      <div class="flex-1 grid lg:grid-cols-[minmax(18rem,26rem)_1fr]">
        {/* The call itself */}
        <section class="flex flex-col items-center justify-center gap-8 px-6 py-12 border-b lg:border-b-0 lg:border-r border-rule" aria-live="polite">
          <Orb phase={call.phase()} speaking={call.speaking()} level={call.level()} />

          <p class="text-center min-h-12">
            <Switch>
              <Match when={isPast()}>
                <span class="text-pencil">This call has ended.</span>
              </Match>
              <Match when={call.phase() === 'idle'}>
                <span class="block font-bold text-lg">{modeLabel()}</span>
                <span class="text-pencil">{topic()}</span>
              </Match>
              <Match when={call.phase() === 'connecting'}>
                <span class="text-pencil">Calling your tutor…</span>
              </Match>
              <Match when={call.phase() === 'live'}>
                <span class="font-bold">{call.speaking() ? 'Tutor is speaking' : call.muted() ? 'You are muted' : 'Listening'}</span>
              </Match>
              <Match when={call.phase() === 'ending'}>
                <span class="text-pencil">Hanging up and writing your recap…</span>
              </Match>
              <Match when={call.phase() === 'ended'}>
                <span class="text-pencil">Call ended.</span>
              </Match>
              <Match when={call.phase() === 'error'}>
                <span class="text-margin">{call.error()}</span>
              </Match>
            </Switch>
          </p>

          <div class="flex items-center gap-3">
            <Switch>
              <Match when={live()}>
                <button
                  type="button"
                  onClick={call.toggleMute}
                  aria-pressed={call.muted()}
                  aria-label={call.muted() ? 'Unmute' : 'Mute'}
                  class="h-14 w-14 rounded-full border border-rule bg-sheet flex items-center justify-center hover:bg-rule-soft"
                >
                  {call.muted() ? <MicOff size={22} /> : <Mic size={22} />}
                </button>
                <Button variant="danger" size="lg" onClick={() => call.finish()}>
                  <PhoneOff size={18} /> End call
                </Button>
              </Match>
              <Match when={isPast() || call.phase() === 'ended'}>
                <Button
                  variant="call"
                  size="lg"
                  onClick={() => navigate(`/courses/${courseKey()}/call?mode=${mode()}${materialKey() ? `&material=${materialKey()}` : ''}`, { replace: !isPast() })}
                  disabled={!courseKey()}
                >
                  <PhoneCall size={18} /> {isPast() ? 'Call again' : 'New call'}
                </Button>
              </Match>
              <Match when={call.phase() === 'idle' || call.phase() === 'error'}>
                <Button variant="call" size="lg" onClick={() => void start()}>
                  <PhoneCall size={18} /> {call.phase() === 'error' ? 'Try again' : 'Start call'}
                </Button>
              </Match>
            </Switch>
          </div>
          <Show when={call.phase() === 'idle'}>
            <p class="text-xs text-pencil text-center max-w-xs">Your browser asks for the microphone. Headphones keep the tutor from hearing itself.</p>
          </Show>
        </section>

        {/* Transcript and recap */}
        <section class="ruled min-h-[50vh] px-6 sm:px-10 py-8 overflow-y-auto" aria-label="Transcript">
          <Show when={recapHtml()}>
            <div class="rounded-xl border border-rule bg-sheet px-6 py-5 mb-8 max-w-[68ch]">
              <div class="lecture" innerHTML={recapHtml()} />
            </div>
          </Show>
          <div class="max-w-[68ch] font-serif text-[16px] leading-8">
            <For
              each={turns.data() ?? []}
              fallback={
                <p class="text-pencil font-sans text-sm">
                  {isPast() ? 'Nothing was said in this call.' : 'The conversation appears here as you talk.'}
                </p>
              }
            >
              {(t) => (
                <p class={t.role === 'tutor' ? 'text-ink' : 'text-graphite font-sans'}>
                  <span class="sr-only">{t.role === 'tutor' ? 'Tutor: ' : 'You: '}</span>
                  <Show when={t.role === 'student'}>
                    <span class="text-pencil text-sm mr-2" aria-hidden="true">
                      You
                    </span>
                  </Show>
                  <Show
                    when={t.role === 'tutor' && t.seq === lastTutorSeq() && call.speaking()}
                    fallback={t.text}
                  >
                    <mark class="highlight-sweep">{t.text}</mark>
                  </Show>
                </p>
              )}
            </For>
            <div ref={transcriptEnd} />
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The call's presence: a highlighter disc that swells with the tutor's voice,
 * and an ink ring that follows the student's microphone while it listens.
 */
function Orb(props: { phase: string; speaking: boolean; level: number }) {
  const active = () => props.phase === 'live';
  const scale = () => (active() ? 1 + Math.min(props.level, 1) * 0.45 : 1);
  return (
    <div class="relative h-56 w-56 flex items-center justify-center" aria-hidden="true">
      <div
        class="absolute inset-6 rounded-full transition-[transform,background-color,border-color] duration-150 ease-out"
        classList={{
          'bg-highlighter': active() && props.speaking,
          'border-4 border-ink': active() && !props.speaking,
          'bg-rule-soft': !active(),
          'animate-pulse': props.phase === 'connecting',
        }}
        style={{ transform: `scale(${props.speaking ? scale() : 1})` }}
      />
      <div
        class="absolute inset-12 rounded-full border-2 border-ink/40 transition-transform duration-100 ease-out"
        classList={{ hidden: !active() || props.speaking }}
        style={{ transform: `scale(${scale()})` }}
      />
      <PhoneCall size={36} class={active() && props.speaking ? 'relative text-highlighter-ink' : 'relative text-ink'} />
    </div>
  );
}
