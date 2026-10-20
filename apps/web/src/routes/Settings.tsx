import { createSignal, For, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { Copy } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { API_URL, createApiKey } from '../lib/api';
import { useAuth } from '../lib/auth';
import { qApiKeys } from '../lib/query';
import { Button, Field, formatDate, inputClass } from '../components/ui';

/** API keys for AI clients that use the MCP server. */
export default function SettingsPage() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const keys = useQuery(() => {
    const uid = auth.userId();
    return uid ? qApiKeys(db, uid) : null;
  });
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
    <div class="px-6 sm:px-10 py-10 max-w-3xl">
      <h1 class="text-3xl font-bold leading-tight mb-3">AI access</h1>
      <p class="text-pencil leading-relaxed mb-10 max-w-2xl">
        Let an AI assistant such as Claude work on your courses: create courses, add and edit lecture material, upload PDFs and search
        your notes. It connects to Studycall's MCP server with a key you create here.
      </p>

      <section class="mb-10">
        <h2 class="text-lg font-bold mb-4">Create a key</h2>
        <form onSubmit={create} class="flex gap-2 max-w-lg">
          <Field label="Name" class="flex-1">
            <input class={inputClass} placeholder="e.g. Claude Desktop" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          </Field>
          <Button type="submit" class="self-end" disabled={busy()}>
            Create key
          </Button>
        </form>
        <Show when={error()}>
          <p class="text-sm text-margin mt-3">{error()}</p>
        </Show>
        <Show when={created()}>
          <div class="mt-5 rounded-xl border border-ink bg-sheet p-4">
            <p class="text-sm font-bold mb-2">Copy your key now. It is shown only once.</p>
            <CopyLine text={created()!} />
          </div>
        </Show>
      </section>

      <section class="mb-10">
        <h2 class="text-lg font-bold mb-2">Connect a client</h2>
        <p class="text-sm text-pencil mb-4">
          The server speaks MCP over Streamable HTTP at <code class="font-mono">{mcpUrl}</code>, with the key as a bearer token.
        </p>
        <p class="text-sm font-medium mb-1.5">Claude Code</p>
        <CopyLine text={`claude mcp add --transport http studycall ${mcpUrl} --header "Authorization: Bearer ${keyOrPlaceholder()}"`} />
        <p class="text-sm font-medium mt-5 mb-1.5">Any client with a JSON config</p>
        <CopyLine
          multiline
          text={JSON.stringify(
            { mcpServers: { studycall: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${keyOrPlaceholder()}` } } } },
            null,
            2,
          )}
        />
      </section>

      <section>
        <h2 class="text-lg font-bold mb-4">Your keys</h2>
        <ul class="rounded-xl border border-rule bg-sheet">
          <For each={keys.data() ?? []} fallback={<li class="px-4 py-6 text-sm text-pencil">No keys yet.</li>}>
            {(k) => (
              <li class="flex items-center gap-4 px-4 py-3 border-b border-rule-soft last:border-b-0">
                <div class="min-w-0 flex-1">
                  <span class="font-medium">{k.name}</span>
                  <span class="ml-3 font-mono text-xs text-pencil">{k.prefix}…</span>
                  <span class="block text-xs text-pencil mt-0.5">
                    {k.revoked_at ? `Revoked ${formatDate(k.revoked_at)}` : `Created ${formatDate(k.created_at)}`}
                  </span>
                </div>
                <Show when={!k.revoked_at}>
                  <Button variant="quiet" size="sm" onClick={() => db.update('api_key', k.id, { revoked_at: new Date().toISOString() })}>
                    Revoke
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>
    </div>
  );
}

function CopyLine(props: { text: string; multiline?: boolean }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="flex items-start gap-2 rounded-lg bg-rule-soft px-3 py-2">
      <pre class={`flex-1 font-mono text-xs leading-relaxed overflow-x-auto ${props.multiline ? '' : 'whitespace-pre-wrap break-all'}`}>
        {props.text}
      </pre>
      <button
        type="button"
        class="shrink-0 p-1.5 rounded-md text-pencil hover:text-graphite hover:bg-sheet"
        aria-label="Copy"
        onClick={async () => {
          await navigator.clipboard.writeText(props.text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Show when={copied()} fallback={<Copy size={14} />}>
          <span class="text-xs text-ok">Copied</span>
        </Show>
      </button>
    </div>
  );
}
