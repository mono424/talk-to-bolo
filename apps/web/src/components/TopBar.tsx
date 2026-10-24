import { A } from '@solidjs/router';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { LogOut, Menu, MessageCircle, X } from 'lucide-solid';
import { useAuth } from '../lib/auth';
import { useChatGPTGuide } from './ChatGPTGuide';
import { Dot } from './ui';
import { HeaderEndSlot, HeaderSlot, HeaderTitleSlot, useFocused, useHeaderTitleUsed } from './HeaderSlot';

/** Bolo, the approved TalkToBolo mark. */
export function Logo(props: { class?: string }) {
  return (
    <svg viewBox="60 36 210 258" class={`shrink-0 ${props.class ?? 'h-8 w-10'}`} aria-hidden="true">
      <image href="/studycall-logo.svg" x="60" y="36" width="210" height="258" />
    </svg>
  );
}

export function TopBar(props: { onMenu: () => void; menuOpen: boolean }) {
  const auth = useAuth();
  const guide = useChatGPTGuide();
  const [menu, setMenu] = createSignal(false);
  const titled = useHeaderTitleUsed();
  const focused = useFocused();
  const initial = () => auth.user()?.name?.trim().charAt(0).toUpperCase() || '?';

  // How much of the bar's right end the account menu takes: page controls in
  // the slot keep clear of it (.header-column in global.css).
  let header!: HTMLElement;
  let account!: HTMLDivElement;
  onMount(() => {
    const measure = () =>
      header.style.setProperty('--account-w', `${header.getBoundingClientRect().right - account.getBoundingClientRect().left}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(account);
    onCleanup(() => observer.disconnect());
  });

  return (
    <header ref={header} class="relative flex h-16 shrink-0 items-center gap-2 px-3 sm:px-5">
      {/* A page in focus has no sidebar to open: its own way back stands here. */}
      <Show when={!focused()}>
        <button
          type="button"
          class="inline-flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-soft hover:text-fg md:hidden"
          aria-label={props.menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={props.menuOpen}
          aria-controls="app-navigation"
          onClick={props.onMenu}
        >
          {props.menuOpen ? <X size={20} stroke-width={1.75} /> : <Menu size={20} stroke-width={1.75} />}
        </button>
      </Show>
      <Show when={!titled()}>
        <A href="/" class="mr-1 inline-flex shrink-0 items-center text-fg sm:mr-3" aria-label="TalkToBolo home">
          <Logo />
        </A>
      </Show>
      {/* A page's own title, in place of the logo: within the sidebar's width beside it, unless the sidebar is hidden. */}
      <HeaderTitleSlot class={`flex min-w-0 items-center empty:hidden ${focused() ? '' : 'md:max-w-[252px]'}`} />

      {/* Beside the sidebar, the slot spans the page below it, so pages can line controls up with their content.
          Wide windows end it at the recent sessions column, clear of the account menu above it. */}
      <HeaderSlot class="flex min-w-0 flex-1 items-center gap-2 md:pointer-events-none md:absolute md:inset-y-0 md:left-[288px] md:right-0 xl:right-[288px] xl:[--account-w:0px]" />

      <div ref={account} class="relative ml-auto flex shrink-0 items-center gap-2">
        <HeaderEndSlot class="flex items-center gap-1 empty:hidden" />
        {/* The way back to the ChatGPT guide: prominent until a connection exists. */}
        <button
          type="button"
          onClick={guide.open}
          class={`relative inline-flex h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full text-[14px] font-medium transition-colors md:h-10 ${
            guide.connected()
              ? 'w-11 bg-soft text-fg hover:bg-hover sm:w-auto sm:px-3.5'
              : 'cta-glow px-4 font-semibold'
          }`}
          aria-label={guide.connected() ? 'ChatGPT connected: how to study' : 'Connect ChatGPT'}
        >
          {/* Connected on a phone: a round icon with a green badge, never a squeezed pill. */}
          <Show when={guide.connected()} fallback={<MessageCircle size={17} stroke-width={2} />}>
            <MessageCircle size={18} stroke-width={1.8} class="sm:hidden" />
            <Dot tone="ready" class="absolute right-2 top-2 ring-2 ring-soft sm:static sm:ring-0" />
          </Show>
          <span class={guide.connected() ? 'hidden sm:inline' : ''}>{guide.connected() ? 'ChatGPT' : 'Connect ChatGPT'}</span>
        </button>
        <button
          type="button"
          onClick={() => setMenu(!menu())}
          class="inline-flex h-11 min-w-11 items-center justify-center gap-2.5 rounded-full bg-soft px-1 text-[14px] text-fg hover:bg-hover md:h-10 sm:pr-3.5"
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={menu()}
        >
          <span class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-solid text-[13px] font-semibold text-solid-fg">
            {initial()}
          </span>
          <span class="hidden max-w-40 truncate sm:inline">{auth.user()?.name ?? 'Account'}</span>
        </button>
        <Show when={menu()}>
          <div class="fixed inset-0 z-40" onClick={() => setMenu(false)} />
          <div role="menu" class="absolute right-0 z-50 mt-2 w-56 rounded-2xl border border-line bg-surface p-1.5 shadow-card">
            <div class="px-3 py-2 text-[13px] text-muted truncate">{auth.user()?.email}</div>
            <A
              href="/settings"
              role="menuitem"
              class="flex h-11 w-full items-center gap-2.5 rounded-xl px-3 text-[15px] hover:bg-soft md:h-10"
              onClick={() => setMenu(false)}
            >
              <MessageCircle size={17} stroke-width={1.75} class="text-muted" /> ChatGPT
            </A>
            <button
              type="button"
              role="menuitem"
              class="flex h-11 w-full items-center gap-2.5 rounded-xl px-3 text-[15px] hover:bg-soft md:h-10"
              onClick={() => auth.signOut()}
            >
              <LogOut size={17} stroke-width={1.75} class="text-muted" /> Sign out
            </button>
          </div>
        </Show>
      </div>
    </header>
  );
}
