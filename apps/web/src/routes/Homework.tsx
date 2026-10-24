import { A, useParams } from '@solidjs/router';
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { type GetTable, type TableModel, useDb, useQuery } from '@spooky-sync/client-solid';
import { ExternalLink, FileDown, ImagePlus, X } from 'lucide-solid';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { schema } from '../schema.gen';
import { fetchPdf, materialPath, uploadAnswerImage } from '../lib/api';
import { idKey, idString } from '../lib/ids';
import { renderMarkdown } from '../lib/markdown';
import { loadPdfjs } from '../lib/pdfjs';
import { firstRow, qAnswers, qHomework, qMaterial } from '../lib/query';
import { locateParts, parseRegion } from '../lib/sheet-regions';
import { Button, PageLoader } from '../components/ui';
import { HeaderEndActions, HeaderTitle } from '../components/HeaderSlot';
import { SheetExcerpt } from '../components/SheetExcerpt';

/**
 * Doing homework: every answer of an exercise sheet in one document, part by
 * part in sheet order. A quiet label in the margin says which part an answer
 * is for; the exercise of the part being written shows beside it (on a
 * phone, pinned above the keyboard), as an excerpt of the sheet itself.
 * Answers are Markdown with $math$, saved as you type, and print as a PDF.
 */

type AnswerRow = TableModel<GetTable<typeof schema, 'answer'>>;
type MaterialRow = TableModel<GetTable<typeof schema, 'material'>>;

const SAVE_DELAY_MS = 500;

/** Keys above the keyboard and under the active answer: what is tedious to type. */
const SNIPPETS: { label: string; before: string; after?: string; title: string }[] = [
  { label: '$x$', before: '$', after: '$', title: 'Math' },
  { label: '$$', before: '\n$$\n', after: '\n$$\n', title: 'Display math' },
  { label: 'x²', before: '^{', after: '}', title: 'Superscript' },
  { label: 'xₙ', before: '_{', after: '}', title: 'Subscript' },
  { label: 'a/b', before: '\\frac{', after: '}{}', title: 'Fraction' },
  { label: '√', before: '\\sqrt{', after: '}', title: 'Square root' },
  { label: 'λ', before: '\\lambda ', title: 'lambda' },
  { label: 'π', before: '\\pi ', title: 'pi' },
  { label: 'Δ', before: '\\Delta ', title: 'Delta' },
  { label: 'ε', before: '\\varepsilon ', title: 'epsilon' },
  { label: 'τ', before: '\\tau ', title: 'tau' },
  { label: '·', before: '\\cdot ', title: 'Times dot' },
  { label: '×', before: '\\times ', title: 'Times' },
  { label: '°', before: '^\\circ', title: 'Degrees' },
  { label: '→', before: '\\to ', title: 'Arrow' },
  { label: '≈', before: '\\approx ', title: 'Approximately' },
];

export default function HomeworkPage() {
  const params = useParams();
  const db = useDb<typeof schema>();
  const homeworkId = () => `homework:${params.homeworkKey}`;
  const homework = firstRow(useQuery(() => qHomework(db, homeworkId())));
  const answers = useQuery(() => qAnswers(db, homeworkId()));

  return (
    <Show when={homework.data()} fallback={homework.isLoading() ? <PageLoader /> : <div class="p-10 text-muted">Homework not found.</div>}>
      {(hw) => (
        // The sheet's live query mounts once its id is known, never switching in place.
        <Show
          when={hw().sheet ? idString(hw().sheet) : null}
          keyed
          fallback={<Workspace title={hw().title} answers={answers.data() ?? []} sheet={null} courseKey={params.courseKey ?? ''} />}
        >
          {(sheetId) => <WithSheet sheetId={sheetId} title={hw().title} answers={answers.data() ?? []} courseKey={params.courseKey ?? ''} />}
        </Show>
      )}
    </Show>
  );
}

function WithSheet(props: { sheetId: string; title: string; answers: AnswerRow[]; courseKey: string }) {
  const db = useDb<typeof schema>();
  const sheet = firstRow(useQuery(() => qMaterial(db, props.sheetId)));
  return <Workspace title={props.title} answers={props.answers} sheet={sheet.data() ?? null} courseKey={props.courseKey} />;
}

function useMedia(query: string) {
  const list = matchMedia(query);
  const [matches, setMatches] = createSignal(list.matches);
  const update = () => setMatches(list.matches);
  list.addEventListener('change', update);
  onCleanup(() => list.removeEventListener('change', update));
  return matches;
}

/** The part of the page the keyboard leaves visible (phones). */
function useVisualViewport() {
  const vv = window.visualViewport;
  const [state, setState] = createSignal({ top: vv?.offsetTop ?? 0, height: vv?.height ?? window.innerHeight });
  if (vv) {
    const update = () => setState({ top: vv.offsetTop, height: vv.height });
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    onCleanup(() => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    });
  }
  return state;
}

function Workspace(props: { title: string; answers: AnswerRow[]; sheet: MaterialRow | null; courseKey: string }) {
  const db = useDb<typeof schema>();
  const wide = useMedia('(min-width: 1024px)');
  const viewport = useVisualViewport();

  // ── The sheet's PDF, for the excerpts ──────────────────────────────────

  const [pdf, setPdf] = createSignal<PDFDocumentProxy | null>(null);
  createEffect(
    on(
      () => (props.sheet?.kind === 'pdf' && props.sheet.source_size ? idString(props.sheet.id) : null),
      (id) => {
        setPdf(null);
        if (!id) return;
        let cancelled = false;
        let loading: { destroy(): Promise<void> } | null = null;
        void (async () => {
          try {
            const [lib, buf] = await Promise.all([loadPdfjs(), fetchPdf(db, id, props.sheet?.source_size)]);
            if (cancelled) return;
            const task = lib.getDocument({ data: new Uint8Array(buf.slice(0)) });
            loading = task;
            const doc = await task.promise;
            if (!cancelled) setPdf(doc);
          } catch {
            // Without the PDF the excerpts show the exercise's text.
          }
        })();
        onCleanup(() => {
          cancelled = true;
          void loading?.destroy();
        });
      },
    ),
  );

  // Find each part on the sheet once, and keep it with the answer.
  let located = false;
  createEffect(() => {
    const doc = pdf();
    const rows = props.answers;
    if (!doc || located || !rows.length || rows.every((a) => a.region !== undefined && a.region !== null)) return;
    located = true;
    void locateParts(doc, rows).then((regions) =>
      Promise.all(rows.map((a, i) => (a.region ? null : db.update('answer', a.id, { region: JSON.stringify(regions[i]) })))),
    );
  });

  // ── Editing ────────────────────────────────────────────────────────────

  const [active, setActive] = createSignal<string | null>(null);
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const [pending, setPending] = createSignal(0);
  const [notice, setNotice] = createSignal<string | null>(null);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const editors = new Map<string, HTMLTextAreaElement>();
  const blocks = new Map<string, HTMLElement>();

  onMount(() => {
    setPending(db.pendingMutationCount);
    onCleanup(db.subscribeToPendingMutations((n) => setPending(n)));
  });

  const text = (a: AnswerRow) => drafts()[idString(a.id)] ?? a.content ?? '';

  const save = (id: string) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const value = drafts()[id];
    if (value === undefined) return;
    void db.update('answer', id, { content: value }).then(() =>
      // Once saved, the row is the truth again (and takes edits from another device).
      setDrafts((d) => {
        if (d[id] !== value) return d;
        const { [id]: _saved, ...rest } = d;
        return rest;
      }),
    );
  };
  onCleanup(() => {
    for (const id of [...timers.keys()]) save(id);
  });

  const edit = (id: string, value: string) => {
    setDrafts((d) => ({ ...d, [id]: value }));
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => save(id), SAVE_DELAY_MS));
  };

  const ids = () => props.answers.map((a) => idString(a.id));
  const focus = (id: string, at: 'start' | 'end' | null = null) => {
    setActive(id);
    queueMicrotask(() => {
      const el = editors.get(id);
      if (!el) return;
      el.focus({ preventScroll: false });
      if (at === 'start') el.setSelectionRange(0, 0);
      if (at === 'end') el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const move = (id: string, by: 1 | -1) => {
    const list = ids();
    const next = list[list.indexOf(id) + by];
    if (next) focus(next, by === 1 ? 'start' : 'end');
  };

  const insert = (id: string, before: string, after = '') => {
    const el = editors.get(id);
    if (!el) return;
    const { selectionStart: s, selectionEnd: e, value } = el;
    const next = value.slice(0, s) + before + value.slice(s, e) + after + value.slice(e);
    el.value = next;
    edit(id, next);
    el.focus();
    const caret = s + before.length + (e - s);
    el.setSelectionRange(caret, caret);
    autosize(el);
  };

  const addImages = async (id: string, files: File[]) => {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      setNotice('Adding the image…');
      try {
        const { id: image } = await uploadAnswerImage(db, id, file);
        insert(id, `\n![](answer-image:${idKey(image)})\n`);
        setNotice(null);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'The image could not be added.');
      }
    }
  };

  // ── The exercise beside (or above) the active answer ───────────────────

  const [showExercise, setShowExercise] = createSignal(true);
  const current = createMemo(() => props.answers.find((a) => idString(a.id) === active()) ?? props.answers[0] ?? null);
  const [railTop, setRailTop] = createSignal(0);
  let docEl!: HTMLDivElement;

  // Beside the active answer, kept in view while it is long.
  createEffect(() => {
    const a = current();
    if (!a || !wide()) return;
    const el = blocks.get(idString(a.id));
    if (!el) return;
    setRailTop(Math.max(0, el.offsetTop - 6));
  });

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setShowExercise((v) => !v);
      }
    };
    window.addEventListener('keydown', key);
    onCleanup(() => window.removeEventListener('keydown', key));
  });

  // Phones: how much room the pinned exercise takes (drag its handle).
  const [pinnedHeight, setPinnedHeight] = createSignal(190);
  const [folded, setFolded] = createSignal(false);
  let drag: { y: number; h: number; moved: boolean } | null = null;

  const answered = () => props.answers.filter((a) => text(a).trim()).length;

  const exercise = (a: AnswerRow, compact: boolean): JSX.Element => (
    <div class={`overflow-hidden rounded-xl border border-line bg-surface ${compact ? '' : 'shadow-[0_18px_40px_-20px_rgb(0_0_0/0.22)]'}`}>
      <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px] text-muted">
        <span class="min-w-0 flex-1 truncate">
          {[a.question, a.label].filter(Boolean).join(' ')}
          {a.points ? ` · ${a.points} ${a.points === 1 ? 'point' : 'points'}` : ''}
        </span>
        <Show when={props.sheet}>
          {(sheet) => (
            <A href={materialPath(idString(sheet().course), idString(sheet().id), a.page ?? a.anchor_page)} class="inline-flex items-center gap-1 hover:text-fg">
              Page {a.page ?? a.anchor_page ?? 1} <ExternalLink size={11} stroke-width={1.75} />
            </A>
          )}
        </Show>
        <button type="button" class="-mr-1 inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-soft hover:text-fg" aria-label="Hide the exercise (⌘E)" onClick={() => setShowExercise(false)}>
          <X size={13} stroke-width={1.9} />
        </button>
      </div>
      <Show when={!(compact && folded())}>
        <div class={`p-2 ${compact ? 'overflow-y-auto overscroll-contain' : ''}`} style={compact ? { 'max-height': `${pinnedHeight()}px` } : undefined}>
          <SheetExcerpt pdf={pdf()} segments={parseRegion(a.region)} prompt={a.prompt} context={a.context} />
        </div>
      </Show>
    </div>
  );

  return (
    <div class="mx-auto w-full max-w-6xl px-3 pb-24 sm:px-6">
      <HeaderTitle>
        <div class="flex min-w-0 items-baseline gap-2.5">
          <h1 class="min-w-0 truncate text-[16px] font-semibold tracking-tight sm:text-[17px]">{props.title}</h1>
          <span class="shrink-0 text-[12px] text-muted">
            {pending() > 0 || Object.keys(drafts()).length ? 'Saving…' : `${answered()} of ${props.answers.length} answered · saved`}
          </span>
        </div>
      </HeaderTitle>
      <HeaderEndActions>
        <Button variant={showExercise() ? 'solid' : 'ghost'} size="sm" onClick={() => setShowExercise((v) => !v)} title="Show the exercise (⌘E)">
          Exercise <span class="hidden opacity-60 lg:inline">⌘E</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => window.print()} title="Print or save as PDF">
          <FileDown size={16} stroke-width={1.75} /> <span class="hidden sm:inline">Export PDF</span>
        </Button>
      </HeaderEndActions>

      {/* Phones: the exercise pinned at the top of what the keyboard leaves visible. */}
      <Show when={!wide() && showExercise() && current()}>
        {(a) => (
          <>
            <div
              class={active() ? 'fixed inset-x-0 z-30 px-2 pt-2' : 'pt-2'}
              style={active() ? { top: `${viewport().top}px` } : undefined}
            >
              {exercise(a(), true)}
              <div
                class="flex touch-none justify-center py-1.5"
                onPointerDown={(e) => {
                  drag = { y: e.clientY, h: folded() ? 0 : pinnedHeight(), moved: false };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!drag) return;
                  const dy = e.clientY - drag.y;
                  if (Math.abs(dy) > 4) drag.moved = true;
                  if (!drag.moved) return;
                  const h = drag.h + dy;
                  setFolded(h < 50);
                  setPinnedHeight(Math.min(viewport().height * 0.6, Math.max(60, h)));
                }}
                onPointerUp={() => {
                  // A tap folds or unfolds; a drag resizes.
                  if (drag && !drag.moved) setFolded((f) => !f);
                  drag = null;
                }}
              >
                <span class="h-1 w-9 rounded-full bg-line-strong" />
              </div>
            </div>
            <Show when={active()}>
              <div aria-hidden="true" style={{ height: `${(folded() ? 36 : pinnedHeight() + 46) + 12}px` }} />
            </Show>
          </>
        )}
      </Show>

      <Show when={notice()}>
        <p class="mx-auto mt-3 max-w-3xl rounded-xl bg-soft px-3.5 py-2 text-[13px] text-muted">{notice()}</p>
      </Show>

      <div class="relative mt-4 grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-8">
        <div ref={docEl} class="relative min-w-0 max-w-3xl">
          {/* By position, not by row: a saved answer syncing back must not rebuild its editor. */}
          <Index each={props.answers} fallback={<p class="py-10 text-center text-muted">This sheet has no parts to answer.</p>}>
            {(row, i) => {
              const a = () => row();
              const id = idString(row().id);
              const isActive = () => active() === id;
              const newQuestion = () => i === 0 || props.answers[i - 1]?.question !== a().question;
              return (
                <>
                  <Show when={newQuestion()}>
                    <div class={`grid grid-cols-[3rem_minmax(0,1fr)] sm:grid-cols-[4.25rem_minmax(0,1fr)] ${i ? 'mt-5' : ''} mb-2`}>
                      <div class="pr-3 pt-[3px] text-right text-[11px] tabular-nums text-faint">{a().question}</div>
                      <h2 class="text-[14px] font-semibold">{a().question_title || `Question ${a().question}`}</h2>
                    </div>
                  </Show>
                  <div ref={(el) => blocks.set(id, el)} class="grid grid-cols-[3rem_minmax(0,1fr)] sm:grid-cols-[4.25rem_minmax(0,1fr)]">
                    <button
                      type="button"
                      class={`pr-3 pt-[5px] text-right text-[11px] leading-tight transition-colors ${isActive() ? 'text-muted' : 'text-faint hover:text-muted'}`}
                      onClick={() => focus(id, 'end')}
                      title={a().points ? `${a().points} points` : undefined}
                    >
                      {a().label}
                    </button>
                    <div class="relative min-w-0 pb-4">
                      <Show when={isActive()}>
                        <span aria-hidden="true" class="absolute -left-2.5 bottom-5 top-1.5 w-px bg-blue opacity-55" />
                      </Show>
                      <Show
                        when={isActive()}
                        fallback={
                          <div class="min-h-7 cursor-text" onClick={() => focus(id, 'end')}>
                            <Show when={text(a()).trim()} fallback={<p class="text-[15px] text-faint">Answer…</p>}>
                              <div class="lecture answer text-[15px]" innerHTML={renderMarkdown(text(a()))} />
                            </Show>
                          </div>
                        }
                      >
                        <textarea
                          ref={(el) => {
                            editors.set(id, el);
                            queueMicrotask(() => autosize(el));
                          }}
                          class="block w-full resize-none overflow-hidden bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-faint sm:text-[15px]"
                          rows={1}
                          value={text(a())}
                          placeholder="Answer… $math$ works, paste images"
                          aria-label={`Answer to ${[a().question, a().label].filter(Boolean).join(' ')}`}
                          onInput={(e) => {
                            edit(id, e.currentTarget.value);
                            autosize(e.currentTarget);
                          }}
                          onBlur={() => save(id)}
                          onPaste={(e) => {
                            const files = [...(e.clipboardData?.files ?? [])];
                            if (files.some((f) => f.type.startsWith('image/'))) {
                              e.preventDefault();
                              void addImages(id, files);
                            }
                          }}
                          onKeyDown={(e) => {
                            const el = e.currentTarget;
                            if (e.key === 'Escape') {
                              save(id);
                              setActive(null);
                            } else if (e.key === 'Tab') {
                              e.preventDefault();
                              move(id, e.shiftKey ? -1 : 1);
                            } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0) {
                              e.preventDefault();
                              move(id, -1);
                            } else if (e.key === 'ArrowDown' && el.selectionStart === el.value.length) {
                              e.preventDefault();
                              move(id, 1);
                            }
                          }}
                        />
                        <Show when={/[$\\*_#![`|]/.test(text(a()))}>
                          <div class="lecture answer mt-2 border-t border-dashed border-line pt-2 text-[15px]" innerHTML={renderMarkdown(text(a()))} />
                        </Show>
                        <Keys onKey={(s) => insert(id, s.before, s.after)} onImages={(files) => void addImages(id, files)} />
                      </Show>
                    </div>
                  </div>
                </>
              );
            }}
          </Index>
        </div>

        {/* Wide screens: the exercise beside the active answer. */}
        <Show when={wide() && showExercise() && current()}>
          {(a) => (
            <div class="relative">
              <div class="sticky top-4 transition-[margin] duration-200" style={{ 'margin-top': `${railTop()}px` }}>
                {exercise(a(), false)}
              </div>
            </div>
          )}
        </Show>
      </div>

      <Portal ref={(el) => el.classList.add('homework-print')}>
        <PrintView title={props.title} answers={props.answers} text={text} />
      </Portal>
    </div>
  );
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/** Math and images, one tap away: under the active answer, and above a phone's keyboard. */
function Keys(props: { onKey: (s: (typeof SNIPPETS)[number]) => void; onImages: (files: File[]) => void }) {
  let input!: HTMLInputElement;
  return (
    <div class="scroll-quiet -mx-1 mt-2 flex gap-1 overflow-x-auto pb-1" onMouseDown={(e) => e.preventDefault()}>
      <For each={SNIPPETS}>
        {(s) => (
          <button
            type="button"
            title={s.title}
            class="h-9 shrink-0 rounded-lg bg-soft px-2.5 font-serif text-[14px] text-muted transition-colors hover:bg-hover hover:text-fg md:h-7 md:text-[13px]"
            onClick={() => props.onKey(s)}
          >
            {s.label}
          </button>
        )}
      </For>
      <button
        type="button"
        title="Add an image"
        class="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg bg-soft px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg md:h-7 md:text-[12px]"
        onClick={() => input.click()}
      >
        <ImagePlus size={14} stroke-width={1.75} /> Image
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        class="sr-only"
        tabindex="-1"
        multiple
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = '';
          if (files.length) props.onImages(files);
        }}
      />
    </div>
  );
}

/** What Export PDF prints: the answers in sheet order, under their part labels. */
function PrintView(props: { title: string; answers: AnswerRow[]; text: (a: AnswerRow) => string }) {
  return (
    <article class="homework-print-body">
      <h1>{props.title}</h1>
      <For each={props.answers}>
        {(a, i) => (
          <>
            <Show when={i() === 0 || props.answers[i() - 1]?.question !== a.question}>
              <h2>
                Question {a.question}
                {a.question_title ? `: ${a.question_title}` : ''}
              </h2>
            </Show>
            <section>
              <Show when={a.label}>
                <h3>
                  {a.label}
                  {a.points ? <span> ({a.points} points)</span> : null}
                </h3>
              </Show>
              <Show when={props.text(a).trim()} fallback={<p class="unanswered">No answer.</p>}>
                <div class="lecture" innerHTML={renderMarkdown(props.text(a))} />
              </Show>
            </section>
          </>
        )}
      </For>
    </article>
  );
}
