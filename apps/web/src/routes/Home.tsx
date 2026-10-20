import { Navigate, useNavigate } from '@solidjs/router';
import { createSignal, Match, Switch } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import type { schema } from '../schema.gen';
import { useAuth } from '../lib/auth';
import { idKey, newId } from '../lib/ids';
import { qCourses } from '../lib/query';
import { Button, inputClass } from '../components/ui';

/** Opens the first course, or helps create one. */
export default function Home() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const navigate = useNavigate();
  const courses = useQuery(() => {
    const uid = auth.userId();
    return uid ? qCourses(db, uid) : null;
  });
  const [title, setTitle] = createSignal('');

  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    const uid = auth.userId();
    if (!uid || !title().trim()) return;
    const id = newId('course');
    await db.create(id, { owner: uid, title: title().trim(), color: 'blue', language: 'en' });
    navigate(`/courses/${idKey(id)}`);
  };

  return (
    <Switch>
      <Match when={(courses.data()?.length ?? 0) > 0}>
        <Navigate href={`/courses/${idKey(courses.data()![0].id)}`} />
      </Match>
      <Match when={!courses.isLoading()}>
        <div class="ruled min-h-[70vh] px-6 sm:px-12 py-16 margin-line">
          <div class="max-w-lg pl-4">
            <h1 class="text-3xl font-bold leading-tight mb-3">Start with a course</h1>
            <p class="text-pencil leading-relaxed mb-8">
              A course holds the lecture material the tutor teaches from: slides as PDF, notes, scripts. Name it after the
              class you are studying for.
            </p>
            <form onSubmit={create} class="flex gap-2">
              <input
                class={inputClass}
                placeholder="e.g. Linear Algebra"
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
                aria-label="Course name"
              />
              <Button type="submit" disabled={!title().trim()}>
                Create course
              </Button>
            </form>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
