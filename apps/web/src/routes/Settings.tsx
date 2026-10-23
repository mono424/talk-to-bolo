import { createSignal, For, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ArrowUpRight, AudioLines, Check, Copy, MessageCircle } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { MCP_URL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { qApiKeys } from '../lib/query';
import { Button, Card, Dot, formatDate } from '../components/ui';

/** What to say to ChatGPT voice once TalkToBolo is connected. */
const VOICE_PROMPTS = [
  'What should I study today on TalkToBolo?',
  'Continue my lecture where I left off.',
  'Quiz me on what I have covered so far.',
  'Save this session to TalkToBolo.',
];

/** Connecting ChatGPT to the MCP server, and the connections made so far. */
export default function SettingsPage() {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const keys = useQuery(() => (auth.userId() ? qApiKeys(db, auth.userId()!) : null));
  const [chatgptSetup, setChatgptSetup] = createSignal(false);
  const [addressCopied, setAddressCopied] = createSignal(false);

  const mcpUrl = MCP_URL;

  const connectChatGPT = () => {
    setChatgptSetup(true);
    // Open during the click so browsers do not block the new tab while the
    // asynchronous clipboard operation is pending. The address is public.
    window.open('https://chatgpt.com/plugins', '_blank', 'noopener,noreferrer');
    void navigator.clipboard.writeText(mcpUrl).then(() => setAddressCopied(true)).catch(() => setAddressCopied(false));
  };

  return (
    <div class="mx-auto w-full min-w-0 max-w-3xl px-4 py-7 sm:px-8 sm:py-14">
      <h1 class="text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]">ChatGPT</h1>
      <p class="mt-1.5 max-w-2xl text-[16px] leading-relaxed text-muted">
        Study with ChatGPT from your own courses: it reads your lectures, progress and past sessions, quizzes you and saves what
        you covered. It can also create courses, add material and upload PDFs, through TalkToBolo's MCP server.
      </p>

      <Card class="mt-6 p-4 sm:mt-8 sm:p-6">
        <h2 class="text-[18px] font-semibold tracking-tight">Bring your courses into the conversation</h2>
        <p class="mt-2 max-w-xl text-[14px] leading-relaxed text-muted">
          Connect ChatGPT, then sign in to TalkToBolo and approve access. No API key to copy.
        </p>
        <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button onClick={connectChatGPT}>
            <MessageCircle size={17} stroke-width={1.8} /> Connect ChatGPT <ArrowUpRight size={15} />
          </Button>
        </div>
        <p class="mt-3 text-[13px] leading-relaxed text-muted">
          ChatGPT needs a short setup in its Plugins page, once, in a browser.
        </p>
        <Show when={chatgptSetup()}>
          <div class="mt-5 rounded-2xl bg-soft p-4" role="region" aria-label="ChatGPT connection setup">
            <p class="text-[14px] font-medium" role="status">{addressCopied() ? 'Server address copied.' : 'Copy the server address below.'}</p>
            <ol class="mt-2 list-decimal space-y-1.5 pl-5 text-[14px] leading-relaxed text-muted">
              <li>In ChatGPT Plugins, choose the plus button, then Add custom MCP server.</li>
              <li>Name it TalkToBolo, paste the server address and choose OAuth.</li>
              <li>Create the plugin, connect your TalkToBolo account and approve access.</li>
              <li>That is it: TalkToBolo is now in the ChatGPT app on your phone too.</li>
            </ol>
            <div class="mt-3"><CopyLine text={mcpUrl} /></div>
            <p class="mt-3 text-[13px] leading-relaxed text-muted">
              Custom MCP servers depend on your ChatGPT plan, and a workspace admin may need to allow them.
            </p>
          </div>
        </Show>
      </Card>

      <Card class="mt-4 p-4 sm:p-6">
        <div class="flex items-center gap-3">
          <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-soft text-muted">
            <AudioLines size={20} stroke-width={1.7} />
          </span>
          <h2 class="text-[18px] font-semibold tracking-tight">Learn on the go with ChatGPT voice</h2>
        </div>
        <p class="mt-3 max-w-xl text-[14px] leading-relaxed text-muted">
          Once connected, open ChatGPT on your phone, start Voice and ask for your course. It picks up where you left off in each
          lecture, sticks to the sections you have reached, and cites the lecture page.
        </p>
        <ul class="mt-4 flex flex-col gap-2" aria-label="Things to say">
          <For each={VOICE_PROMPTS}>
            {(prompt) => <li class="rounded-2xl bg-soft px-3.5 py-2.5 text-[14px] [overflow-wrap:anywhere]">"{prompt}"</li>}
          </For>
        </ul>
        <p class="mt-4 max-w-xl text-[13px] leading-relaxed text-muted">
          Reading your notes runs without asking when ChatGPT's plugin permissions allow read actions. Saving a session and your
          progress asks you on screen first; saved sessions appear under Sessions with their recap.
        </p>
      </Card>

      <Card class="mt-6 p-2 sm:mt-8">
        <h2 class="px-3 pb-1 pt-3 text-[16px] font-semibold">Connections</h2>
        <ul>
          <For each={keys.data() ?? []} fallback={<li class="px-3 py-4 text-[14px] text-muted">No connections yet.</li>}>
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

function CopyLine(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="flex w-full min-w-0 items-start gap-2 rounded-2xl bg-soft p-2.5 sm:px-3.5">
      <pre class="min-w-0 flex-1 self-center overflow-x-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed">
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
