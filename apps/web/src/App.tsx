import { Route, Router, useLocation, type RouteSectionProps } from '@solidjs/router';
import { createEffect, createSignal, on, Show } from 'solid-js';
import { Sp00kyProvider } from '@spooky-sync/client-solid';
import { dbConfig } from './db';
import { AuthProvider, useAuth } from './lib/auth';
import { AuthScreen } from './components/AuthScreen';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import Home from './routes/Home';
import CoursePage from './routes/Course';
import MaterialPage from './routes/Material';
import CallPage from './routes/Call';
import CallsPage from './routes/Calls';
import SettingsPage from './routes/Settings';

/** The app window: top bar, sidebar, content, on the gray canvas. */
function Layout(props: RouteSectionProps) {
  const auth = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = createSignal(false);
  createEffect(on(() => location.pathname, () => setMenuOpen(false)));

  return (
    <Show when={auth.userId()} fallback={<AuthScreen />}>
      <div class="h-dvh md:p-3">
        <div class="flex h-full flex-col overflow-hidden bg-surface md:rounded-[22px] md:border md:border-line md:shadow-frame">
          <TopBar onMenu={() => setMenuOpen(!menuOpen())} />
          <div class="relative flex min-h-0 flex-1">
            <Sidebar open={menuOpen()} onClose={() => setMenuOpen(false)} />
            <main class="scroll-quiet min-w-0 flex-1 overflow-y-auto">{props.children}</main>
          </div>
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
        </Router>
      </AuthProvider>
    </Sp00kyProvider>
  );
}
