import { A } from '@solidjs/router';
import { For, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import type { schema } from '../schema.gen';
import { useAuth } from '../lib/auth';
import { idKey } from '../lib/ids';
import { modeLabel } from '../lib/modes';
import { qRecentCalls } from '../lib/query';
import { Card, Dot, formatDate } from '../components/ui';

/** Every call, newest first. */
export default function CallsPage() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const calls = useQuery(() => (auth.userId() ? qRecentCalls(db, auth.userId()!, 100) : null));

  return (
    <div class="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <h1 class="text-[30px] font-semibold leading-tight tracking-tight">Calls</h1>
      <p class="mt-1.5 text-[16px] text-muted">Transcripts and recaps of your past calls.</p>

      <Card class="mt-8 p-2">
        <ul>
          <For
            each={calls.data() ?? []}
            fallback={
              <li class="px-4 py-12 text-center text-[15px] text-muted">
                {calls.isLoading() ? '' : 'No calls yet. Start one from a course.'}
              </li>
            }
          >
            {(call) => (
              <li>
                <A href={`/calls/${idKey(call.id)}`} class="flex items-center gap-3 rounded-2xl px-3 py-3 hover:bg-soft">
                  <Dot tone={call.status === 'ended' ? 'idle' : 'running'} class="mx-1" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[15px] font-medium">
                      {modeLabel(call.mode)}: {call.material?.title ?? 'Whole course'}
                    </span>
                    <span class="block truncate text-[13px] text-muted">
                      {call.course?.title}
                      <Show when={call.recap}>, recap ready</Show>
                    </span>
                  </span>
                  <span class="shrink-0 text-[13px] text-muted">{formatDate(call.started_at, true)}</span>
                </A>
              </li>
            )}
          </For>
        </ul>
      </Card>
    </div>
  );
}
