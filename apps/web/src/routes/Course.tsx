import { A, useNavigate, useParams } from '@solidjs/router';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { type GetTable, type TableModel, useDb, useQuery } from '@spooky-sync/client-solid';
import { ChevronDown, FileText, FileType2, PenLine, PhoneCall, Settings2, Trash2, Upload } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { useAuth } from '../lib/auth';
import { ApiError, reindexMaterial, uploadPdf, type CallMode } from '../lib/api';
import { idKey, newId, whenSynced } from '../lib/ids';
import { MODES, modeLabel } from '../lib/modes';
import { COURSE_COLORS, courseColor, LANGUAGES, type CourseColor } from '../lib/palette';
import { qCalls, qCourse, qMaterials } from '../lib/query';
import { Button, buttonClass, Card, Dot, Field, formatDate, IconButton, inputClass, Segmented, StatusText } from '../components/ui';
import { PillSelect } from './Home';

export default function CoursePage() {
  const params = useParams();
  const db = useDb<typeof schema>();
  const auth = useAuth();
  const navigate = useNavigate();
  const courseId = () => `course:${params.courseKey}`;

  const course = useQuery(() => qCourse(db, courseId()));
  const materials = useQuery(() => qMaterials(db, courseId()));
  const calls = useQuery(() => qCalls(db, courseId()));

  const [mode, setMode] = createSignal<CallMode>('explain');
  const [scope, setScope] = createSignal<string>('');
  const [writing, setWriting] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);

  const ready = createMemo(() => (materials.data() ?? []).filter((m) => m.status === 'ready'));
  const titleOf = (materialId: string | null | undefined) =>
    (materials.data() ?? []).find((m) => m.id === materialId)?.title ?? 'Whole course';

  const startCall = () => {
    const q = new URLSearchParams({ mode: mode() });
    if (scope()) q.set('material', scope());
    navigate(`/courses/${params.courseKey}/call?${q}`);
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
    <Show when={course.data()} fallback={<div class="p-10 text-muted">{course.isLoading() ? '' : 'Course not found.'}</div>}>
      {(c) => (
        <div
          class="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-10"
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
          <header class="mb-6 flex items-start gap-3 sm:mb-8 sm:gap-4">
            <span
              class="mt-1.5 h-3 w-3 shrink-0 rounded-full"
              style={{ background: courseColor(c().color) }}
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1">
              <EditableTitle value={c().title} onSave={(title) => db.update('course', c().id, { title })} />
              <Show when={c().description}>
                <p class="mt-1.5 max-w-2xl break-words text-[16px] text-muted">{c().description}</p>
              </Show>
            </div>
          </header>

          <div class="grid gap-6 xl:grid-cols-[1fr_24rem]">
            <div class="min-w-0 space-y-6">
              {/* Materials */}
              <Card class={dragging() ? 'ring-2 ring-blue/40' : ''}>
                <div class="flex flex-wrap items-center gap-2 px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
                  <h2 class="mr-auto w-full text-[16px] font-semibold sm:w-auto">Lecture material</h2>
                  <label class={`${buttonClass('soft', 'sm')} cursor-pointer`}>
                    <Upload size={15} stroke-width={1.75} /> Upload
                    <input
                      type="file"
                      class="sr-only"
                      multiple
                      accept="application/pdf,.pdf,.md,.markdown,.txt,text/plain,text/markdown"
                      onChange={(e) => {
                        if (e.currentTarget.files) void addFiles(e.currentTarget.files);
                        e.currentTarget.value = '';
                      }}
                    />
                  </label>
                  <Button variant="soft" size="sm" onClick={() => setWriting(!writing())}>
                    <PenLine size={15} stroke-width={1.75} /> Write
                  </Button>
                </div>

                <Show when={notice()}>
                  <p class="mx-4 mb-3 break-words rounded-xl bg-red-soft px-3.5 py-2.5 text-[14px] text-red sm:mx-5">{notice()}</p>
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

                <ul class="px-2 pb-2">
                  <For
                    each={materials.data() ?? []}
                    fallback={
                      <li class="mx-2 mb-2 rounded-2xl border border-dashed border-line-strong px-4 py-9 text-center sm:mx-3 sm:mb-3 sm:px-6 sm:py-12">
                        <p class="text-[15px] font-medium">Drop lecture files here</p>
                        <p class="mt-1 text-[14px] text-muted">PDF slides and scripts, Markdown or text notes</p>
                      </li>
                    }
                  >
                    {(m) => (
                      <li class="group flex items-center gap-2.5 rounded-2xl px-2 py-3 hover:bg-soft sm:gap-3 sm:px-3 sm:py-2.5">
                        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-soft text-muted group-hover:bg-surface">
                          {m.kind === 'pdf' ? <FileType2 size={18} stroke-width={1.6} /> : <FileText size={18} stroke-width={1.6} />}
                        </span>
                        <A href={`/courses/${params.courseKey}/materials/${idKey(m.id)}`} class="min-w-0 flex-1">
                          <span class="block truncate text-[15px] font-medium">{m.title}</span>
                          <span class="mt-0.5 flex flex-wrap items-center gap-x-3">
                            <StatusText status={m.status} detail={m.status_detail} />
                            <Show when={m.page_count}>
                              <span class="text-[13px] text-faint">{m.page_count} pages</span>
                            </Show>
                            <Show when={m.status === 'failed' && m.error}>
                              <span class="min-w-0 max-w-full truncate text-[13px] text-red sm:max-w-md" title={m.error ?? ''}>
                                {m.error}
                              </span>
                            </Show>
                          </span>
                        </A>
                        <IconButton
                          label={`Delete ${m.title}`}
                          size="sm"
                          class="shrink-0 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                          onClick={() => removeMaterial(m.id, m.title)}
                        >
                          <Trash2 size={16} stroke-width={1.75} />
                        </IconButton>
                      </li>
                    )}
                  </For>
                </ul>
              </Card>

              {/* Past calls */}
              <Show when={(calls.data() ?? []).length > 0}>
                <Card>
                  <h2 class="px-5 pb-2 pt-5 text-[16px] font-semibold">Past calls</h2>
                  <ul class="px-2 pb-2">
                    <For each={calls.data() ?? []}>
                      {(call) => (
                        <li>
                          <A href={`/calls/${idKey(call.id)}`} class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-2xl px-3 py-3 hover:bg-soft sm:flex sm:gap-3 sm:py-2.5">
                            <Dot tone={call.status === 'ended' ? 'idle' : 'running'} class="row-span-2 mx-1" />
                            <span class="min-w-0 flex-1 truncate text-[15px]">
                              {modeLabel(call.mode)}: {titleOf(call.material)}
                            </span>
                            <span class="col-start-2 shrink-0 text-[13px] text-muted">{formatDate(call.started_at, true)}</span>
                          </A>
                        </li>
                      )}
                    </For>
                  </ul>
                </Card>
              </Show>
            </div>

            {/* Call card and course settings */}
            <aside class="min-w-0 space-y-6">
              <Card class="p-4 sm:p-5">
                <div class="flex items-center gap-3">
                  <PhoneCall size={20} stroke-width={1.75} class="text-muted" />
                  <h2 class="flex-1 text-[16px] font-semibold">Call the tutor</h2>
                  <Dot tone={ready().length ? 'ready' : 'idle'} />
                </div>
                <p class="mt-2 text-[15px] leading-relaxed text-muted sm:mt-1.5 sm:pl-8">{MODES.find((m) => m.value === mode())?.hint}</p>
                <div class="mt-4 space-y-3 sm:pl-8">
                  <Segmented label="Kind of call" value={mode()} onChange={setMode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
                  <PillSelect
                    class="w-full sm:w-auto"
                    label="About"
                    icon={<FileText size={16} stroke-width={1.75} />}
                    value={scope()}
                    onChange={setScope}
                    options={[{ value: '', label: 'The whole course' }, ...ready().map((m) => ({ value: idKey(m.id), label: m.title }))]}
                  />
                </div>
                <div class="mt-5 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:pl-8">
                  <Button class="sm:shrink-0" disabled={ready().length === 0} onClick={startCall}>
                    Start call
                  </Button>
                  <Show when={ready().length === 0}>
                    <span class="text-[13px] text-muted">Needs material that is ready</span>
                  </Show>
                </div>
              </Card>

              <CourseSettings course={c()} />
            </aside>
          </div>
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
        <h1 class="cursor-text break-words text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]" onClick={() => setEditing(true)} title="Click to rename">
          {props.value}
        </h1>
      }
    >
      <input
        class="-mx-2 w-full min-w-0 max-w-2xl rounded-xl bg-soft px-2 text-[28px] font-semibold leading-tight tracking-tight outline-none sm:text-[30px]"
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

function TextMaterialForm(props: { onSave: (title: string, content: string) => void; onCancel: () => void }) {
  const [title, setTitle] = createSignal('');
  const [content, setContent] = createSignal('');
  return (
    <form
      class="mx-4 mb-4 space-y-3 rounded-2xl bg-soft p-3 sm:mx-5"
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

function CourseSettings(props: { course: CourseRow }) {
  const db = useDb<typeof schema>();
  const navigate = useNavigate();
  const save = (patch: Record<string, unknown>) => db.update('course', props.course.id, patch);

  return (
    <Card>
      <details class="group">
        <summary class="flex cursor-pointer list-none items-center gap-3 px-5 py-4 select-none">
          <Settings2 size={20} stroke-width={1.75} class="text-muted" />
          <span class="flex-1 text-[16px] font-semibold">Tutor settings</span>
          <ChevronDown size={18} class="text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div class="space-y-4 px-5 pb-5">
          <Field label="The tutor speaks">
            <select class={inputClass} value={props.course.language} onChange={(e) => save({ language: e.currentTarget.value })}>
              <For each={LANGUAGES}>{(l) => <option value={l.code}>{l.label}</option>}</For>
            </select>
          </Field>
          <Field label="Notes for the tutor" hint="Applied to every call in this course.">
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
              if (confirm(`Delete “${props.course.title}” with all its material and calls? This cannot be undone.`)) {
                await db.delete('course', props.course.id);
                navigate('/');
              }
            }}
          >
            Delete course
          </Button>
        </div>
      </details>
    </Card>
  );
}
