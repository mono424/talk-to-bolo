import { A, useLocation, useNavigate } from '@solidjs/router';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ChevronsDown, ChevronsUp, Folder, House, PhoneCall, Plus } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { useAuth } from '../lib/auth';
import { idKey, newId } from '../lib/ids';
import { modeLabel } from '../lib/modes';
import { COURSE_COLORS, courseColor, type CourseColor } from '../lib/palette';
import { qAttention, qCourses, qRecentCalls } from '../lib/query';
import { Dot, materialTone, SectionLabel } from './ui';

const navClass = (active: boolean) =>
  `flex h-11 items-center gap-3 rounded-2xl px-3 text-[15px] transition-colors ${active ? 'bg-soft text-fg' : 'text-fg hover:bg-soft'}`;

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

  const [showAll, setShowAll] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [title, setTitle] = createSignal('');

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
        <div class="absolute inset-0 z-20 bg-black/20 md:hidden" onClick={props.onClose} />
      </Show>
      <aside
        class={`scroll-quiet absolute inset-y-0 left-0 z-30 w-[288px] shrink-0 overflow-y-auto bg-surface px-3 py-4 transition-transform md:static md:translate-x-0 ${
          props.open ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Navigation"
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
                class="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
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
          <section class="mt-7" aria-label="Recent calls">
            <SectionLabel>Recents</SectionLabel>
            <ul class="space-y-0.5">
              <For each={recents.data() ?? []}>
                {(call) => (
                  <li>
                    <A href={`/calls/${idKey(call.id)}`} class={navClass(location.pathname === `/calls/${idKey(call.id)}`)}>
                      <Dot tone={call.status === 'ended' ? 'idle' : 'running'} class="ml-1 mr-1" />
                      <span class="truncate">
                        {modeLabel(call.mode)}: {call.material?.title ?? call.course?.title ?? 'Course'}
                      </span>
                    </A>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </aside>
    </>
  );
}
