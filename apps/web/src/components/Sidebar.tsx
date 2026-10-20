import { A, useNavigate } from '@solidjs/router';
import { createSignal, For, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { KeyRound, LogOut, Plus } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { useAuth } from '../lib/auth';
import { idKey, newId } from '../lib/ids';
import { COURSE_COLORS, courseColor, type CourseColor } from '../lib/palette';
import { qCourses } from '../lib/query';
import { inputClass } from './ui';

export function Sidebar() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const navigate = useNavigate();
  const courses = useQuery(() => {
    const uid = auth.userId();
    return uid ? qCourses(db, uid) : null;
  });
  const [adding, setAdding] = createSignal(false);
  const [title, setTitle] = createSignal('');

  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    const uid = auth.userId();
    const t = title().trim();
    if (!uid || !t) return;
    const colors = Object.keys(COURSE_COLORS) as CourseColor[];
    const id = newId('course');
    await db.create(id, {
      owner: uid,
      title: t,
      color: colors[(courses.data()?.length ?? 0) % colors.length],
      language: 'en',
    });
    setTitle('');
    setAdding(false);
    navigate(`/courses/${idKey(id)}`);
  };

  return (
    <aside class="border-b md:border-b-0 md:border-r border-rule bg-sheet/60 md:min-h-screen md:sticky md:top-0 md:h-screen flex flex-col">
      <div class="px-5 pt-5 pb-3 flex items-center justify-between">
        <A href="/" class="font-bold text-ink text-lg">
          Studycall
        </A>
      </div>

      <nav class="flex-1 overflow-y-auto px-3 pb-3" aria-label="Courses">
        <ul class="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible">
          <For each={courses.data() ?? []}>
            {(course) => (
              <li class="shrink-0">
                <A
                  href={`/courses/${idKey(course.id)}`}
                  class="group flex items-center gap-3 rounded-r-lg pl-3 pr-3 py-2 text-[15px] hover:bg-rule-soft"
                  activeClass="bg-rule-soft font-bold"
                  end={false}
                  style={{ 'box-shadow': `inset 4px 0 0 0 ${courseColor(course.color)}` }}
                >
                  <span class="truncate">{course.title}</span>
                </A>
              </li>
            )}
          </For>
          <li class="shrink-0">
            <Show
              when={adding()}
              fallback={
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  class="flex items-center gap-2 rounded-lg px-3 py-2 text-[15px] text-pencil hover:text-graphite hover:bg-rule-soft w-full"
                >
                  <Plus size={16} /> New course
                </button>
              }
            >
              <form onSubmit={create} class="px-1 py-1">
                <input
                  class={inputClass}
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
          </li>
        </ul>
      </nav>

      <div class="border-t border-rule px-3 py-3 flex md:flex-col gap-1 text-sm">
        <A href="/settings" class="flex items-center gap-2 rounded-lg px-3 py-2 text-pencil hover:text-graphite hover:bg-rule-soft" activeClass="text-graphite bg-rule-soft">
          <KeyRound size={16} /> AI access
        </A>
        <button
          type="button"
          onClick={() => auth.signOut()}
          class="flex items-center gap-2 rounded-lg px-3 py-2 text-pencil hover:text-graphite hover:bg-rule-soft text-left"
        >
          <LogOut size={16} /> Sign out
          <Show when={auth.user()?.name}>
            <span class="ml-auto truncate text-xs">{auth.user()?.name}</span>
          </Show>
        </button>
      </div>
    </aside>
  );
}
