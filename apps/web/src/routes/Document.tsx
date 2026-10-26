import { A, useNavigate, useParams } from '@solidjs/router';
import { createEffect, createMemo, createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from 'solid-js';
import { Portal } from 'solid-js/web';
import { type GetTable, type TableModel, useDb, useQuery } from '@spooky-sync/client-solid';
import type { EditorView } from '@codemirror/view';
import { BookOpen, FileDown, Trash2 } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { uploadDocumentImage } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  authorList,
  citationSyntax,
  citations,
  type CiteStyle,
  citeYear,
  countCites,
  insertCitation,
  type Paper,
  printCitations,
  updatePapers,
} from '../lib/citations';
import { createDrafts } from '../lib/drafts';
import { idKey, idString } from '../lib/ids';
import { renderMarkdown } from '../lib/markdown';
import { exportPdf } from '../lib/print';
import { firstRow, qDocument, qPapers } from '../lib/query';
import { Button, IconButton, PageLoader } from '../components/ui';
import { Focus, HeaderEndActions, HeaderTitle } from '../components/HeaderSlot';
import { type PaperRow, PapersPanel, type Reading } from '../components/Papers';

const Editor = lazy(() => import('../components/Editor'));

/**
 * Writing a document (a research proposal, an essay) with the papers it
 * draws on beside it. The whole window: one editor for the text on the
 * left, and on the right, in a panel as wide as you drag it, the papers to
 * cite from, each one open to read with its page (components/Papers.tsx).
 * Cite with a paper's Cite button or by typing [@ (lib/citations.ts). On a
 * phone the papers slide up over the text. Saved as you type; Export PDF
 * formats the citations and lists the papers cited.
 */

type DocumentRow = TableModel<GetTable<typeof schema, 'document'>>;

const PANEL_WIDTH_KEY = 'document-panel-width';

export default function DocumentPage() {
  const params = useParams();
  const db = useDb<typeof schema>();
  const documentId = () => `document:${params.documentKey}`;
  const doc = firstRow(useQuery(() => qDocument(db, documentId())));
  const papers = useQuery(() => qPapers(db, documentId()));
  return (
    <Show when={doc.data()} fallback={doc.isLoading() ? <PageLoader /> : <div class="p-10 text-muted">Document not found.</div>}>
      {/* The row itself, not Show's narrowed value: sp00ky may update the same object, which that would not pass on. */}
      <Workspace doc={doc.data()!} papers={papers.data() ?? []} courseKey={params.courseKey ?? ''} />
    </Show>
  );
}

function useMedia(query: string) {
  const list = matchMedia(query);
  const [matches, setMatches] = createSignal(list.matches);
  const update = () => setMatches(list.matches);
  list.addEventListener('change', update);
  onCleanup(() => list.removeEventListener('change', update));
  return matches;
}

const toPaper = (p: PaperRow): Paper => ({ key: idKey(p.id), title: p.title, authors: p.authors, year: p.year, venue: p.venue, url: p.url });

function Workspace(props: { doc: DocumentRow; papers: PaperRow[]; courseKey: string }) {
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const navigate = useNavigate();
  const wide = useMedia('(min-width: 1024px)');
  const id = idString(props.doc.id);
  const parts = [{ id, question: '', questionTitle: '', label: '' }];

  // ── The text ───────────────────────────────────────────────────────────

  const [pending, setPending] = createSignal(0);
  const [notice, setNotice] = createSignal<string | null>(null);
  onMount(() => {
    setPending(db.pendingMutationCount);
    onCleanup(db.subscribeToPendingMutations((n) => setPending(n)));
  });

  const { text, textOf, edit, saveAll, unsaved } = createDrafts({
    rows: () => [props.doc],
    save: (row, content) => db.update('document', row, { content }),
  });

  const uploadImage = async (_part: string, file: File) => {
    setNotice('Adding the image…');
    try {
      const { id: image } = await uploadDocumentImage(db, id, file);
      setNotice(null);
      return `![](answer-image:${idKey(image)})`;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'The image could not be added.');
      return null;
    }
  };

  const words = createMemo(() => {
    const plain = text(props.doc).replace(/\[@[^\]\n]*\]/g, ' ').trim();
    return plain ? plain.split(/\s+/).length : 0;
  });

  // ── Papers and citations ───────────────────────────────────────────────

  // Papers in the order they were added. Rows just made here have no
  // created_at yet (the database sets it), so ties go by where the text
  // first mentions each: a document started from a draft lists them as it does.
  const ordered = createMemo(() => {
    const body = text(props.doc);
    const at = (p: PaperRow) => {
      const spots = [body.indexOf(`@${idKey(p.id)}`), p.url ? body.indexOf(p.url) : -1].filter((i) => i >= 0);
      return spots.length ? Math.min(...spots) : Infinity;
    };
    const time = (p: PaperRow) => (p.created_at ? new Date(p.created_at as unknown as string).getTime() : Infinity);
    return [...props.papers].sort((a, b) => {
      const ta = time(a);
      const tb = time(b);
      return ta === tb || !Number.isFinite(ta) || !Number.isFinite(tb) ? at(a) - at(b) || ta - tb : ta - tb;
    });
  });

  const style = (): CiteStyle => (props.doc.cite_style === 'numeric' ? 'numeric' : 'author-year');
  const papers = createMemo(() => ordered().map(toPaper), [], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const cited = createMemo(() => countCites(text(props.doc)));

  const [view, setView] = createSignal<EditorView>();
  createEffect(() => {
    const v = view();
    if (v) updatePapers(v, papers(), style());
  });

  const [showPapers, setShowPapers] = createSignal(wide());
  const [reading, setReading] = createSignal<Reading | null>(null);

  const cite = (key: string, locator?: string) => {
    const v = view();
    if (!v) return;
    // On a phone the papers cover the text: get them out of the way.
    if (!wide()) setShowPapers(false);
    insertCitation(v, key, locator);
  };
  // Opened from a citation in the text.
  const openCited = (key: string, page: number | null) => {
    setReading({ key, page });
    setShowPapers(true);
  };
  const extensions = [citations(openCited)];

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setShowPapers((v) => !v);
      }
    };
    window.addEventListener('keydown', key);
    onCleanup(() => window.removeEventListener('keydown', key));
  });

  // Wide screens: the panel's width, dragged at its edge and remembered.
  const [panelWidth, setPanelWidth] = createSignal(
    Number(localStorage.getItem(PANEL_WIDTH_KEY)) || Math.round(Math.min(760, Math.max(400, window.innerWidth * 0.4))),
  );
  let resize: { x: number; w: number } | null = null;
  const clampWidth = (w: number) => Math.round(Math.min(window.innerWidth * 0.7, Math.max(340, w)));

  const remove = async () => {
    if (!confirm(`Delete “${props.doc.title}”? Its text and its list of papers go with it. The papers stay in the course.`)) return;
    await db.delete('document', props.doc.id);
    navigate(`/courses/${props.courseKey}`);
  };

  const panel = () => (
    <PapersPanel
      owner={auth.userId() ?? ''}
      documentId={id}
      courseId={idString(props.doc.course)}
      papers={ordered()}
      cited={cited()}
      style={style()}
      onStyle={(cite_style) => void db.update('document', id, { cite_style })}
      reading={reading()}
      onRead={setReading}
      onCite={cite}
      onClose={() => setShowPapers(false)}
    />
  );

  return (
    <div class="w-full px-3 pb-24 sm:px-6">
      <Focus />
      <HeaderTitle>
        <div class="flex min-w-0 items-baseline gap-2.5">
          <A href={`/courses/${props.courseKey}`} class="shrink-0 text-[14px] text-muted hover:text-fg">Course</A>
          <span class="text-faint">/</span>
          <EditableTitle value={props.doc.title} onSave={(title) => void db.update('document', id, { title })} />
          <span class="hidden shrink-0 text-[12px] text-muted sm:inline">
            {pending() > 0 || unsaved() ? 'Saving…' : `${words()} ${words() === 1 ? 'word' : 'words'} · saved`}
          </span>
        </div>
      </HeaderTitle>
      <HeaderEndActions>
        <Button variant={showPapers() ? 'solid' : 'ghost'} size="sm" onClick={() => setShowPapers((v) => !v)} title="Show the papers (⌘E)">
          <BookOpen size={16} stroke-width={1.75} class="lg:hidden" />
          <span class="max-lg:sr-only">Papers</span> <span class="hidden opacity-60 lg:inline">⌘E</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void exportPdf(props.doc.title)} title="Print or save as PDF">
          <FileDown size={16} stroke-width={1.75} /> <span class="hidden sm:inline">Export PDF</span>
        </Button>
        <IconButton label="Delete the document" size="sm" onClick={() => void remove()}>
          <Trash2 size={16} stroke-width={1.75} />
        </IconButton>
      </HeaderEndActions>

      <Show when={notice()}>
        <p class="mx-auto mt-3 max-w-3xl rounded-xl bg-soft px-3.5 py-2 text-[13px] text-muted">{notice()}</p>
      </Show>

      <div class="relative mt-4 flex items-start gap-0">
        <div class="relative min-w-0 flex-1">
          <div class="mx-auto max-w-3xl px-1 sm:px-4">
            <Suspense fallback={<div class="h-40 animate-pulse rounded-xl bg-soft" />}>
              <Editor
                parts={parts}
                content={textOf}
                onInput={edit}
                onActive={() => {}}
                onBlur={saveAll}
                uploadImage={uploadImage}
                placeholder="Start writing. Cite a paper from the right, or type [@"
                label={props.doc.title}
                class="document-editor"
                syntax={[citationSyntax]}
                extensions={extensions}
                onView={setView}
              />
            </Suspense>
          </div>
        </div>

        {/* Wide screens: the papers beside the text, as wide as they are dragged. */}
        <Show when={wide() && showPapers()}>
          <div
            class="sticky top-3 mx-3 h-[calc(100dvh-7.5rem)] w-2 shrink-0 cursor-col-resize touch-none rounded-full transition-colors hover:bg-line"
            title="Drag to resize"
            onPointerDown={(e) => {
              resize = { x: e.clientX, w: panelWidth() };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => resize && setPanelWidth(clampWidth(resize.w - (e.clientX - resize.x)))}
            onPointerUp={() => {
              resize = null;
              localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth()));
            }}
          />
          <aside
            class="sticky top-3 flex h-[calc(100dvh-7.5rem)] shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface"
            style={{ width: `${panelWidth()}px` }}
            aria-label="Papers"
          >
            {panel()}
          </aside>
        </Show>
      </div>

      {/* Phones and tablets: the papers slide up over the text. */}
      <Show when={!wide() && showPapers()}>
        <div class="fixed inset-0 z-30 bg-black/10" onClick={() => setShowPapers(false)} />
        <aside
          class="fixed inset-x-0 bottom-0 z-40 flex h-[78dvh] flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-[0_-10px_30px_-18px_rgb(0_0_0/0.3)]"
          aria-label="Papers"
        >
          {panel()}
        </aside>
      </Show>

      <Portal ref={(el) => el.classList.add('homework-print')}>
        <PrintView title={props.doc.title} text={text(props.doc)} papers={papers()} style={style()} />
      </Portal>
    </div>
  );
}

function EditableTitle(props: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = createSignal(false);
  return (
    <Show
      when={editing()}
      fallback={
        <h1 class="min-w-0 cursor-text truncate text-[16px] font-semibold tracking-tight sm:text-[17px]" onClick={() => setEditing(true)} title="Click to rename">
          {props.value}
        </h1>
      }
    >
      <input
        class="-mx-2 h-9 w-full min-w-0 rounded-lg bg-soft px-2 text-[16px] font-semibold tracking-tight outline-none sm:text-[17px]"
        value={props.value}
        aria-label="Document title"
        ref={(el) => queueMicrotask(() => el.select())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          if (v && v !== props.value) props.onSave(v);
          setEditing(false);
        }}
      />
    </Show>
  );
}

/** "A, B and C", as a reference list writes the authors. */
const joinAuthors = (authors: string | null | undefined) => {
  const list = authorList(authors);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? '');
};

/**
 * What Export PDF prints: the text with its citations formatted, then the
 * papers it cites, set like the homework (a LaTeX article).
 */
function PrintView(props: { title: string; text: string; papers: Paper[]; style: CiteStyle }) {
  const auth = useAuth();
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const printed = createMemo(() => printCitations(props.text, props.papers, props.style));
  return (
    <article class="homework-print-body">
      <header class="title-block">
        <h1>{props.title}</h1>
        <Show when={auth.user()?.name}>{(name) => <p class="author">{name()}</p>}</Show>
        <p class="date">{today}</p>
      </header>
      <div class="answer" innerHTML={renderMarkdown(printed().markdown)} />
      <Show when={printed().cited.length}>
        <h2 class="references-title">References</h2>
        <ol class={`references ${props.style}`}>
          <For each={printed().cited}>
            {(p, i) => (
              <li>
                <Show when={props.style === 'numeric'}>
                  <span class="label">[{i() + 1}]</span>
                </Show>
                <Show
                  when={props.style === 'numeric'}
                  fallback={
                    <>
                      {joinAuthors(p.authors) ? `${joinAuthors(p.authors)} ` : ''}({citeYear(p)}). {p.title}.
                      <Show when={p.venue?.trim()}>
                        {' '}
                        <em>{p.venue}</em>.
                      </Show>
                    </>
                  }
                >
                  {joinAuthors(p.authors) ? `${joinAuthors(p.authors)}, ` : ''}“{p.title},”
                  <Show when={p.venue?.trim()}>
                    {' '}
                    <em>{p.venue}</em>,
                  </Show>{' '}
                  {citeYear(p)}.
                </Show>
                <Show when={p.url?.trim()}>
                  {' '}
                  <span class="url">{p.url}</span>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </article>
  );
}
