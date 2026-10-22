import { A, useLocation, useNavigate, useParams, useSearchParams } from '@solidjs/router';
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ArrowDown, ArrowLeft, FileText, Mic, MicOff, PhoneCall, PhoneOff } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { materialPath, pageLabel, type CallMode } from '../lib/api';
import { freshCall, useTutorCall } from '../lib/call';
import { idKey } from '../lib/ids';
import { renderMarkdown } from '../lib/markdown';
import { modeLabel } from '../lib/modes';
import { firstRow, qCall, qCourse, qMaterial, qTurnSources, qTurns } from '../lib/query';
import { Button, buttonClass, Dot, formatDate, IconButton } from '../components/ui';

/** How close to the newest line still counts as reading along. */
const FOLLOW_SLACK = 48;

/**
 * A voice call with the tutor (/courses/:courseKey/call?mode=&material=), or a
 * past one (/calls/:callKey). The transcript is read from SurrealDB through a
 * live query: the API writes each turn as the call runs.
 */
export default function CallPage() {
  const location = useLocation();
  // The router keeps this page across navigations to the same route; a new
  // call (see freshCall) starts it over.
  return (
    <Show when={{ visit: location.state }} keyed>
      <CallScreen />
    </Show>
  );
}

function CallScreen() {
  const params = useParams();
  const [search] = useSearchParams();
  const db = useDb<typeof schema>();
  const navigate = useNavigate();
  const call = useTutorCall(db);

  // A past call by URL, or the one started on this page.
  const callId = () => (params.callKey ? `call:${params.callKey}` : call.callId());
  const record = firstRow(
    useQuery(() => {
      const id = callId();
      return id ? qCall(db, id) : null;
    }),
  );
  const turns = useQuery(() => {
    const id = callId();
    return id ? qTurns(db, id) : null;
  });
  const cited = useQuery(() => {
    const id = callId();
    return id ? qTurnSources(db, id) : null;
  });
  // Each tutor turn's citations, one link per material and page.
  const sourcesBySeq = createMemo(() => {
    const out = new Map<number, { key: string; href: string; title: string; where: string | null }[]>();
    for (const s of cited.data() ?? []) {
      const where = pageLabel(s.page, s.page_end) ?? s.heading ?? null;
      const key = `${s.material}:${where ?? ''}`;
      const list = out.get(s.seq) ?? [];
      if (list.some((l) => l.key === key)) continue;
      list.push({ key, href: materialPath(`course:${courseKey()}`, s.material, s.page), title: s.title, where });
      out.set(s.seq, list);
    }
    return out;
  });

  const courseKey = () => params.courseKey ?? (record.data()?.course ? idKey(record.data()!.course) : '');
  const materialKey = () =>
    params.callKey ? (record.data()?.material ? idKey(record.data()!.material) : '') : String(search.material ?? '');
  const mode = () => ((params.callKey ? record.data()?.mode : search.mode) ?? 'explain') as CallMode;

  const course = firstRow(useQuery(() => (courseKey() ? qCourse(db, `course:${courseKey()}`) : null)));
  const material = firstRow(useQuery(() => (materialKey() ? qMaterial(db, `material:${materialKey()}`) : null)));

  const isPast = () => !!params.callKey;
  const live = () => call.phase() === 'live' || call.phase() === 'connecting';
  const topic = () => material.data()?.title ?? course.data()?.title ?? '';

  const start = () =>
    call.start({ courseId: `course:${courseKey()}`, materialId: materialKey() ? `material:${materialKey()}` : null, mode: mode() });
  const again = () =>
    navigate(`/courses/${courseKey()}/call?mode=${mode()}${materialKey() ? `&material=${materialKey()}` : ''}`, { replace: !isPast(), ...freshCall() });

  const recapHtml = createMemo(() => (record.data()?.recap ? renderMarkdown(record.data()!.recap!) : ''));
  // Until something is said the call has the page to itself, centered.
  const hasTranscript = () => isPast() || !!recapHtml() || (turns.data()?.length ?? 0) > 0;

  // The transcript follows the conversation while the reader is at the newest
  // line. Scrolling up stops that until they come back down.
  let scroller: HTMLDivElement | undefined;
  let lastTop = 0;
  const [pinned, setPinned] = createSignal(true);
  const [edges, setEdges] = createSignal({ top: false, bottom: false });
  const following = () => !isPast() && pinned();

  const measure = () => {
    if (!scroller) return;
    const { scrollTop, scrollHeight, clientHeight } = scroller;
    const below = scrollHeight - scrollTop - clientHeight;
    if (below <= FOLLOW_SLACK) setPinned(true);
    else if (scrollTop < lastTop) setPinned(false);
    lastTop = scrollTop;
    setEdges({ top: scrollTop > 1, bottom: below > 1 });
  };
  // A hidden tab may not animate a smooth scroll, so it jumps.
  const toLatest = () =>
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: document.hidden ? 'instant' : 'smooth' });

  const attach = (el: HTMLDivElement) => {
    scroller = el;
    const catchUp = () => {
      if (following()) el.scrollTop = el.scrollHeight;
      measure();
    };
    // The call above shrinks once the transcript appears, and a tab in the
    // background misses lines: either way, land on the newest one.
    const resize = new ResizeObserver(catchUp);
    resize.observe(el);
    document.addEventListener('visibilitychange', catchUp);
    onCleanup(() => {
      resize.disconnect();
      document.removeEventListener('visibilitychange', catchUp);
      scroller = undefined;
    });
  };

  createEffect(
    on(
      () => {
        const list = turns.data() ?? [];
        return `${list.length}:${list.at(-1)?.text.length ?? 0}`;
      },
      () => {
        if (following()) toLatest();
        measure();
      },
    ),
  );
  // The recap is written after hanging up: bring it into view.
  createEffect(
    on(recapHtml, (html) => {
      if (html && !isPast()) scroller?.scrollTo({ top: 0, behavior: 'smooth' });
    }, { defer: true }),
  );

  // Lines fade out as the conversation pushes them up; reading back, only a
  // thin edge fades so nothing is hidden.
  const fade = () => ({
    '--fade-top': edges().top ? (live() && pinned() ? '45%' : '2.5rem') : '0px',
    '--fade-bottom': edges().bottom ? '2.5rem' : '0px',
  });

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
    <div class="flex h-full min-h-[18rem] min-w-0 flex-col">
      {/* On larger screens the sidebar leads back. */}
      <div class="flex h-12 shrink-0 items-center px-3 sm:h-14 sm:px-5 md:hidden">
        <Show when={!live()} fallback={<span class="max-w-full truncate px-2 text-[14px] text-muted">{course.data()?.title}</span>}>
          <A href={courseKey() ? `/courses/${courseKey()}` : '/'} class={`${buttonClass('ghost', 'sm')} max-w-full text-muted`}>
            <ArrowLeft size={16} stroke-width={1.75} class="shrink-0" />
            <span class="truncate">{course.data()?.title ?? 'Course'}</span>
          </A>
        </Show>
      </div>

      {/* The call */}
      <section
        class="call-presence call-center flex shrink-0 flex-col items-center justify-center gap-4 px-5 pb-6 transition-[flex-grow] duration-500 ease-out sm:gap-6 sm:pb-8 md:pt-10"
        style={{ 'flex-grow': hasTranscript() ? 0 : 1 }}
        aria-live="polite"
      >
        <Orb phase={isPast() ? 'ended' : call.phase()} speaking={call.speaking()} level={call.level()} compact={hasTranscript()} />

        <div class="max-w-md text-center [overflow-wrap:anywhere]">
          <p class={`text-[17px] font-medium ${call.phase() === 'error' ? 'text-red' : ''}`}>{status()}</p>
          <p class="mt-1 text-[14px] text-muted sm:text-[15px]">
            {modeLabel(mode())}
            <Show when={topic()}>, {topic()}</Show>
            <Show when={isPast() && record.data()?.started_at}>, {formatDate(record.data()!.started_at, true)}</Show>
          </p>
        </div>

        <div class="flex flex-wrap items-center justify-center gap-3">
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
      <Show when={hasTranscript()}>
        <div class="relative min-h-0 flex-1">
          <div
            ref={attach}
            onScroll={measure}
            class="transcript-fade scroll-quiet relative h-full overflow-y-auto overscroll-contain pb-8"
            style={fade()}
            aria-label="Transcript"
          >
            <div class="call-center px-4 sm:px-6">
              <div class="mx-auto min-w-0 max-w-2xl">
                <Show when={recapHtml()}>
                  <div class="mb-6 min-w-0 rounded-[20px] bg-soft p-4 sm:mb-8 sm:p-6">
                    <div class="mb-3 flex items-center gap-2 text-[13px] text-muted">
                      <Dot tone="ready" /> Recap
                    </div>
                    <div class="lecture" innerHTML={recapHtml()} />
                  </div>
                </Show>

                <ol class="space-y-3">
                  <For
                    each={turns.data() ?? []}
                    fallback={<li class="py-8 text-center text-[15px] text-muted">Nothing was said in this call.</li>}
                  >
                    {(t) => (
                      <li class={`flex flex-col ${t.role === 'student' ? 'items-end' : 'items-start'}`}>
                        <p
                          class={`min-w-0 max-w-[88%] rounded-[20px] px-4 py-2.5 text-[15px] leading-relaxed [overflow-wrap:anywhere] sm:max-w-[80%] ${
                            t.role === 'student' ? 'rounded-br-md bg-solid text-solid-fg' : 'rounded-bl-md bg-soft text-fg'
                          }`}
                        >
                          <span class="sr-only">{t.role === 'tutor' ? 'Tutor: ' : 'You: '}</span>
                          {t.text}
                        </p>
                        <Show when={t.role === 'tutor' && sourcesBySeq().get(t.seq)}>
                          {(sources) => (
                            <div class="mt-1.5 flex min-w-0 max-w-[88%] flex-wrap gap-1.5 sm:max-w-[80%]" aria-label="Sources">
                              <For each={sources()}>
                                {(s) => (
                                  <A
                                    href={s.href}
                                    class="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-soft hover:text-fg"
                                  >
                                    <FileText size={12} stroke-width={1.9} class="shrink-0" />
                                    <span class="truncate">{s.title}</span>
                                    <Show when={s.where}>
                                      <span class="max-w-[60%] shrink-0 truncate tabular-nums">· {s.where}</span>
                                    </Show>
                                  </A>
                                )}
                              </For>
                            </div>
                          )}
                        </Show>
                      </li>
                    )}
                  </For>
                </ol>
              </div>
            </div>
          </div>

          <Show when={live() && !pinned()}>
            <div class="call-center pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
              <button
                type="button"
                class={`${buttonClass('solid', 'sm')} pointer-events-auto shadow-card`}
                onClick={() => {
                  setPinned(true);
                  toLatest();
                }}
              >
                <ArrowDown size={15} stroke-width={1.9} /> Latest
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * The call's presence. Speaking: a solid disc that swells with the tutor's
 * voice. Listening: a ring that follows the microphone. Idle: a quiet gray
 * circle. Compact once the transcript needs the room.
 */
function Orb(props: { phase: string; speaking: boolean; level: number; compact: boolean }) {
  const active = () => props.phase === 'live';
  const scale = () => (active() ? 1 + Math.min(props.level, 1) * 0.4 : 1);
  return (
    <div
      class={`call-orb relative flex shrink-0 items-center justify-center transition-[width,height] duration-500 ease-out ${
        props.compact ? 'h-32 w-32 sm:h-44 sm:w-44' : 'h-44 w-44 sm:h-52 sm:w-52'
      }`}
      aria-hidden="true"
    >
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
