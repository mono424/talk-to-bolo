import { A } from '@solidjs/router';
import { For, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import type { schema } from '../schema.gen';
import { useAuth } from '../lib/auth';
import { idKey } from '../lib/ids';
import { modeLabel, viaLabel } from '../lib/modes';
import { qRecentCalls } from '../lib/query';
import { Card, Dot, formatDate } from '../components/ui';

/** Every call, newest first. */
export default function CallsPage() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const calls = useQuery(() => (auth.userId() ? qRecentCalls(db, auth.userId()!, 100) : null));

  return (
    <div class="mx-auto w-full min-w-0 max-w-3xl px-4 pb-6 pt-6 sm:px-8 sm:pb-14 sm:pt-5">
      <h1 class="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">Calls</h1>
      <p class="mt-1.5 text-[15px] leading-relaxed text-muted sm:text-[16px]">
        Transcripts and recaps of your past calls, and the sessions your assistant saved.
      </p>

      <Card class="mt-6 p-1.5 sm:mt-8 sm:p-2">
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
                <A href={`/calls/${idKey(call.id)}`} class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-2xl px-3 py-3 hover:bg-soft sm:flex sm:gap-3">
                  <Dot tone={call.status === 'ended' ? 'idle' : 'running'} class="row-span-2 mx-0.5 sm:mx-1" />
                  <span class="min-w-0 flex-1">
                    <span class="line-clamp-2 text-[15px] font-medium [overflow-wrap:anywhere] sm:block sm:truncate">
                      {modeLabel(call.mode)}: {call.material?.title ?? 'Whole course'}{viaLabel(call.assistant)}
                    </span>
                    <span class="block truncate text-[13px] text-muted">
                      {call.course?.title}
                      <Show when={call.recap}>, recap ready</Show>
                    </span>
                  </span>
                  <span class="col-start-2 shrink-0 text-[12px] text-muted sm:text-[13px]">{formatDate(call.started_at, true)}</span>
                </A>
              </li>
            )}
          </For>
        </ul>
      </Card>
    </div>
  );
}
