import { A, useNavigate } from '@solidjs/router';
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ChevronDown, FileText, Folder, PhoneCall, Plus, TriangleAlert } from 'lucide-solid';
import type { schema } from '../schema.gen';
import type { CallMode } from '../lib/api';
import { useAuth } from '../lib/auth';
import { idKey, newId } from '../lib/ids';
import { MODES } from '../lib/modes';
import { courseColor } from '../lib/palette';
import { qAttention, qCourses, qMaterials } from '../lib/query';
import { Button, buttonClass, Card, greeting, NoticeCard, Segmented } from '../components/ui';

export default function Home() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const uid = () => auth.userId();
  const courses = useQuery(() => (uid() ? qCourses(db, uid()!) : null));
  const attention = useQuery(() => (uid() ? qAttention(db, uid()!) : null));
  const [dismissed, setDismissed] = createSignal<string[]>([]);

  const failed = () => (attention.data() ?? []).filter((m) => m.status === 'failed' && !dismissed().includes(m.id));
  const firstName = () => auth.user()?.name?.split(' ')[0];

  return (
    <div class="mx-auto w-full max-w-3xl px-4 pb-7 pt-6 sm:px-8 sm:pb-14 sm:pt-5">
      <h1 class="break-words text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]">
        {greeting()}
        <Show when={firstName()}>, {firstName()}</Show>
      </h1>
      <p class="mt-1.5 text-[16px] text-muted">Pick a lecture and call your tutor.</p>

      <Show when={(courses.data() ?? []).length > 0}>
        <CallComposer class="mt-8" />
      </Show>

      <Show when={failed().length > 0}>
        <div class="mt-6 space-y-3">
          <For each={failed()}>
            {(m) => (
              <NoticeCard
                icon={<TriangleAlert size={20} stroke-width={1.75} />}
                title={`${m.title} could not be processed`}
                description={m.error ?? 'Something went wrong while reading this material.'}
                tone="attention"
              >
                <A href={`/courses/${idKey(m.course)}/materials/${idKey(m.id)}`} class={buttonClass('solid')}>
                  Review
                </A>
                <A href={`/courses/${idKey(m.course)}`} class={buttonClass('soft')}>
                  Upload again
                </A>
                <Button variant="ghost" class="ml-auto" onClick={() => setDismissed([...dismissed(), m.id])}>
                  Dismiss
                </Button>
              </NoticeCard>
            )}
          </For>
        </div>
      </Show>

      <section class="mt-10" aria-label="Courses">
        <h2 class="mb-3 text-[13px] text-muted">Courses</h2>
        <div class="grid gap-3 sm:grid-cols-2">
          <For each={courses.data() ?? []}>
            {(c) => (
              <A href={`/courses/${idKey(c.id)}`} class="block min-w-0">
                <Card class="h-full min-w-0 p-5 transition-colors hover:border-line-strong">
                  <Folder size={22} stroke-width={1.6} style={{ color: courseColor(c.color) }} fill={courseColor(c.color)} fill-opacity="0.18" />
                  <h3 class="mt-4 truncate text-[16px] font-semibold">{c.title}</h3>
                  <p class="mt-1 line-clamp-2 text-[14px] text-muted">{c.description || 'Lecture material and calls'}</p>
                </Card>
              </A>
            )}
          </For>
          <CreateCourseCard />
        </div>
      </section>
    </div>
  );
}

/** The home screen's call starter: course, lecture, mode, call. */
function CallComposer(props: { class?: string }) {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const navigate = useNavigate();
  const courses = useQuery(() => (auth.userId() ? qCourses(db, auth.userId()!) : null));
  const [courseId, setCourseId] = createSignal('');
  const [materialKey, setMaterialKey] = createSignal('');
  const [mode, setMode] = createSignal<CallMode>('explain');

  createEffect(() => {
    const list = courses.data() ?? [];
    if (list.length && !list.some((c) => c.id === courseId())) setCourseId(list[0].id);
  });
  const materials = useQuery(() => (courseId() ? qMaterials(db, courseId()) : null));
  const ready = createMemo(() => (materials.data() ?? []).filter((m) => m.status === 'ready'));
  createEffect(() => {
    if (materialKey() && !ready().some((m) => idKey(m.id) === materialKey())) setMaterialKey('');
  });

  const course = () => (courses.data() ?? []).find((c) => c.id === courseId());
  const topic = () => ready().find((m) => idKey(m.id) === materialKey())?.title ?? course()?.title ?? '';
  const sentence = () =>
    ({ explain: `Walk me through ${topic()}`, quiz: `Quiz me on ${topic()}`, qa: `I have questions about ${topic()}` })[mode()];

  const call = () => {
    const q = new URLSearchParams({ mode: mode() });
    if (materialKey()) q.set('material', materialKey());
    navigate(`/courses/${idKey(courseId())}/call?${q}`);
  };

  return (
    <Card class={`p-3 ${props.class ?? ''}`}>
      <p class="break-words px-2 pb-5 pt-2 text-[17px] text-fg sm:px-3 sm:pb-6 sm:pt-3 sm:text-[18px]">{sentence()}</p>
      <div class="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <PillSelect
          class="w-full sm:w-auto"
          label="Course"
          icon={<Folder size={16} stroke-width={1.75} />}
          value={courseId()}
          onChange={setCourseId}
          options={(courses.data() ?? []).map((c) => ({ value: c.id, label: c.title }))}
        />
        <PillSelect
          class="w-full sm:w-auto"
          label="Lecture"
          icon={<FileText size={16} stroke-width={1.75} />}
          value={materialKey()}
          onChange={setMaterialKey}
          options={[{ value: '', label: 'Whole course' }, ...ready().map((m) => ({ value: idKey(m.id), label: m.title }))]}
        />
        <Segmented label="Kind of call" value={mode()} onChange={setMode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
        <button
          type="button"
          onClick={call}
          disabled={ready().length === 0}
          aria-label="Start call"
          title={ready().length === 0 ? 'Add material that is ready first' : 'Start call'}
          class="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-full bg-solid text-[14px] font-medium text-solid-fg transition-colors hover:bg-solid-hover disabled:opacity-30 sm:ml-auto sm:w-11"
        >
          <PhoneCall size={18} stroke-width={1.9} />
          <span class="sm:sr-only">Start call</span>
        </button>
      </div>
      <Show when={course() && ready().length === 0}>
        <p class="px-3 pt-3 text-[13px] text-muted">
          {course()?.title} has no material ready yet.{' '}
          <A href={`/courses/${idKey(courseId())}`} class="text-fg underline underline-offset-2">
            Add some
          </A>
        </p>
      </Show>
    </Card>
  );
}

/** A native select dressed as a pill. */
export function PillSelect(props: {
  label: string;
  icon: any;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  class?: string;
}) {
  return (
    <label class={`relative inline-flex h-11 min-w-0 max-w-full items-center gap-2 rounded-full border border-line bg-surface pl-3.5 pr-8 text-[14px] text-fg hover:bg-soft sm:h-10 sm:max-w-60 ${props.class ?? ''}`}>
      <span class="shrink-0 text-muted">{props.icon}</span>
      <span class="truncate">{props.options.find((o) => o.value === props.value)?.label ?? props.label}</span>
      <ChevronDown size={15} class="pointer-events-none absolute right-3 text-muted" />
      <select
        class="absolute inset-0 w-full cursor-pointer text-[16px] opacity-0"
        aria-label={props.label}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
      </select>
    </label>
  );
}

function CreateCourseCard() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const navigate = useNavigate();
  const [editing, setEditing] = createSignal(false);
  const [title, setTitle] = createSignal('');

  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    if (!auth.userId() || !title().trim()) return;
    const id = newId('course');
    await db.create(id, { owner: auth.userId()!, title: title().trim(), color: 'blue', language: 'en' });
    navigate(`/courses/${idKey(id)}`);
  };

  return (
    <Card class="p-5">
      <Show
        when={editing()}
        fallback={
          <button type="button" class="block w-full text-left" onClick={() => setEditing(true)}>
            <Plus size={24} stroke-width={1.5} class="text-muted" />
            <h3 class="mt-4 text-[16px] font-semibold">Create a course</h3>
            <p class="mt-1 text-[14px] text-muted">Slides, notes and scripts for one class</p>
          </button>
        }
      >
        <form onSubmit={create}>
          <Plus size={24} stroke-width={1.5} class="text-muted" />
          <input
            class="mt-4 w-full bg-transparent text-[16px] font-semibold outline-none placeholder:font-normal placeholder:text-faint"
            placeholder="Course name, e.g. Linear Algebra"
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
            aria-label="Course name"
            ref={(el) => queueMicrotask(() => el.focus())}
          />
          <div class="mt-3 flex gap-2">
            <Button type="submit" size="sm" disabled={!title().trim()}>
              Create
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Show>
    </Card>
  );
}
