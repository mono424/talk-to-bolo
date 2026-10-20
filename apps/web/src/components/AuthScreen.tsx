import { createSignal, Show } from 'solid-js';
import { useAuth } from '../lib/auth';
import { Button, Field, inputClass } from './ui';

export function AuthScreen() {
  const auth = useAuth();
  const [mode, setMode] = createSignal<'signin' | 'signup'>('signin');
  const [name, setName] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode() === 'signup') await auth.signUp(name().trim(), email().trim(), password());
      else await auth.signIn(email().trim(), password());
    } catch (err) {
      console.error(err);
      setError(
        mode() === 'signup'
          ? 'Could not create the account. The email may already be registered.'
          : 'Email or password is wrong.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="min-h-screen grid lg:grid-cols-[1.1fr_1fr]">
      <section class="relative overflow-hidden px-6 py-12 sm:px-12 lg:py-20 flex flex-col justify-center border-b lg:border-b-0 lg:border-r border-rule">
        <div class="absolute inset-y-0 left-6 sm:left-10 w-px bg-margin/60" aria-hidden="true" />
        <div class="relative pl-6 sm:pl-8 max-w-xl">
          <p class="font-bold text-ink text-lg mb-10">Studycall</p>
          <h1 class="text-4xl sm:text-5xl font-bold leading-[1.08] tracking-tight mb-5">
            Call your tutor about today’s lecture.
          </h1>
          <p class="text-pencil text-lg leading-relaxed mb-10 max-w-md">
            Add your slides and notes to a course. Then talk it through: the tutor explains the material, answers
            your questions and quizzes you, out loud.
          </p>

          <div class="ruled rounded-xl border border-rule bg-sheet px-5 py-4 font-serif text-[15px] leading-8 max-w-md shadow-[0_1px_0_var(--rule)]">
            <p class="text-ink">So an eigenvector keeps its direction when A acts on it. Want to try one?</p>
            <p class="text-graphite">Okay, give me a two by two.</p>
            <p class="text-ink">
              <mark class="highlight-sweep">
                Take the diagonal matrix with 2 and 3. What are its eigenvalues?
              </mark>
            </p>
          </div>
        </div>
      </section>

      <section class="px-6 py-12 sm:px-12 flex items-center justify-center">
        <form onSubmit={submit} class="w-full max-w-sm">
          <div class="flex gap-1 p-1 rounded-lg bg-rule-soft mb-8" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode() === 'signin'}
              class={`flex-1 rounded-md py-1.5 text-sm font-medium ${mode() === 'signin' ? 'bg-sheet shadow-sm' : 'text-pencil'}`}
              onClick={() => setMode('signin')}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode() === 'signup'}
              class={`flex-1 rounded-md py-1.5 text-sm font-medium ${mode() === 'signup' ? 'bg-sheet shadow-sm' : 'text-pencil'}`}
              onClick={() => setMode('signup')}
            >
              Create account
            </button>
          </div>

          <div class="space-y-4">
            <Show when={mode() === 'signup'}>
              <Field label="Your name" hint="The tutor greets you with it.">
                <input class={inputClass} value={name()} onInput={(e) => setName(e.currentTarget.value)} required autocomplete="given-name" />
              </Field>
            </Show>
            <Field label="Email">
              <input class={inputClass} type="email" value={email()} onInput={(e) => setEmail(e.currentTarget.value)} required autocomplete="email" />
            </Field>
            <Field label="Password">
              <input
                class={inputClass}
                type="password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                required
                minLength={8}
                autocomplete={mode() === 'signup' ? 'new-password' : 'current-password'}
              />
            </Field>
          </div>

          <Show when={error()}>
            <p class="mt-4 text-sm text-margin" role="alert">
              {error()}
            </p>
          </Show>

          <Button type="submit" class="w-full mt-6" disabled={busy()}>
            {busy() ? 'One moment…' : mode() === 'signup' ? 'Create account' : 'Sign in'}
          </Button>
        </form>
      </section>
    </div>
  );
}
