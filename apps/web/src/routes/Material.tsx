import { A, useNavigate, useParams } from '@solidjs/router';
import { createMemo, createSignal, Show } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { ArrowLeft, Pencil, PhoneCall } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { reindexMaterial } from '../lib/api';
import { whenSynced } from '../lib/ids';
import { renderMarkdown } from '../lib/markdown';
import { qMaterial } from '../lib/query';
import { Button, inputClass, StatusBadge } from '../components/ui';

export default function MaterialPage() {
  const params = useParams();
  const db = useDb<typeof schema>();
  const navigate = useNavigate();
  const materialId = () => `material:${params.materialKey}`;
  const material = useQuery(() => qMaterial(db, materialId()));

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

  return (
    <Show when={material.data()} fallback={<div class="p-10 text-pencil">{material.isLoading() ? '' : 'Material not found.'}</div>}>
      {(m) => (
        <div>
          <div class="sticky top-0 z-10 bg-paper/90 backdrop-blur border-b border-rule px-6 sm:px-10 py-3 flex flex-wrap items-center gap-3">
            <A href={`/courses/${params.courseKey}`} class="inline-flex items-center gap-1.5 text-sm text-pencil hover:text-graphite">
              <ArrowLeft size={16} /> Course
            </A>
            <span class="ml-2">
              <StatusBadge status={m().status} detail={m().status_detail} />
            </span>
            <div class="ml-auto flex gap-2">
              <Show
                when={editing()}
                fallback={
                  <>
                    <Button variant="quiet" size="sm" onClick={edit}>
                      <Pencil size={14} /> Edit
                    </Button>
                    <Button
                      variant="call"
                      size="sm"
                      disabled={m().status !== 'ready'}
                      onClick={() => navigate(`/courses/${params.courseKey}/call?mode=explain&material=${params.materialKey}`)}
                    >
                      <PhoneCall size={14} /> Call about this
                    </Button>
                  </>
                }
              >
                <Button variant="quiet" size="sm" onClick={() => setEditing(false)}>
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
              <article class="margin-line px-6 sm:pl-14 sm:pr-10 py-10">
                <h1 class="text-3xl font-bold leading-tight mb-2 max-w-[68ch]">{m().title}</h1>
                <p class="text-sm text-pencil mb-8">
                  {[m().source_name, m().page_count ? `${m().page_count} pages` : null, m().image_count ? `${m().image_count} images` : null]
                    .filter(Boolean)
                    .join(', ')}
                </p>
                <Show
                  when={m().content.trim()}
                  fallback={
                    <p class="text-pencil">
                      {m().status === 'failed'
                        ? `Processing failed: ${m().error ?? 'unknown error'}. Upload the file again to retry.`
                        : 'The PDF is being converted. The text appears here when it is done.'}
                    </p>
                  }
                >
                  <div class="lecture" innerHTML={html()} />
                </Show>
              </article>
            }
          >
            <div class="px-6 sm:px-10 py-8 space-y-3">
              <input class={`${inputClass} text-lg font-bold`} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Title" />
              <textarea
                class={`${inputClass} font-mono text-sm leading-relaxed min-h-[70vh]`}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                aria-label="Content (Markdown)"
              />
              <p class="text-xs text-pencil">
                Markdown. Saving rebuilds the search index the tutor uses. Images look like ![caption](asset:…); keep those lines to keep the
                image.
              </p>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
