import { A, useNavigate, useParams } from '@solidjs/router';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { type GetTable, type TableModel, useDb, useQuery } from '@spooky-sync/client-solid';
import { FileText, FileType2, Folder, PenLine, Plus, Settings2, Trash2, Upload } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { useAuth } from '../lib/auth';
import { ApiError, uploadPdf } from '../lib/api';
import { reindexMaterial } from '../lib/jobs';
import { idKey, newId, whenSynced } from '../lib/ids';
import { COURSE_COLORS, courseColor, LANGUAGES, type CourseColor } from '../lib/palette';
import { qMaterialsPage, useCourse } from '../lib/query';
import { Button, Field, IconButton, inputClass, PageLoader, StatusText } from '../components/ui';
import { scrollParent, VirtualList } from '../components/VirtualList';
import { CourseSearch } from '../components/CourseSearch';
import { Sheet } from '../components/Sheet';
import { HeaderEndActions, HeaderTitle } from '../components/HeaderSlot';

export default function CoursePage() {
  const params = useParams();
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const courseId = () => `course:${params.courseKey}`;

  const course = useCourse(db, auth.userId, courseId);

  const [writing, setWriting] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);

  // ── Header: the course's icon and name sit in the top bar where the logo
  // was, its actions next to the account menu. The search sticks under it.

  const [page, setPage] = createSignal<HTMLElement>();
  const [scroller, setScroller] = createSignal<HTMLElement | null>(null);
  const [scrolled, setScrolled] = createSignal(false);

  createEffect(() => {
    const el = page() && scrollParent(page()!);
    setScroller(el ?? null);
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 0);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    onCleanup(() => el.removeEventListener('scroll', onScroll));
  });

  const write = () => {
    setWriting(true);
    scroller()?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ── Adding material ────────────────────────────────────────────────────

  async function addFiles(files: FileList | File[]) {
    const uid = auth.userId();
    if (!uid) return;
    setNotice(null);
    for (const file of Array.from(files)) {
      const name = file.name.replace(/\.(pdf|md|markdown|txt)$/i, '');
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        const id = newId('material');
        await db.create(id, { owner: uid, course: courseId(), title: name, kind: 'pdf', content: '', status: 'pending' });
        void (async () => {
          try {
            await whenSynced(db);
            await uploadPdf(db, id, file);
          } catch (err) {
            // A refused file (400) is marked failed on its row by the API;
            // this covers the request itself failing.
            if (!(err instanceof ApiError && err.status === 400)) {
              setNotice(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
            }
          }
        })();
      } else if (/\.(md|markdown|txt)$/i.test(file.name) || file.type.startsWith('text/')) {
        await addText(name, await file.text(), /\.txt$/i.test(file.name) ? 'text' : 'markdown');
      } else {
        setNotice(`${file.name} was skipped: add PDFs, Markdown or text files.`);
      }
    }
  }

  async function addText(title: string, content: string, kind: 'text' | 'markdown') {
    const uid = auth.userId();
    if (!uid || !content.trim()) return;
    const id = newId('material');
    await db.create(id, { owner: uid, course: courseId(), title: title || 'Notes', kind, content, status: 'pending' });
    await whenSynced(db);
    await reindexMaterial(db, id).catch((err) => setNotice(`${title}: ${err instanceof Error ? err.message : 'indexing failed'}`));
  }

  const removeMaterial = async (id: string, title: string) => {
    if (confirm(`Delete “${title}”? Its images and search index go with it.`)) await db.delete('material', id);
  };

  return (
    <Show when={course.data()} fallback={course.isLoading() ? <PageLoader /> : <div class="p-10 text-muted">Course not found.</div>}>
      {(c) => (
        <div
          ref={setPage}
          class="mx-auto w-full max-w-3xl px-4 sm:px-8"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
          }}
        >
          <HeaderTitle>
            <div class="flex min-w-0 items-center gap-2.5">
              <Folder
                size={20}
                stroke-width={1.6}
                class="h-[18px] w-[18px] shrink-0 sm:h-5 sm:w-5"
                style={{ color: courseColor(c().color) }}
                fill={courseColor(c().color)}
                fill-opacity="0.18"
                aria-hidden="true"
              />
              <EditableTitle value={c().title} onSave={(title) => db.update('course', c().id, { title })} />
            </div>
          </HeaderTitle>
          <HeaderEndActions>
            <AddMaterial onFiles={(files) => void addFiles(files)} onWrite={write} />
            <CourseSettings course={c()} />
          </HeaderEndActions>

          <Show when={c().description}>
            <p class="max-w-2xl break-words pt-3 text-[15px] leading-snug text-muted sm:pt-5 sm:text-[16px]">{c().description}</p>
          </Show>
          <div class="sticky top-0 z-10 -mx-3 mb-3 bg-surface px-3 pb-3 pt-3 sm:pt-5">
            <CourseSearch courseId={c().id} />
            {/* The list fades out as it slides under the search. */}
            <div
              class={`pointer-events-none absolute inset-x-0 top-full h-6 bg-linear-to-b from-surface to-surface/0 transition-opacity ${scrolled() ? 'opacity-100' : 'opacity-0'}`}
            />
          </div>

          {/* Materials */}
          <section class={`-mx-3 rounded-2xl ${dragging() ? 'ring-2 ring-blue/40' : ''}`}>
            <h2 class="px-3 pb-1 text-[13px] text-muted">Lecture material</h2>

            <Show when={notice()}>
              <p class="mx-3 mb-2 shrink-0 break-words rounded-xl bg-red-soft px-3.5 py-2.5 text-[14px] text-red">{notice()}</p>
            </Show>

            <Show when={writing()}>
              <TextMaterialForm
                onCancel={() => setWriting(false)}
                onSave={async (title, content) => {
                  setWriting(false);
                  await addText(title, content, 'markdown');
                }}
              />
            </Show>

            {/* Windowed and virtualized, scrolling with the page. */}
            <Show when={courseId()} keyed>
              {(id) => (
                <VirtualList
                  pageScroll
                  aria-label="Lecture material"
                  window={(page, size) => useQuery(() => qMaterialsPage(db, id, page, size), { deregisterOnCleanup: true })}
                  estimateSize={56}
                  key={(m) => m.id}
                  empty={
                    <div class="mx-3 mt-1 rounded-2xl border border-dashed border-line px-4 py-8 text-center sm:px-6 sm:py-10">
                      <p class="text-[15px] font-medium">
                        <span class="sm:hidden">No lecture material yet</span>
                        <span class="max-sm:hidden">Drop lecture files here</span>
                      </p>
                      <p class="mt-1 text-[14px] text-muted">
                        <span class="sm:hidden">Tap + to add PDF slides, Markdown or text notes</span>
                        <span class="max-sm:hidden">PDF slides and scripts, Markdown or text notes</span>
                      </p>
                    </div>
                  }
                >
                  {(m) => (
                    <div class="group flex items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-soft">
                      <span class="shrink-0 text-faint">
                        {m().kind === 'pdf' ? <FileType2 size={18} stroke-width={1.6} /> : <FileText size={18} stroke-width={1.6} />}
                      </span>
                      <A href={`/courses/${params.courseKey}/materials/${idKey(m().id)}`} class="min-w-0 flex-1">
                        <span class="block truncate text-[15px]">{m().title}</span>
                        <span class="mt-0.5 flex flex-wrap items-center gap-x-3">
                          <StatusText status={m().status} detail={m().status_detail} />
                          <Show when={m().page_count}>
                            <span class="text-[13px] text-faint">{m().page_count} pages</span>
                          </Show>
                          <Show when={m().status === 'ready' && m().chunk_count > 0}>
                            <span class="text-[13px] text-faint">
                              {(m().learned_through ?? -1) < 0
                                ? 'Not started'
                                : `Reached ${m().learned_through + 1} of ${m().chunk_count} sections`}
                            </span>
                          </Show>
                          <Show when={m().status === 'failed' && m().error}>
                            <span class="min-w-0 max-w-full truncate text-[13px] text-red sm:max-w-md" title={m().error ?? ''}>
                              {m().error}
                            </span>
                          </Show>
                        </span>
                      </A>
                      <IconButton
                        label={`Delete ${m().title}`}
                        size="sm"
                        class="shrink-0 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                        onClick={() => removeMaterial(m().id, m().title)}
                      >
                        <Trash2 size={16} stroke-width={1.75} />
                      </IconButton>
                    </div>
                  )}
                </VirtualList>
              )}
            </Show>
          </section>

          {/* The page's bottom space. */}
          <div class="h-16" aria-hidden="true" />
        </div>
      )}
    </Show>
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
        aria-label="Course name"
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

/** Upload files or write notes, from one button in the top bar. */
function AddMaterial(props: { onFiles: (files: FileList) => void; onWrite: () => void }) {
  const [open, setOpen] = createSignal(false);
  let input!: HTMLInputElement;
  const item = 'flex h-11 w-full items-center gap-2.5 rounded-xl px-3 text-[15px] hover:bg-soft md:h-10';
  return (
    <div class="relative">
      <Button variant="ghost" size="sm" class="max-sm:h-9 max-sm:w-9 max-sm:px-0" aria-label="Add material" aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Plus size={18} stroke-width={1.9} class="sm:h-4 sm:w-4" />
        <span class="hidden sm:inline">Add</span>
      </Button>
      {/* Outside the menu, so closing the menu cannot drop the file picker's result. */}
      <input
        ref={input}
        type="file"
        class="sr-only"
        tabindex="-1"
        multiple
        accept="application/pdf,.pdf,.md,.markdown,.txt,text/plain,text/markdown"
        onChange={(e) => {
          if (e.currentTarget.files?.length) props.onFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <Show when={open()}>
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div
          role="menu"
          class="absolute right-0 z-50 mt-2 w-56 rounded-2xl border border-line bg-surface p-1.5 shadow-card"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          <button
            type="button"
            role="menuitem"
            class={item}
            onClick={() => {
              setOpen(false);
              input.click();
            }}
          >
            <Upload size={16} stroke-width={1.75} class="text-muted" /> Upload files
          </button>
          <button
            type="button"
            role="menuitem"
            class={item}
            onClick={() => {
              setOpen(false);
              props.onWrite();
            }}
          >
            <PenLine size={16} stroke-width={1.75} class="text-muted" /> Write notes
          </button>
        </div>
      </Show>
    </div>
  );
}

function TextMaterialForm(props: { onSave: (title: string, content: string) => void; onCancel: () => void }) {
  const [title, setTitle] = createSignal('');
  const [content, setContent] = createSignal('');
  return (
    <form
      class="mx-3 mb-3 shrink-0 space-y-3 rounded-2xl bg-soft p-3"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave(title().trim(), content());
      }}
    >
      <input class={inputClass} placeholder="Title, e.g. Lecture 4 notes" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Title" required />
      <textarea
        class={`${inputClass} min-h-56 resize-y font-mono text-[16px] leading-relaxed sm:text-[13px]`}
        placeholder="Paste or write your notes. Markdown works: # headings, lists, $math$."
        value={content()}
        onInput={(e) => setContent(e.currentTarget.value)}
        aria-label="Content"
        required
      />
      <div class="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!title().trim() || !content().trim()}>
          Add material
        </Button>
      </div>
    </form>
  );
}

type CourseRow = TableModel<GetTable<typeof schema, 'course'>>;

/** The gear button in the top bar and the course settings dialog it opens. */
function CourseSettings(props: { course: CourseRow }) {
  const db = useDb<typeof schema>();
  const navigate = useNavigate();
  const save = (patch: Record<string, unknown>) => db.update('course', props.course.id, patch);
  const [open, setOpen] = createSignal(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        class="w-11 max-sm:h-9 max-sm:w-9 max-sm:px-0 sm:px-0 md:w-8"
        aria-label="Course settings"
        title="Course settings"
        onClick={() => setOpen(true)}
      >
        <Settings2 size={18} stroke-width={1.75} class="sm:h-4 sm:w-4" />
      </Button>
      <Show when={open()}>
        <Sheet title="Course settings" maxWidth="28rem" onClose={() => setOpen(false)}>
          {(close) => (
            <div class="space-y-4">
              <Field label="The tutor speaks">
                <select class={inputClass} value={props.course.language} onChange={(e) => save({ language: e.currentTarget.value })}>
                  <For each={LANGUAGES}>{(l) => <option value={l.code}>{l.label}</option>}</For>
                </select>
              </Field>
              <Field label="Notes for the tutor" hint="ChatGPT follows them in every study session of this course.">
                <textarea
                  class={`${inputClass} min-h-24 resize-y text-[16px] sm:text-[14px]`}
                  placeholder="e.g. The exam is oral. Push me on proofs."
                  value={props.course.tutor_notes ?? ''}
                  onChange={(e) => save({ tutor_notes: e.currentTarget.value.trim() || undefined })}
                />
              </Field>
              <Field label="Description">
                <textarea
                  class={`${inputClass} min-h-16 resize-y text-[16px] sm:text-[14px]`}
                  value={props.course.description ?? ''}
                  onChange={(e) => save({ description: e.currentTarget.value.trim() || undefined })}
                />
              </Field>
              <div>
                <span class="mb-1.5 block text-[13px] text-muted">Color</span>
                <div class="flex flex-wrap gap-1">
                  <For each={Object.keys(COURSE_COLORS) as CourseColor[]}>
                    {(key) => (
                      <button
                        type="button"
                        aria-label={key}
                        aria-pressed={props.course.color === key}
                        onClick={() => save({ color: key })}
                        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
                      >
                        <span class={`h-7 w-7 rounded-full ring-offset-2 ring-offset-surface ${props.course.color === key ? 'ring-2 ring-fg' : ''}`} style={{ background: COURSE_COLORS[key] }} />
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                class="-ml-3 text-red"
                onClick={async () => {
                  if (confirm(`Delete “${props.course.title}” with all its material and study sessions? This cannot be undone.`)) {
                    close();
                    await db.delete('course', props.course.id);
                    navigate('/');
                  }
                }}
              >
                Delete course
              </Button>
            </div>
          )}
        </Sheet>
      </Show>
    </>
  );
}
