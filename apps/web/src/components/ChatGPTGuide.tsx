import { useLocation } from '@solidjs/router';
import { createContext, createEffect, createSignal, For, onCleanup, onMount, Show, useContext, type JSX } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ArrowUpRight, Check, Copy, X } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { MCP_URL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { qApiKeys } from '../lib/query';
import { Button, Dot } from './ui';

const PLUGINS_URL = 'https://chatgpt.com/plugins';

/** What ChatGPT's "Add custom MCP server" form asks for. */
const PLUGIN_NAME = 'TalkToBolo';
const PLUGIN_DESCRIPTION = 'Study from my TalkToBolo courses: lectures, progress and past study sessions.';

/** What to say to ChatGPT once TalkToBolo is connected. */
export const VOICE_PROMPTS = [
  'What should I study today on TalkToBolo?',
  'Continue my lecture where I left off.',
  'Quiz me on what I have covered so far.',
  'Save this session to TalkToBolo.',
];

interface GuideContext {
  open: () => void;
  /** An unrevoked connection exists. A ChatGPT connection is an `api_key` row. */
  connected: () => boolean;
}

const Ctx = createContext<GuideContext>();

export const useChatGPTGuide = () => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useChatGPTGuide outside ChatGPTGuideProvider');
  return ctx;
};

/**
 * The step by step guide to connecting ChatGPT, as a dialog any page can open.
 * It opens by itself once per account and browser until ChatGPT is connected.
 */
export function ChatGPTGuideProvider(props: { children: JSX.Element }) {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const location = useLocation();
  const keys = useQuery(() => (auth.userId() ? qApiKeys(db, auth.userId()!) : null));
  const connected = () => (keys.data() ?? []).some((k) => !k.revoked_at);
  const [isOpen, setOpen] = createSignal(false);

  const seenKey = () => `talktobolo:chatgpt-guide-seen:${auth.userId()}`;
  const seen = () => {
    try {
      return localStorage.getItem(seenKey()) === '1';
    } catch {
      return true;
    }
  };
  const markSeen = () => {
    try {
      localStorage.setItem(seenKey(), '1');
    } catch {
      // Private mode: the guide may open again next time, which is fine.
    }
  };

  // Wait a moment before opening by itself: on a new device the connections
  // arrive from the server shortly after the local store answers empty. Never
  // over the OAuth approval page, which is part of connecting.
  createEffect(() => {
    if (!keys.data() || connected() || isOpen() || seen() || location.pathname === '/connect') return;
    const timer = setTimeout(() => {
      if (!connected() && !seen() && location.pathname !== '/connect') setOpen(true);
    }, 1500);
    onCleanup(() => clearTimeout(timer));
  });

  const close = () => {
    markSeen();
    setOpen(false);
  };

  return (
    <Ctx.Provider value={{ open: () => setOpen(true), connected }}>
      {props.children}
      <Show when={isOpen()}>
        <GuideDialog connected={connected()} onClose={close} />
      </Show>
    </Ctx.Provider>
  );
}

function GuideDialog(props: { connected: boolean; onClose: () => void }) {
  let dialog!: HTMLDialogElement;
  const [urlCopied, setUrlCopied] = createSignal(false);

  onMount(() => dialog.showModal());

  const openChatGPT = () => {
    // Open during the click so browsers do not block the new tab while the
    // asynchronous clipboard operation is pending. The address is public.
    window.open(PLUGINS_URL, '_blank', 'noopener,noreferrer');
    void navigator.clipboard.writeText(MCP_URL).then(() => setUrlCopied(true)).catch(() => setUrlCopied(false));
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="chatgpt-guide-title"
      class="m-auto max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-xl overflow-y-auto overscroll-contain rounded-[22px] border border-line bg-surface p-0 text-fg shadow-frame backdrop:bg-black/40 sm:max-h-[calc(100dvh-4rem)]"
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={(e) => e.target === dialog && props.onClose()}
    >
      <div class="p-5 sm:p-7">
        <div class="flex items-start gap-3">
          <img src="/studycall-logo.svg" alt="" class="h-11 w-9 shrink-0" />
          <div class="min-w-0 flex-1">
            <h2 id="chatgpt-guide-title" class="text-[20px] font-semibold leading-tight tracking-tight sm:text-[22px]">
              Connect TalkToBolo to ChatGPT
            </h2>
            <p class="mt-1 text-[14px] leading-relaxed text-muted">
              About two minutes, once, in a browser. Then study your courses by voice in ChatGPT, on your phone too.
            </p>
          </div>
          <button
            type="button"
            class="-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-soft hover:text-fg"
            aria-label="Close"
            onClick={props.onClose}
          >
            <X size={20} stroke-width={1.75} />
          </button>
        </div>

        <div class="mt-5 flex items-center gap-2.5 rounded-2xl bg-soft px-3.5 py-2.5 text-[14px]" role="status">
          <Show
            when={props.connected}
            fallback={
              <>
                <Dot tone="running" />
                <span class="text-muted">Not connected yet. This updates by itself once you approve access.</span>
              </>
            }
          >
            <Dot tone="ready" />
            <span class="font-medium">ChatGPT is connected. Jump to the last step to start studying.</span>
          </Show>
        </div>

        <ol class="mt-6 space-y-6">
          <Step n={1} title="Open ChatGPT Plugins" done={props.connected}>
            <p>Sign in to ChatGPT if it asks. The button also copies the server address you need in step 3.</p>
            <div class="mt-3 flex flex-wrap items-center gap-3">
              <Button onClick={openChatGPT}>
                Open ChatGPT Plugins <ArrowUpRight size={15} />
              </Button>
              <Show when={urlCopied()}>
                <span class="inline-flex items-center gap-1.5 text-[13px] text-muted">
                  <Check size={15} class="text-green" /> Server address copied
                </span>
              </Show>
            </div>
          </Step>

          <Step n={2} title="Add a custom MCP server" done={props.connected}>
            <p>
              Choose the <Kbd>+</Kbd> button, then <Kbd>Add custom MCP server</Kbd>.
            </p>
          </Step>

          <Step n={3} title="Fill in the form" done={props.connected}>
            <div class="mt-1 space-y-2.5">
              <CopyField label="Name" text={PLUGIN_NAME} />
              <CopyField label="Description" text={PLUGIN_DESCRIPTION} />
              <CopyField label="Server URL" text={MCP_URL} mono />
              <div class="flex items-center justify-between gap-3 rounded-2xl border border-line px-3.5 py-2.5">
                <span class="text-[13px] text-muted">Authentication</span>
                <span class="text-[14px] font-medium">OAuth</span>
              </div>
            </div>
          </Step>

          <Step n={4} title="Create the plugin" done={props.connected}>
            <p>
              Read the warning and choose <Kbd>I understand and want to continue</Kbd>, then <Kbd>Create as a plugin</Kbd>.
            </p>
          </Step>

          <Step n={5} title="Install and approve access" done={props.connected}>
            <p>
              Install the plugin. ChatGPT sends you to TalkToBolo: sign in with this account and choose <Kbd>Allow</Kbd>. No API
              key to copy.
            </p>
          </Step>

          <Step n={6} title="Start studying">
            <p>
              Open a new chat and type <Kbd>@TalkToBolo</Kbd>, or open the ChatGPT app on your phone, start Voice and ask for your
              course. Try saying:
            </p>
            <ul class="mt-3 flex flex-col gap-2" aria-label="Things to say">
              <For each={VOICE_PROMPTS}>
                {(prompt) => <li class="rounded-2xl bg-soft px-3.5 py-2.5 text-[14px] text-fg [overflow-wrap:anywhere]">"{prompt}"</li>}
              </For>
            </ul>
          </Step>
        </ol>

        <p class="mt-6 text-[13px] leading-relaxed text-muted">
          Custom MCP servers depend on your ChatGPT plan, and a workspace admin may need to allow them. You can reopen this guide
          any time from the ChatGPT button at the top.
        </p>

        <div class="mt-5 flex justify-end gap-2">
          <Show when={props.connected} fallback={<Button variant="soft" onClick={props.onClose}>Not now</Button>}>
            <Button onClick={props.onClose}>Done</Button>
          </Show>
        </div>
      </div>
    </dialog>
  );
}

function Step(props: { n: number; title: string; done?: boolean; children: JSX.Element }) {
  return (
    <li class="flex gap-3.5">
      <span
        class={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold ${
          props.done ? 'bg-soft text-green' : 'bg-solid text-solid-fg'
        }`}
        aria-hidden="true"
      >
        {props.done ? <Check size={16} stroke-width={2.25} /> : props.n}
      </span>
      <div class="min-w-0 flex-1 pt-1">
        <h3 class="text-[16px] font-semibold">{props.title}</h3>
        <div class="mt-1 text-[14px] leading-relaxed text-muted">{props.children}</div>
      </div>
    </li>
  );
}

/** A label from ChatGPT's interface. */
function Kbd(props: { children: JSX.Element }) {
  return <span class="whitespace-nowrap rounded-md bg-soft px-1.5 py-0.5 font-medium text-fg">{props.children}</span>;
}

/** A labelled value with a copy button. */
export function CopyField(props: { label?: string; text: string; mono?: boolean }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="flex w-full min-w-0 items-center gap-2 rounded-2xl bg-soft py-2 pl-3.5 pr-1.5">
      <div class="min-w-0 flex-1">
        <Show when={props.label}>
          <span class="block text-[12px] text-muted">{props.label}</span>
        </Show>
        <span class={`block break-all text-fg ${props.mono ? 'font-mono text-[12px] leading-relaxed' : 'text-[14px]'}`}>{props.text}</span>
      </div>
      <button
        type="button"
        class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg sm:h-9 sm:w-9"
        aria-label={copied() ? 'Copied' : `Copy ${props.label ?? 'to clipboard'}`}
        title={copied() ? 'Copied' : 'Copy'}
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
