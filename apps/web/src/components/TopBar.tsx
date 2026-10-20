import { A, useLocation } from '@solidjs/router';
import { createSignal, For, Show } from 'solid-js';
import { BookOpen, KeyRound, LogOut, Menu, PhoneCall } from 'lucide-solid';
import { useAuth } from '../lib/auth';

const TABS = [
  { href: '/', label: 'Study', icon: BookOpen, match: (p: string) => p === '/' || p.startsWith('/courses') },
  { href: '/calls', label: 'Calls', icon: PhoneCall, match: (p: string) => p.startsWith('/calls') },
  { href: '/settings', label: 'AI access', icon: KeyRound, match: (p: string) => p.startsWith('/settings') },
];

/** Bolo, the approved TalkToBolo mark. */
export function Logo(props: { class?: string }) {
  return (
    <svg viewBox="60 36 210 258" class={`shrink-0 ${props.class ?? 'h-8 w-10'}`} aria-hidden="true">
      <image href="/studycall-logo.svg" x="60" y="36" width="210" height="258" />
    </svg>
  );
}

export function TopBar(props: { onMenu: () => void }) {
  const location = useLocation();
  const auth = useAuth();
  const [menu, setMenu] = createSignal(false);
  const initial = () => auth.user()?.name?.trim().charAt(0).toUpperCase() || '?';

  return (
    <header class="flex h-16 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-5">
      <button
        type="button"
        class="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-soft hover:text-fg md:hidden"
        aria-label="Open the sidebar"
        onClick={props.onMenu}
      >
        <Menu size={20} stroke-width={1.75} />
      </button>
      <A href="/" class="mr-3 inline-flex shrink-0 items-center text-fg" aria-label="TalkToBolo home">
        <Logo />
      </A>

      <nav class="flex items-center gap-1" aria-label="Sections">
        <For each={TABS}>
          {(tab) => (
            <A
              href={tab.href}
              class={`inline-flex h-10 items-center gap-2 rounded-xl px-3 text-[15px] transition-colors ${
                tab.match(location.pathname) ? 'bg-soft text-fg' : 'text-muted hover:text-fg'
              }`}
              aria-current={tab.match(location.pathname) ? 'page' : undefined}
            >
              <tab.icon size={18} stroke-width={1.75} />
              <span class="hidden sm:inline">{tab.label}</span>
            </A>
          )}
        </For>
      </nav>

      <div class="relative ml-auto">
        <button
          type="button"
          onClick={() => setMenu(!menu())}
          class="inline-flex h-10 items-center gap-2.5 rounded-full bg-soft pl-1 pr-3.5 text-[14px] text-fg hover:bg-hover"
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
            <button
              type="button"
              role="menuitem"
              class="flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-[15px] hover:bg-soft"
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
