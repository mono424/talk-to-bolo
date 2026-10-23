import { useParams, useSearchParams } from '@solidjs/router';
import { createEffect, createMemo, createSignal, Show, type JSX } from 'solid-js';
import { useDb, useQuery } from '@spooky-sync/client-solid';
import { Pencil } from 'lucide-solid';
import type { schema } from '../schema.gen';
import { PROGRESS_JOB, reindexMaterial, saveLectureProgress } from '../lib/jobs';
import { chunkMarkdown, chunkPages } from '../../../../shared/lecture';
import { idString, whenSynced } from '../lib/ids';
import { renderMarkdown } from '../lib/markdown';
import { firstRow, qMaterial, qMaterialJobs } from '../lib/query';
import { Button, inputClass, StatusText } from '../components/ui';
import { HeaderActions, SideActions } from '../components/HeaderSlot';
import { LecturePlace } from '../components/LecturePlace';
import { PdfViewer } from '../components/PdfViewer';

export default function MaterialPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const db = useDb<typeof schema>();
  const material = firstRow(useQuery(() => qMaterial(db, `material:${params.materialKey}`)));
  // The latest progress saves, to see whether the one just sent failed.
  const progressJobs = useQuery(() => qMaterialJobs(db, `material:${params.materialKey}`, PROGRESS_JOB));
  // A PDF shows the original; its text is derived from it, for the tutor and search.
  const isPdf = () => material.data()?.kind === 'pdf';
  // ?page=N from a citation link.
  const page = () => Number(Array.isArray(search.page) ? search.page[0] : search.page) || null;

  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [title, setTitle] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [progressThrough, setProgressThrough] = createSignal<number | null>(null);
  // The job saving the place, until it succeeds or fails.
  const [progressJob, setProgressJob] = createSignal<string | null>(null);
  const [progressError, setProgressError] = createSignal<string | null>(null);

  const html = createMemo(() => renderMarkdown(material.data()?.content ?? ''));
  const sections = createMemo(() => chunkMarkdown(material.data()?.content ?? ''));
  const sectionPages = createMemo(() => chunkPages(material.data()?.content ?? '', sections()));
  const progressVersion = createMemo(() => {
    const m = material.data();
    return m ? `${m.id}:${m.index_rev}:${m.learned_through}` : '';
  });
  createEffect(() => {
    progressVersion();
    setProgressThrough(null);
    setProgressError(null);
    setProgressJob(null);
  });
  const selectedThrough = () => progressThrough() ?? material.data()?.learned_through ?? -1;
  createEffect(() => {
    const id = progressJob();
    const job = id ? progressJobs.data()?.find((j) => idString(j.id) === id) : undefined;
    if (job?.status === 'success') setProgressJob(null);
    if (job?.status === 'failed') {
      setProgressJob(null);
      setProgressThrough(null);
      setProgressError('Progress could not be saved. Reload the lecture and try again.');
    }
  });

  // Shown until the saved place syncs back; a failed save falls back to it.
  const saveProgress = async (through: number) => {
    const m = material.data();
    if (!m) return;
    setProgressThrough(through);
    setProgressError(null);
    try {
      setProgressJob(await saveLectureProgress(db, m.id, { through, rev: m.index_rev }));
    } catch (err) {
      setProgressThrough(null);
      setProgressError(err instanceof Error ? err.message : 'Progress could not be saved. Try again.');
    }
  };

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
      const contentChanged = m.kind !== 'pdf' && draft() !== m.content;
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

  const place = (cls?: string): JSX.Element => (
    <Show when={material.data()?.status === 'ready' && sections().length > 0}>
      <LecturePlace
        class={cls}
        sections={sections()}
        pages={sectionPages()}
        value={selectedThrough()}
        saving={progressJob() !== null}
        disabled={sections().length !== material.data()?.chunk_count}
        error={progressError()}
        onChange={saveProgress}
      />
    </Show>
  );

  return (
    <Show when={material.data()} fallback={<div class="p-10 text-muted">{material.isLoading() ? '' : 'Material not found.'}</div>}>
      {(m) => (
        <div class="min-h-full min-w-0">
          <HeaderActions>
            {/* Lined up with the lecture column below it (the editor is wider). */}
            <div class="header-column flex min-w-0 flex-1 items-center gap-2" style={{ '--page-column': editing() ? '56rem' : isPdf() ? '64rem' : '48rem' }}>
              <span class="pointer-events-auto hidden min-w-0 truncate md:inline-flex">
                <StatusText status={m().status} detail={m().status_detail} />
              </span>
              <div class="pointer-events-auto ml-auto flex shrink-0 items-center gap-2">
                <Show
                  when={editing()}
                  fallback={
                    <Button variant="soft" size="sm" class="max-sm:w-11 max-sm:px-0" onClick={edit} aria-label={isPdf() ? 'Rename' : 'Edit'}>
                      <Pencil size={14} stroke-width={1.75} /> <span class="hidden sm:inline">{isPdf() ? 'Rename' : 'Edit'}</span>
                    </Button>
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
          </HeaderActions>
          {/* Wide windows keep the reading place in the recent sessions column; narrower ones under the title. */}
          <Show when={!editing()}>
            <SideActions>{place()}</SideActions>
          </Show>

          <Show
            when={editing()}
            fallback={
              <article class={`mx-auto w-full min-w-0 px-4 pb-12 pt-6 sm:px-8 sm:pt-5 ${isPdf() ? 'max-w-5xl' : 'max-w-3xl'}`}>
                <h1 class="break-words text-[28px] font-semibold leading-tight tracking-tight sm:text-[30px]">{m().title}</h1>
                <Show when={meta()}>
                  <p class="mt-1.5 break-words text-[14px] text-muted">{meta()}</p>
                </Show>
                <div class="mt-2 md:hidden">
                  <StatusText status={m().status} detail={m().status_detail} />
                </div>
                {place('mt-4 max-w-sm xl:hidden')}
                <div class="mt-8">
                  <Show
                    when={isPdf()}
                    fallback={
                      <Show
                        when={m().content.trim()}
                        fallback={
                          <p class="break-words text-muted">
                            {m().status === 'failed' ? `Processing failed: ${m().error ?? 'unknown error'}. Upload the file again to retry.` : ''}
                          </p>
                        }
                      >
                        <div class="lecture" innerHTML={html()} />
                      </Show>
                    }
                  >
                    <Show when={m().status === 'failed'}>
                      <p class="mb-4 break-words text-[14px] text-muted" role="alert">
                        {`Processing failed: ${m().error ?? 'unknown error'}. Upload the file again as new material to retry.`}
                      </p>
                    </Show>
                    {/* The PDF is stored before it is converted, so it can be read right away. */}
                    <Show
                      when={m().source_size}
                      fallback={<p class="break-words text-muted">{m().status === 'failed' ? '' : 'Uploading the PDF…'}</p>}
                    >
                      <PdfViewer materialId={m().id} size={m().source_size} fileName={m().source_name} page={page()} />
                    </Show>
                  </Show>
                </div>
              </article>
            }
          >
            <div class="mx-auto w-full min-w-0 max-w-4xl space-y-3 px-4 py-6 sm:px-8 sm:pb-8 sm:pt-5">
              <input class={`${inputClass} text-[18px] font-semibold`} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Title" />
              <Show
                when={!isPdf()}
                fallback={<p class="text-[13px] text-muted">The PDF is kept as uploaded. Its text comes from the file, so only the title can change.</p>}
              >
                <textarea
                  class={`${inputClass} min-h-[65dvh] resize-y font-mono text-[16px] leading-relaxed sm:min-h-[70vh] sm:text-[13px]`}
                  value={draft()}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  aria-label="Content (Markdown)"
                />
                <p class="text-[13px] text-muted">
                  Markdown. Saving rebuilds the search index the tutor uses. Images look like ![caption](asset:…); keep those lines to keep the image.
                </p>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
