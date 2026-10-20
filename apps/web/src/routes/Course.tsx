import { A, useNavigate, useParams } from '@solidjs/router';
import { createSignal, For, Show } from 'solid-js';
import { type GetTable, type TableModel, useDb, useQuery } from '@spooky-sync/client-solid';
import { FileText, FileType2, PhoneCall, Trash2, Upload } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { useAuth } from '../lib/auth';
import { reindexMaterial, uploadPdf, type CallMode } from '../lib/api';
import { idKey, newId, whenSynced } from '../lib/ids';
import { COURSE_COLORS, courseColor, LANGUAGES, type CourseColor } from '../lib/palette';
import { qCalls, qCourse, qMaterials } from '../lib/query';
import { Button, Field, formatDate, inputClass, StatusBadge } from '../components/ui';

export const MODES: { value: CallMode; label: string; hint: string }[] = [
  { value: 'explain', label: 'Explain it', hint: 'The tutor walks you through the lecture and checks in as you go.' },
  { value: 'quiz', label: 'Quiz me', hint: 'One question at a time, getting harder, with feedback on every answer.' },
  { value: 'qa', label: 'I ask', hint: 'You lead with questions, the tutor answers from your material.' },
];

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

  const ready = () => (materials.data() ?? []).filter((m) => m.status === 'ready');

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
            // The API marks the material failed when it refuses the file;
            // this covers the request itself failing.
            setNotice(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
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
    <Show when={course.data()} fallback={<div class="p-10 text-pencil">{course.isLoading() ? '' : 'Course not found.'}</div>}>
      {(c) => (
        <div
          class="min-h-screen"
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
          <header class="px-6 sm:px-10 pt-10 pb-6 border-b border-rule" style={{ 'box-shadow': `inset 0 4px 0 0 ${courseColor(c().color)}` }}>
            <EditableTitle value={c().title} onSave={(title) => db.update('course', c().id, { title })} />
            <Show when={c().description}>
              <p class="mt-2 text-pencil max-w-2xl">{c().description}</p>
            </Show>
          </header>

          <div class="px-6 sm:px-10 py-8 grid gap-10 xl:grid-cols-[1fr_22rem]">
            <div class="min-w-0 space-y-10">
              {/* Materials */}
              <section aria-labelledby="materials-heading">
                <div class="flex flex-wrap items-center gap-3 mb-4">
                  <h2 id="materials-heading" class="text-lg font-bold mr-auto">
                    Lecture material
                  </h2>
                  <label class="inline-flex items-center gap-2 cursor-pointer text-sm px-3 py-1.5 rounded-md border border-rule hover:bg-rule-soft">
                    <Upload size={16} /> Upload files
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
                  <Button variant="quiet" size="sm" onClick={() => setWriting(!writing())}>
                    <FileText size={16} /> Write or paste
                  </Button>
                </div>

                <Show when={notice()}>
                  <p class="text-sm text-margin mb-3">{notice()}</p>
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

                <div class={`rounded-xl border ${dragging() ? 'border-ink border-dashed bg-rule-soft' : 'border-rule bg-sheet'}`}>
                  <For
                    each={materials.data() ?? []}
                    fallback={
                      <div class="ruled px-6 py-10 text-center text-pencil">
                        <p class="font-bold text-graphite mb-1">No material yet</p>
                        <p class="text-sm">Drop lecture PDFs, Markdown or text files here, or write notes directly.</p>
                      </div>
                    }
                  >
                    {(m) => (
                      <div class="flex items-center gap-4 px-4 py-3 border-b border-rule-soft last:border-b-0">
                        <span class="text-pencil shrink-0" aria-hidden="true">
                          {m.kind === 'pdf' ? <FileType2 size={20} /> : <FileText size={20} />}
                        </span>
                        <div class="min-w-0 flex-1">
                          <A
                            href={`/courses/${params.courseKey}/materials/${idKey(m.id)}`}
                            class="font-medium hover:text-ink truncate block"
                          >
                            {m.title}
                          </A>
                          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                            <StatusBadge status={m.status} detail={m.status_detail} />
                            <Show when={m.status === 'failed' && m.error}>
                              <span class="text-xs text-margin truncate max-w-md" title={m.error ?? ''}>
                                {m.error}
                              </span>
                            </Show>
                            <Show when={m.page_count}>
                              <span class="text-xs text-pencil">{m.page_count} pages</span>
                            </Show>
                            <Show when={m.status === 'ready'}>
                              <span class="text-xs text-pencil">{m.chunk_count} sections indexed</span>
                            </Show>
                          </div>
                        </div>
                        <button
                          type="button"
                          class="p-2 rounded-md text-pencil hover:text-margin hover:bg-rule-soft"
                          aria-label={`Delete ${m.title}`}
                          onClick={() => removeMaterial(m.id, m.title)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </section>

              {/* Past calls */}
              <Show when={(calls.data() ?? []).length > 0}>
                <section aria-labelledby="calls-heading">
                  <h2 id="calls-heading" class="text-lg font-bold mb-4">
                    Past calls
                  </h2>
                  <ul class="rounded-xl border border-rule bg-sheet">
                    <For each={calls.data() ?? []}>
                      {(call) => (
                        <li class="border-b border-rule-soft last:border-b-0">
                          <A href={`/calls/${idKey(call.id)}`} class="flex items-center gap-4 px-4 py-3 hover:bg-rule-soft">
                            <PhoneCall size={16} class="text-pencil shrink-0" />
                            <span class="font-medium">{MODES.find((x) => x.value === call.mode)?.label}</span>
                            <span class="text-sm text-pencil truncate">
                              {(materials.data() ?? []).find((m) => m.id === call.material)?.title ?? 'Whole course'}
                            </span>
                            <span class="ml-auto text-sm text-pencil shrink-0">{formatDate(call.started_at, true)}</span>
                          </A>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
            </div>

            {/* Call launcher + course settings */}
            <aside class="space-y-8">
              <section aria-labelledby="call-heading" class="rounded-xl border border-rule bg-sheet p-5">
                <h2 id="call-heading" class="text-lg font-bold mb-4">
                  Call the tutor
                </h2>
                <div role="radiogroup" aria-label="What should the call be?" class="space-y-2 mb-5">
                  <For each={MODES}>
                    {(m) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={mode() === m.value}
                        onClick={() => setMode(m.value)}
                        class={`w-full text-left rounded-lg border px-3 py-2.5 ${mode() === m.value ? 'border-ink bg-rule-soft' : 'border-rule hover:bg-rule-soft'}`}
                      >
                        <span class="block font-bold text-[15px]">{m.label}</span>
                        <span class="block text-sm text-pencil leading-snug mt-0.5">{m.hint}</span>
                      </button>
                    )}
                  </For>
                </div>
                <Field label="About" class="mb-5">
                  <select class={inputClass} value={scope()} onChange={(e) => setScope(e.currentTarget.value)}>
                    <option value="">The whole course</option>
                    <For each={ready()}>{(m) => <option value={idKey(m.id)}>{m.title}</option>}</For>
                  </select>
                </Field>
                <Button variant="call" size="lg" class="w-full" disabled={ready().length === 0} onClick={startCall}>
                  <PhoneCall size={18} /> Start call
                </Button>
                <Show when={ready().length === 0}>
                  <p class="text-xs text-pencil mt-3">Calls start once some material is ready.</p>
                </Show>
              </section>

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
        <h1 class="text-3xl font-bold leading-tight cursor-text" onClick={() => setEditing(true)} title="Click to rename">
          {props.value}
        </h1>
      }
    >
      <input
        class="text-3xl font-bold leading-tight bg-transparent border-b-2 border-ink outline-none w-full max-w-2xl"
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
      class="rounded-xl border border-rule bg-sheet p-4 mb-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave(title().trim(), content());
      }}
    >
      <input class={inputClass} placeholder="Title, e.g. Lecture 4 notes" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Title" required />
      <textarea
        class={`${inputClass} font-mono text-sm min-h-56`}
        placeholder="Paste or write your notes. Markdown works: # headings, lists, $math$."
        value={content()}
        onInput={(e) => setContent(e.currentTarget.value)}
        aria-label="Content"
        required
      />
      <div class="flex gap-2 justify-end">
        <Button variant="quiet" size="sm" onClick={props.onCancel}>
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
    <details class="rounded-xl border border-rule bg-sheet group">
      <summary class="cursor-pointer select-none px-5 py-4 font-bold list-none flex items-center justify-between">
        Tutor settings
        <span class="text-pencil text-sm font-normal group-open:hidden">Language, notes, color</span>
      </summary>
      <div class="px-5 pb-5 space-y-4">
        <Field label="The tutor speaks">
          <select class={inputClass} value={props.course.language} onChange={(e) => save({ language: e.currentTarget.value })}>
            <For each={LANGUAGES}>{(l) => <option value={l.code}>{l.label}</option>}</For>
          </select>
        </Field>
        <Field label="Notes for the tutor" hint="Applied to every call in this course.">
          <textarea
            class={`${inputClass} min-h-24 text-sm`}
            placeholder="e.g. The exam is oral. Push me on proofs."
            value={props.course.tutor_notes ?? ''}
            onChange={(e) => save({ tutor_notes: e.currentTarget.value.trim() || undefined })}
          />
        </Field>
        <Field label="Description">
          <textarea
            class={`${inputClass} min-h-16 text-sm`}
            value={props.course.description ?? ''}
            onChange={(e) => save({ description: e.currentTarget.value.trim() || undefined })}
          />
        </Field>
        <div>
          <span class="block text-sm font-medium mb-1.5">Color</span>
          <div class="flex gap-2">
            <For each={Object.keys(COURSE_COLORS) as CourseColor[]}>
              {(key) => (
                <button
                  type="button"
                  aria-label={key}
                  aria-pressed={props.course.color === key}
                  onClick={() => save({ color: key })}
                  class={`h-7 w-7 rounded-full border-2 ${props.course.color === key ? 'border-graphite' : 'border-transparent'}`}
                  style={{ background: COURSE_COLORS[key] }}
                />
              )}
            </For>
          </div>
        </div>
        <button
          type="button"
          class="text-sm text-margin hover:underline"
          onClick={async () => {
            if (confirm(`Delete “${props.course.title}” with all its material and calls? This cannot be undone.`)) {
              await db.delete('course', props.course.id);
              navigate('/');
            }
          }}
        >
          Delete course
        </button>
      </div>
    </details>
  );
}
