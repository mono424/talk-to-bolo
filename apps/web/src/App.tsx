import { Route, Router, useLocation, type RouteSectionProps } from '@solidjs/router';
import { createEffect, createSignal, on, Show } from 'solid-js';
import { Sp00kyProvider } from '@spooky-sync/client-solid';
import { dbConfig } from './db';
import { AuthProvider, useAuth } from './lib/auth';
import { AuthScreen } from './components/AuthScreen';
import { HeaderSlotProvider } from './components/HeaderSlot';
import { RecentCalls, Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import Home from './routes/Home';
import CoursePage from './routes/Course';
import MaterialPage from './routes/Material';
import CallPage from './routes/Call';
import CallsPage from './routes/Calls';
import SettingsPage from './routes/Settings';
import ConnectPage from './routes/Connect';

/** The app window: top bar, sidebar, content, on the gray canvas. */
function Layout(props: RouteSectionProps) {
  const auth = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = createSignal(false);
  createEffect(on(() => location.pathname, () => setMenuOpen(false)));

  // A new page fades in. Opacity only: a transform on <main> would become the
  // containing block of the pages' fixed buttons and shift them mid-fade.
  let main: HTMLElement | undefined;
  createEffect(
    on(
      () => [location.pathname, location.state],
      () => {
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        main?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      },
      { defer: true },
    ),
  );

  return (
    <Show when={auth.userId()} fallback={<AuthScreen />}>
      <div class="app-viewport h-dvh">
        <div class="flex h-full flex-col overflow-hidden bg-surface md:rounded-[22px] md:border md:border-line md:shadow-frame">
          <HeaderSlotProvider>
            <TopBar menuOpen={menuOpen()} onMenu={() => setMenuOpen(!menuOpen())} />
            <div class="relative flex min-h-0 flex-1">
              <Sidebar open={menuOpen()} onClose={() => setMenuOpen(false)} />
              <main ref={main} class="scroll-quiet min-w-0 flex-1 overflow-y-auto overscroll-contain">{props.children}</main>
              <RecentCalls />
            </div>
          </HeaderSlotProvider>
        </div>
      </div>
    </Show>
  );
}

export default function App() {
  return (
    <Sp00kyProvider
      config={dbConfig}
      fallback={<div class="flex h-dvh items-center justify-center text-[15px] text-muted">Opening TalkToBolo…</div>}
      onError={(error) => console.error('Failed to start the local database', error)}
    >
      <AuthProvider>
        <Router root={Layout}>
          <Route path="/" component={Home} />
          <Route path="/courses/:courseKey" component={CoursePage} />
          <Route path="/courses/:courseKey/materials/:materialKey" component={MaterialPage} />
          <Route path="/courses/:courseKey/call" component={CallPage} />
          <Route path="/calls" component={CallsPage} />
          <Route path="/calls/:callKey" component={CallPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/connect" component={ConnectPage} />
        </Router>
      </AuthProvider>
    </Sp00kyProvider>
  );
}
