import { createSignal, For, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ArrowUpRight, Check, Copy, KeyRound, MessageCircle, Sparkles } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { MCP_URL, createApiKey } from '../lib/api';
import { useAuth } from '../lib/auth';
import { qApiKeys } from '../lib/query';
import { Button, buttonClass, Card, Dot, formatDate, inputClass, NoticeCard } from '../components/ui';

/** API keys for AI clients that use the MCP server. */
export default function SettingsPage() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const keys = useQuery(() => (auth.userId() ? qApiKeys(db, auth.userId()!) : null));
  const [name, setName] = createSignal('');
  const [created, setCreated] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [chatgptSetup, setChatgptSetup] = createSignal(false);
  const [addressCopied, setAddressCopied] = createSignal(false);

  const mcpUrl = MCP_URL;
  const keyOrPlaceholder = () => created() ?? 'sc_YOUR_KEY';
  const claudeUrl = new URL('https://claude.ai/customize/connectors');
  claudeUrl.searchParams.set('modal', 'add-custom-connector');
  claudeUrl.searchParams.set('connectorName', 'TalkToBolo');
  claudeUrl.searchParams.set('connectorUrl', mcpUrl);

  const connectChatGPT = () => {
    setChatgptSetup(true);
    // Open during the click so browsers do not block the new tab while the
    // asynchronous clipboard operation is pending. The address is public.
    window.open('https://chatgpt.com/plugins', '_blank', 'noopener,noreferrer');
    void navigator.clipboard.writeText(mcpUrl).then(() => setAddressCopied(true)).catch(() => setAddressCopied(false));
  };

  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const owner = auth.userId();
      if (!owner) throw new Error('Sign in again to create a key.');
      const res = await createApiKey(db, owner, name().trim() || 'AI client');
      setCreated(res.key);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mx-auto w-full min-w-0 max-w-3xl px-4 py-7 sm:px-8 sm:py-14">
      <h1 class="text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]">AI access</h1>
      <p class="mt-1.5 max-w-2xl text-[16px] leading-relaxed text-muted">
        Let an assistant such as Claude work on your courses: create courses, add and edit lecture material, upload PDFs and search
        your notes, through TalkToBolo's MCP server.
      </p>

      <Card class="mt-6 p-4 sm:mt-8 sm:p-6">
        <h2 class="text-[18px] font-semibold tracking-tight">Bring your courses into the conversation</h2>
        <p class="mt-2 max-w-xl text-[14px] leading-relaxed text-muted">
          Connect your assistant, then sign in to TalkToBolo and approve access. No API key to copy.
        </p>
        <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button onClick={connectChatGPT}>
            <MessageCircle size={17} stroke-width={1.8} /> Connect ChatGPT <ArrowUpRight size={15} />
          </Button>
          <a class={buttonClass('soft')} href={claudeUrl.href} target="_blank" rel="noopener noreferrer">
            <Sparkles size={17} stroke-width={1.8} /> Connect Claude <ArrowUpRight size={15} />
          </a>
        </div>
        <p class="mt-3 text-[13px] leading-relaxed text-muted">
          Claude opens a prefilled connection. ChatGPT needs a short setup in its Plugins page.
        </p>
        <Show when={chatgptSetup()}>
          <div class="mt-5 rounded-2xl bg-soft p-4" role="region" aria-label="ChatGPT connection setup">
            <p class="text-[14px] font-medium" role="status">{addressCopied() ? 'Server address copied.' : 'Copy the server address below.'}</p>
            <ol class="mt-2 list-decimal space-y-1.5 pl-5 text-[14px] leading-relaxed text-muted">
              <li>In ChatGPT Plugins, choose the plus button, then Add custom MCP server.</li>
              <li>Name it TalkToBolo, paste the server address and choose OAuth.</li>
              <li>Create the plugin, connect your TalkToBolo account and install it.</li>
            </ol>
            <div class="mt-3"><CopyLine text={mcpUrl} /></div>
          </div>
        </Show>
      </Card>

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

      <Card class="mt-6 p-4 sm:mt-8 sm:p-5">
        <h2 class="text-[16px] font-semibold">API key for other clients</h2>
        <p class="mt-1 text-[14px] text-muted">Use this for Claude Code or a client that asks for a bearer token.</p>
        <form onSubmit={create} class="mt-3 flex flex-col gap-2 sm:flex-row">
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
          <p class="mt-3 break-words text-[14px] text-red" role="alert">{error()}</p>
        </Show>
      </Card>

      <Card class="mt-4 min-w-0 p-4 sm:p-5">
        <h2 class="text-[16px] font-semibold">Connect a client</h2>
        <p class="mt-1 text-[14px] text-muted">
          MCP over Streamable HTTP at <code class="break-all font-mono text-fg">{mcpUrl}</code>, with the key as a bearer token.
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
        <h2 class="px-3 pb-1 pt-3 text-[16px] font-semibold">Keys and connected apps</h2>
        <ul>
          <For each={keys.data() ?? []} fallback={<li class="px-3 py-4 text-[14px] text-muted">No keys or connections yet.</li>}>
            {(k) => (
              <li class="flex items-center gap-2 rounded-2xl px-2 py-2.5 hover:bg-soft sm:gap-3 sm:px-3">
                <Dot tone={k.revoked_at ? 'idle' : 'ready'} class="mx-1" />
                <div class="min-w-0 flex-1">
                  <span class="text-[15px] font-medium [overflow-wrap:anywhere]">{k.name}</span>
                  <span class="block font-mono text-[12px] text-faint sm:ml-2 sm:inline">{k.prefix}…</span>
                  <span class="block text-[13px] text-muted">
                    {k.revoked_at ? `Revoked ${formatDate(k.revoked_at)}` : `Created ${formatDate(k.created_at)}`}
                  </span>
                </div>
                <Show when={!k.revoked_at}>
                  <Button variant="soft" size="sm" class="shrink-0" onClick={() => db.update('api_key', k.id, { revoked_at: new Date().toISOString() })}>
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
    <div class="flex w-full min-w-0 items-start gap-2 rounded-2xl bg-soft p-2.5 sm:px-3.5">
      <pre class={`min-w-0 flex-1 self-center overflow-x-auto font-mono text-[12px] leading-relaxed ${props.multiline ? '' : 'whitespace-pre-wrap break-all'}`}>
        {props.text}
      </pre>
      <button
        type="button"
        class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg sm:h-9 sm:w-9"
        aria-label={copied() ? 'Copied' : 'Copy to clipboard'}
        title={copied() ? 'Copied' : 'Copy to clipboard'}
        onClick={async () => {
          await navigator.clipboard.writeText(props.text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Show when={copied()} fallback={<Copy size={16} stroke-width={1.75} />}>
          <Check size={17} stroke-width={1.75} class="text-green" />
        </Show>
      </button>
    </div>
  );
}
