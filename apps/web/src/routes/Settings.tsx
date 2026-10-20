import { createSignal, For, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { Copy, KeyRound } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { API_URL, createApiKey } from '../lib/api';
import { useAuth } from '../lib/auth';
import { qApiKeys } from '../lib/query';
import { Button, Card, Dot, formatDate, inputClass, NoticeCard } from '../components/ui';

/** API keys for AI clients that use the MCP server. */
export default function SettingsPage() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const keys = useQuery(() => (auth.userId() ? qApiKeys(db, auth.userId()!) : null));
  const [name, setName] = createSignal('');
  const [created, setCreated] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const mcpUrl = `${API_URL}/mcp`;
  const keyOrPlaceholder = () => created() ?? 'sc_YOUR_KEY';

  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await createApiKey(db, name().trim() || 'AI client');
      setCreated(res.key);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <h1 class="text-[30px] font-semibold leading-tight tracking-tight">AI access</h1>
      <p class="mt-1.5 max-w-2xl text-[16px] leading-relaxed text-muted">
        Let an assistant such as Claude work on your courses: create courses, add and edit lecture material, upload PDFs and search
        your notes, through TalkToBolo's MCP server.
      </p>

      <Show when={created()}>
        <NoticeCard
          class="mt-8"
          icon={<KeyRound size={20} stroke-width={1.75} />}
          title="Copy your new key"
          description="It is shown only this once. Put it in your AI client now."
          tone="attention"
        >
          <div class="w-full">
            <CopyLine text={created()!} />
          </div>
        </NoticeCard>
      </Show>

      <Card class="mt-8 p-5">
        <h2 class="text-[16px] font-semibold">Create a key</h2>
        <form onSubmit={create} class="mt-3 flex flex-wrap gap-2">
          <input
            class={`${inputClass} min-w-0 flex-1`}
            placeholder="Name it after the client, e.g. Claude Desktop"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            aria-label="Key name"
          />
          <Button type="submit" disabled={busy()}>
            Create key
          </Button>
        </form>
        <Show when={error()}>
          <p class="mt-3 text-[14px] text-red">{error()}</p>
        </Show>
      </Card>

      <Card class="mt-4 p-5">
        <h2 class="text-[16px] font-semibold">Connect a client</h2>
        <p class="mt-1 text-[14px] text-muted">
          MCP over Streamable HTTP at <code class="font-mono text-fg">{mcpUrl}</code>, with the key as a bearer token.
        </p>
        <p class="mb-1.5 mt-4 text-[13px] text-muted">Claude Code</p>
        <CopyLine text={`claude mcp add --transport http talktobolo ${mcpUrl} --header "Authorization: Bearer ${keyOrPlaceholder()}"`} />
        <p class="mb-1.5 mt-4 text-[13px] text-muted">Clients with a JSON config</p>
        <CopyLine
          multiline
          text={JSON.stringify(
            { mcpServers: { talktobolo: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${keyOrPlaceholder()}` } } } },
            null,
            2,
          )}
        />
      </Card>

      <Card class="mt-4 p-2">
        <h2 class="px-3 pb-1 pt-3 text-[16px] font-semibold">Your keys</h2>
        <ul>
          <For each={keys.data() ?? []} fallback={<li class="px-3 py-4 text-[14px] text-muted">No keys yet.</li>}>
            {(k) => (
              <li class="flex items-center gap-3 rounded-2xl px-3 py-2.5 hover:bg-soft">
                <Dot tone={k.revoked_at ? 'idle' : 'ready'} class="mx-1" />
                <div class="min-w-0 flex-1">
                  <span class="text-[15px] font-medium">{k.name}</span>
                  <span class="ml-2 font-mono text-[12px] text-faint">{k.prefix}…</span>
                  <span class="block text-[13px] text-muted">
                    {k.revoked_at ? `Revoked ${formatDate(k.revoked_at)}` : `Created ${formatDate(k.created_at)}`}
                  </span>
                </div>
                <Show when={!k.revoked_at}>
                  <Button variant="soft" size="sm" onClick={() => db.update('api_key', k.id, { revoked_at: new Date().toISOString() })}>
                    Revoke
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Card>
    </div>
  );
}

function CopyLine(props: { text: string; multiline?: boolean }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="flex items-start gap-2 rounded-2xl bg-soft px-3.5 py-2.5">
      <pre class={`flex-1 overflow-x-auto font-mono text-[12px] leading-relaxed ${props.multiline ? '' : 'whitespace-pre-wrap break-all'}`}>
        {props.text}
      </pre>
      <button
        type="button"
        class="shrink-0 rounded-full p-1.5 text-muted hover:bg-surface hover:text-fg"
        aria-label="Copy"
        onClick={async () => {
          await navigator.clipboard.writeText(props.text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Show when={copied()} fallback={<Copy size={14} stroke-width={1.75} />}>
          <span class="text-[12px] text-green">Copied</span>
        </Show>
      </button>
    </div>
  );
}
