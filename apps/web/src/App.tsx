import { Route, Router, type RouteSectionProps } from '@solidjs/router';
import { Show } from 'solid-js';
import { Sp00kyProvider } from '@spooky-sync/client-solid';
import { dbConfig } from './db';
import { AuthProvider, useAuth } from './lib/auth';
import { AuthScreen } from './components/AuthScreen';
import { Sidebar } from './components/Sidebar';
import Home from './routes/Home';
import CoursePage from './routes/Course';
import MaterialPage from './routes/Material';
import CallPage from './routes/Call';
import SettingsPage from './routes/Settings';

function Layout(props: RouteSectionProps) {
  const auth = useAuth();
  return (
    <Show when={auth.userId()} fallback={<AuthScreen />}>
      <div class="min-h-screen md:grid md:grid-cols-[17rem_1fr]">
        <Sidebar />
        <main class="min-w-0">{props.children}</main>
      </div>
    </Show>
  );
}

export default function App() {
  return (
    <Sp00kyProvider
      config={dbConfig}
      fallback={
        <div class="min-h-screen flex items-center justify-center text-pencil text-sm">Opening your notebook…</div>
      }
      onError={(error) => console.error('Failed to start the local database', error)}
    >
      <AuthProvider>
        <Router root={Layout}>
          <Route path="/" component={Home} />
          <Route path="/courses/:courseKey" component={CoursePage} />
          <Route path="/courses/:courseKey/materials/:materialKey" component={MaterialPage} />
          <Route path="/courses/:courseKey/call" component={CallPage} />
          <Route path="/calls/:callKey" component={CallPage} />
          <Route path="/settings" component={SettingsPage} />
        </Router>
      </AuthProvider>
    </Sp00kyProvider>
  );
}
