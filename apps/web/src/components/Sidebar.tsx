import { A, useLocation, useNavigate } from '@solidjs/router';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ArrowLeft, ChevronsDown, ChevronsUp, FileText, FileType2, Folder, House, PhoneCall, Plus } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { useAuth } from '../lib/auth';
import { idKey, newId } from '../lib/ids';
import { modeLabel, viaLabel } from '../lib/modes';
import { COURSE_COLORS, courseColor, type CourseColor } from '../lib/palette';
import { firstRow, qAttention, qCall, qCallHistory, qCourses, qMaterialsPage, qRecentCalls, useCourse } from '../lib/query';
import { freshCall } from '../lib/call';
import { Dot, materialTone, SectionLabel } from './ui';
import { SideSlot } from './HeaderSlot';
import { VirtualList } from './VirtualList';

const navClass = (active: boolean) =>
  `flex h-11 items-center gap-3 rounded-2xl px-3 text-[15px] transition-colors ${active ? 'bg-soft text-fg' : 'text-fg hover:bg-soft'}`;

/** The call screen: a new call on a course, or a past one. */
const CALL_PATH = /^\/(courses\/[^/]+\/call|calls\/[^/]+)\/?$/;
/** A lecture: /courses/<course>/materials/<material>. */
const MATERIAL_PATH = /^\/courses\/([^/]+)\/materials\/([^/]+)\/?$/;

/** Text for a material that is not ready, as the sidebar lists it. */
export const attentionText = (m: { title: string; status: string }) =>
  m.status === 'failed' ? `Fix ${m.title}` : m.status === 'processing' ? `Processing ${m.title}` : `Waiting: ${m.title}`;

export function Sidebar(props: { open: boolean; onClose: () => void }) {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const uid = () => auth.userId();
  const courses = useQuery(() => (uid() ? qCourses(db, uid()!) : null));
  const attention = useQuery(() => (uid() ? qAttention(db, uid()!) : null));
  const recents = useQuery(() => (uid() ? qRecentCalls(db, uid()!) : null));

  // On a call the sidebar is the way back and the course's call history; on a
  // lecture, the way back and the course's other material. Memos, so moving
  // between lectures keeps the same list.
  const onCall = createMemo(() => CALL_PATH.test(location.pathname));
  const onMaterial = createMemo(() => MATERIAL_PATH.test(location.pathname));

  const [showAll, setShowAll] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [title, setTitle] = createSignal('');

  createEffect(() => {
    if (!props.open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    onCleanup(() => document.removeEventListener('keydown', closeOnEscape));
  });

  // Failed first, then what is still running.
  const attentionItems = createMemo(() =>
    [...(attention.data() ?? [])].sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed')),
  );
  const visibleAttention = () => (showAll() ? attentionItems() : attentionItems().slice(0, 3));

  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    const t = title().trim();
    if (!uid() || !t) return;
    const colors = Object.keys(COURSE_COLORS) as CourseColor[];
    const id = newId('course');
    await db.create(id, { owner: uid()!, title: t, color: colors[(courses.data()?.length ?? 0) % colors.length], language: 'en' });
    setTitle('');
    setAdding(false);
    navigate(`/courses/${idKey(id)}`);
  };

  return (
    <>
      <Show when={props.open}>
        <button type="button" aria-label="Close navigation" tabindex="-1" class="absolute inset-0 z-20 bg-black/30 md:hidden" onClick={props.onClose} />
      </Show>
      <aside
        id="app-navigation"
        class={`scroll-quiet absolute inset-y-0 left-0 z-30 w-[288px] max-w-[calc(100%-3rem)] shrink-0 overflow-y-auto overscroll-contain rounded-r-2xl bg-surface px-3 py-4 shadow-card transition-[transform,visibility] md:visible md:static md:max-w-none md:translate-x-0 md:rounded-none md:shadow-none ${
          props.open ? 'visible translate-x-0' : 'invisible -translate-x-full'
        }`}
        aria-label="Navigation"
      >
        <Show
          when={!onCall() && !onMaterial()}
          fallback={
            onCall() ? (
              // Afresh per call, so its queries never switch in place (see perParam in App.tsx).
              <Show when={location.pathname} keyed>
                {(_path) => <CallNav />}
              </Show>
            ) : (
              <MaterialNav />
            )
          }
        >
          <nav class="space-y-0.5">
            <A href="/" class={navClass(location.pathname === '/')} end>
              <House size={19} stroke-width={1.6} class="text-muted" /> Home
            </A>
            <A href="/calls" class={navClass(location.pathname === '/calls' || location.pathname.startsWith('/calls/'))}>
              <PhoneCall size={19} stroke-width={1.6} class="shrink-0 text-muted" /> Calls
            </A>
            <Show
              when={adding()}
              fallback={
                <button type="button" class={`${navClass(false)} w-full`} onClick={() => setAdding(true)}>
                  <Plus size={19} stroke-width={1.6} class="text-muted" /> New course
                </button>
              }
            >
              <form onSubmit={create} class="flex h-11 items-center gap-3 rounded-2xl bg-soft px-3">
                <Plus size={19} stroke-width={1.6} class="shrink-0 text-muted" />
                <input
                  class="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint md:text-[15px]"
                  placeholder="Course name"
                  value={title()}
                  onInput={(e) => setTitle(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
                  onBlur={() => !title().trim() && setAdding(false)}
                  aria-label="Course name"
                  ref={(el) => queueMicrotask(() => el.focus())}
                />
              </form>
            </Show>
          </nav>

          <Show when={attentionItems().length > 0}>
            <div class="mt-5 overflow-hidden rounded-[18px] border border-line bg-surface shadow-card">
              <div class="p-1.5">
                <SectionLabel class="pt-2">Needs attention</SectionLabel>
                <ul>
                  <For each={visibleAttention()}>
                    {(m) => (
                      <li>
                        <A
                          href={`/courses/${idKey(m.course)}/materials/${idKey(m.id)}`}
                          class="flex h-11 items-center gap-3 rounded-2xl px-3 text-[15px] hover:bg-soft"
                          title={m.status === 'failed' ? (m.error ?? undefined) : (m.status_detail ?? undefined)}
                        >
                          <Dot tone={materialTone(m.status)} class="ml-1 mr-1" />
                          <span class="truncate">{attentionText(m)}</span>
                        </A>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
              <Show when={attentionItems().length > 3}>
                <button
                  type="button"
                  onClick={() => setShowAll(!showAll())}
                  class="flex h-11 w-full items-center gap-3 border-t border-line bg-soft/60 px-4 text-[15px] text-muted hover:text-fg"
                >
                  {showAll() ? <ChevronsUp size={17} stroke-width={1.75} /> : <ChevronsDown size={17} stroke-width={1.75} />}
                  {showAll() ? 'Show less' : 'Show more'}
                </button>
              </Show>
            </div>
          </Show>

          <section class="mt-7" aria-label="Courses">
            <SectionLabel>Courses</SectionLabel>
            <ul class="space-y-0.5">
              <For each={courses.data() ?? []} fallback={<li class="px-3 py-2 text-[14px] text-faint">No courses yet</li>}>
                {(c) => (
                  <li>
                    <A href={`/courses/${idKey(c.id)}`} class={navClass(location.pathname.startsWith(`/courses/${idKey(c.id)}`))}>
                      <Folder size={19} stroke-width={1.6} class="shrink-0" style={{ color: courseColor(c.color) }} fill={courseColor(c.color)} fill-opacity="0.18" />
                      <span class="truncate">{c.title}</span>
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </section>

          <Show when={(recents.data() ?? []).length > 0}>
            {/* Wide windows show these in their own column on the right. */}
            <section class="mt-7 xl:hidden" aria-label="Recent calls">
              <SectionLabel>Recents</SectionLabel>
              <ul class="space-y-0.5">
                <For each={recents.data() ?? []}>
                  {(call) => (
                    <li>
                      <A href={`/calls/${idKey(call.id)}`} class={navClass(location.pathname === `/calls/${idKey(call.id)}`)}>
                        <Dot tone={call.status === 'ended' ? 'idle' : 'running'} class="ml-1 mr-1" />
                        <span class="truncate">
                          {modeLabel(call.mode)}: {call.material?.title ?? call.course?.title ?? 'Course'}{viaLabel(call.assistant)}
                        </span>
                      </A>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </Show>
      </aside>
    </>
  );
}

/**
 * Recent calls in a column on the right of wide windows, as wide as the
 * sidebar so the page sits centred between them. A call keeps the room for
 * itself.
 */
export function RecentCalls() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const location = useLocation();
  const recents = useQuery(() => (auth.userId() ? qRecentCalls(db, auth.userId()!) : null));
  const shown = createMemo(() => !CALL_PATH.test(location.pathname));

  return (
    <Show when={shown()}>
      <aside class="scroll-quiet hidden w-[288px] shrink-0 overflow-y-auto overscroll-contain px-3 py-4 xl:block" aria-label="Recent calls">
        {/* Page controls, such as a lecture's reading place. */}
        <SideSlot class="mb-5 px-3 empty:hidden" />
        <h2 class="px-3 pb-1.5 text-[13px] text-faint">Recent calls</h2>
        <ul>
          <For each={recents.data() ?? []} fallback={<li class="px-3 py-2 text-[13px] text-faint">No calls yet</li>}>
            {(call) => (
              <li>
                <A
                  href={`/calls/${idKey(call.id)}`}
                  class={`flex h-9 items-center gap-2 rounded-xl px-3 text-[13px] transition-colors ${
                    location.pathname === `/calls/${idKey(call.id)}` ? 'bg-soft text-fg' : 'text-muted hover:bg-soft hover:text-fg'
                  }`}
                >
                  <Show when={call.status !== 'ended'}>
                    <Dot tone="running" />
                  </Show>
                  <span class="min-w-0 flex-1 truncate">
                    {modeLabel(call.mode)}: {call.material?.title ?? call.course?.title ?? 'Course'}{viaLabel(call.assistant)}
                  </span>
                  <span class="shrink-0 text-[12px] tabular-nums text-faint">{shortWhen(call.started_at)}</span>
                </A>
              </li>
            )}
          </For>
        </ul>
      </aside>
    </Show>
  );
}

// Whether the call history is open, remembered across pages and reloads.
const HISTORY_KEY = 'sidebar.history-open';
const [historyOpen, setHistoryOpen] = createSignal(readFlag(HISTORY_KEY, true));
const toggleHistory = () => {
  setHistoryOpen(!historyOpen());
  try {
    localStorage.setItem(HISTORY_KEY, String(historyOpen()));
  } catch {
    // Storage may be unavailable (private mode); the choice lasts this visit.
  }
};
function readFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
}

/** Today's calls by time, older ones by day. */
const shortWhen = (v: unknown) => {
  const d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** The sidebar on a call: back to the course, then its calls, newest first. */
function CallNav() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const pastKey = () => location.pathname.match(/^\/calls\/([^/]+)/)?.[1];
  const past = firstRow(useQuery(() => (pastKey() ? qCall(db, `call:${pastKey()}`) : null)));
  const courseKey = () =>
    location.pathname.match(/^\/courses\/([^/]+)\/call/)?.[1] ?? (past.data()?.course ? idKey(past.data()!.course) : '');
  const course = useCourse(db, auth.userId, () => (courseKey() ? `course:${courseKey()}` : null));
  const history = useQuery(() => (courseKey() ? qCallHistory(db, `course:${courseKey()}`) : null));

  // Same mode and lecture as the call on screen.
  const newCall = () => {
    if (!pastKey()) return `${location.pathname}${location.search}`;
    const call = past.data();
    const material = call?.material ? `&material=${idKey(call.material)}` : '';
    return `/courses/${courseKey()}/call?mode=${call?.mode ?? 'explain'}${material}`;
  };

  return (
    <>
      <nav class="space-y-0.5">
        <A href={courseKey() ? `/courses/${courseKey()}` : '/'} class={navClass(false)}>
          <ArrowLeft size={19} stroke-width={1.6} class="shrink-0 text-muted" />
          <span class="truncate">{course.data()?.title ?? 'Back'}</span>
        </A>
      </nav>

      <nav class="mt-6" aria-label="Calls">
        <A
          href={newCall()}
          class={`flex h-9 items-center rounded-xl px-3 text-[14px] transition-colors ${
            pastKey() ? 'text-muted hover:bg-soft hover:text-fg' : 'bg-soft text-fg'
          }`}
          onClick={(e) => {
            e.preventDefault();
            navigate(newCall(), freshCall());
          }}
        >
          New call
        </A>
      </nav>

      <section class="mt-3" aria-label="Call history">
        <h2 class="px-3 pb-1.5">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 text-[13px] text-muted transition-colors hover:text-fg"
            aria-expanded={historyOpen()}
            aria-controls="call-history"
            onClick={() => toggleHistory()}
          >
            History
            <svg viewBox="0 0 8 8" class={`h-2 w-2 transition-transform ${historyOpen() ? 'rotate-90' : ''}`} aria-hidden="true">
              <path d="M2 1l4 3-4 3z" fill="currentColor" />
            </svg>
          </button>
        </h2>
        <ul id="call-history" hidden={!historyOpen()}>
          <For each={history.data() ?? []} fallback={<li class="px-3 py-2 text-[14px] text-faint">No calls yet</li>}>
            {(call) => (
              <li>
                <A
                  href={`/calls/${idKey(call.id)}`}
                  class={`flex h-9 items-center gap-2 rounded-xl px-3 text-[14px] transition-colors ${
                    pastKey() === idKey(call.id) ? 'bg-soft text-fg' : 'text-muted hover:bg-soft hover:text-fg'
                  }`}
                >
                  <Show when={call.status !== 'ended'}>
                    <Dot tone="running" />
                  </Show>
                  <span class="min-w-0 flex-1 truncate">
                    {modeLabel(call.mode)}
                    <Show when={call.material?.title}>: {call.material!.title}</Show>
                    {viaLabel(call.assistant)}
                  </span>
                  <span class="shrink-0 text-[12px] tabular-nums text-faint">{shortWhen(call.started_at)}</span>
                </A>
              </li>
            )}
          </For>
        </ul>
      </section>
    </>
  );
}

/** The sidebar on a lecture: back to the course, then all of its material. */
function MaterialNav() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const location = useLocation();
  const keys = () => location.pathname.match(MATERIAL_PATH);
  const courseKey = createMemo(() => keys()?.[1] ?? '');
  const materialKey = () => keys()?.[2] ?? '';
  const course = useCourse(db, auth.userId, () => (courseKey() ? `course:${courseKey()}` : null));

  return (
    <div class="flex h-full min-h-0 flex-col">
      <nav class="space-y-0.5">
        <A href={courseKey() ? `/courses/${courseKey()}` : '/'} class={navClass(false)}>
          <ArrowLeft size={19} stroke-width={1.6} class="shrink-0 text-muted" />
          <span class="truncate">{course.data()?.title ?? 'Back'}</span>
        </A>
      </nav>

      <section class="mt-6 flex min-h-0 flex-1 flex-col" aria-labelledby="material-nav-title">
        <h2 id="material-nav-title" class="px-3 pb-1.5 text-[13px] text-muted">
          Lecture material
        </h2>
        {/* Windowed and virtualized, like the course page's list. */}
        <Show when={courseKey()} keyed>
          {(key) => (
            <VirtualList
              class="scroll-quiet min-h-0 flex-1"
              aria-label="Lecture material"
              window={(page, size) => useQuery(() => qMaterialsPage(db, `course:${key}`, page, size), { deregisterOnCleanup: true })}
              estimateSize={38}
              key={(m) => m.id}
              empty={<p class="px-3 py-2 text-[14px] text-faint">No material yet</p>}
            >
              {(m) => (
                <div class="pb-0.5">
                  <A
                    href={`/courses/${key}/materials/${idKey(m().id)}`}
                    class={`flex h-9 items-center gap-2.5 rounded-xl px-3 text-[14px] transition-colors ${
                      materialKey() === idKey(m().id) ? 'bg-soft text-fg' : 'text-muted hover:bg-soft hover:text-fg'
                    }`}
                    aria-current={materialKey() === idKey(m().id) ? 'page' : undefined}
                  >
                    {m().kind === 'pdf' ? (
                      <FileType2 size={16} stroke-width={1.6} class="shrink-0" />
                    ) : (
                      <FileText size={16} stroke-width={1.6} class="shrink-0" />
                    )}
                    <span class="min-w-0 flex-1 truncate">{m().title}</span>
                    <Show when={m().status !== 'ready'}>
                      <Dot tone={materialTone(m().status)} />
                    </Show>
                  </A>
                </div>
              )}
            </VirtualList>
          )}
        </Show>
      </section>
    </div>
  );
}
