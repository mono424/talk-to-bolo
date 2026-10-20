import { A, useParams } from '@solidjs/router';
import { createMemo, createSignal, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ArrowLeft, Pencil, PhoneCall } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { reindexMaterial } from '../lib/api';
import { whenSynced } from '../lib/ids';
import { renderMarkdown } from '../lib/markdown';
import { qCourse, qMaterial } from '../lib/query';
import { Button, buttonClass, inputClass, StatusText } from '../components/ui';

export default function MaterialPage() {
  const params = useParams();
  const db = useDb<typeof schema>();
  const material = useQuery(() => qMaterial(db, `material:${params.materialKey}`));
  const course = useQuery(() => qCourse(db, `course:${params.courseKey}`));

  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [title, setTitle] = createSignal('');
  const [saving, setSaving] = createSignal(false);

  const html = createMemo(() => renderMarkdown(material.data()?.content ?? ''));

  const edit = () => {
    setDraft(material.data()?.content ?? '');
    setTitle(material.data()?.title ?? '');
    setEditing(true);
  };

  const save = async () => {
    const m = material.data();
    if (!m) return;
    setSaving(true);
    try {
      const contentChanged = draft() !== m.content;
      await db.update('material', m.id, { title: title().trim() || m.title, ...(contentChanged ? { content: draft() } : {}) });
      setEditing(false);
      if (contentChanged) {
        await whenSynced(db);
        await reindexMaterial(db, m.id);
      }
    } finally {
      setSaving(false);
    }
  };

  const meta = () => {
    const m = material.data();
    if (!m) return '';
    return [m.source_name, m.page_count ? `${m.page_count} pages` : null, m.image_count ? `${m.image_count} images` : null]
      .filter(Boolean)
      .join(', ');
  };

  return (
    <Show when={material.data()} fallback={<div class="p-10 text-muted">{material.isLoading() ? '' : 'Material not found.'}</div>}>
      {(m) => (
        <div class="min-h-full">
          <div class="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface/85 px-4 py-3 backdrop-blur sm:px-6">
            <A href={`/courses/${params.courseKey}`} class={`${buttonClass('ghost', 'sm')} -ml-1 text-muted`}>
              <ArrowLeft size={16} stroke-width={1.75} /> {course.data()?.title ?? 'Course'}
            </A>
            <span class="ml-1">
              <StatusText status={m().status} detail={m().status_detail} />
            </span>
            <div class="ml-auto flex gap-2">
              <Show
                when={editing()}
                fallback={
                  <>
                    <Button variant="soft" size="sm" onClick={edit}>
                      <Pencil size={14} stroke-width={1.75} /> Edit
                    </Button>
                    <Show
                      when={m().status === 'ready'}
                      fallback={
                        <Button size="sm" disabled>
                          <PhoneCall size={14} stroke-width={1.9} /> Call about this
                        </Button>
                      }
                    >
                      <A href={`/courses/${params.courseKey}/call?mode=explain&material=${params.materialKey}`} class={buttonClass('solid', 'sm')}>
                        <PhoneCall size={14} stroke-width={1.9} /> Call about this
                      </A>
                    </Show>
                  </>
                }
              >
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={saving()} onClick={save}>
                  {saving() ? 'Saving…' : 'Save'}
                </Button>
              </Show>
            </div>
          </div>

          <Show
            when={editing()}
            fallback={
              <article class="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8">
                <h1 class="text-[30px] font-semibold leading-tight tracking-tight">{m().title}</h1>
                <Show when={meta()}>
                  <p class="mt-1.5 text-[14px] text-muted">{meta()}</p>
                </Show>
                <div class="mt-8">
                  <Show
                    when={m().content.trim()}
                    fallback={
                      <p class="text-muted">
                        {m().status === 'failed'
                          ? `Processing failed: ${m().error ?? 'unknown error'}. Upload the file again to retry.`
                          : 'The PDF is being converted. The text appears here when it is done.'}
                      </p>
                    }
                  >
                    <div class="lecture" innerHTML={html()} />
                  </Show>
                </div>
              </article>
            }
          >
            <div class="mx-auto w-full max-w-4xl space-y-3 px-5 py-8 sm:px-8">
              <input class={`${inputClass} text-[18px] font-semibold`} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Title" />
              <textarea
                class={`${inputClass} min-h-[70vh] font-mono text-[13px] leading-relaxed`}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                aria-label="Content (Markdown)"
              />
              <p class="text-[13px] text-muted">
                Markdown. Saving rebuilds the search index the tutor uses. Images look like ![caption](asset:…); keep those lines to keep the image.
              </p>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
