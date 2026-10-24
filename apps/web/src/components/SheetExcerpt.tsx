import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { renderMarkdown } from '../lib/markdown';
import type { Segment } from '../lib/sheet-regions';

/**
 * The exercise a homework answer is for: its region of the PDF sheet, cut
 * out of the rendered page, or, without one (a LaTeX sheet, a part whose
 * label was not found), its text. Pages are rendered once per width and
 * shared by every excerpt from them.
 */

const pages = new Map<string, Promise<HTMLCanvasElement>>();

function renderPage(pdf: PDFDocumentProxy, n: number, width: number): Promise<HTMLCanvasElement> {
  const key = `${pdf.fingerprints[0]}:${n}:${width}`;
  let hit = pages.get(key);
  if (!hit) {
    hit = (async () => {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      return canvas;
    })();
    pages.set(key, hit);
    hit.catch(() => pages.delete(key));
    // A few pages at a time: canvases are large on phones.
    while (pages.size > 6) pages.delete(pages.keys().next().value!);
  }
  return hit;
}

/** The canvas without the blank rows at its foot (a part that runs to the page's end), keeping `pad`. */
function trimBottom(canvas: HTMLCanvasElement, pad: number): HTMLCanvasElement {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || canvas.height < 2) return canvas;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let last = -1;
  for (let y = height - 1; y >= 0 && last < 0; y--) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 0 && (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235)) {
        last = y;
        break;
      }
    }
  }
  const keep = Math.min(height, last < 0 ? height : last + 1 + pad);
  if (keep >= height - pad) return canvas;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = keep;
  out.getContext('2d')!.drawImage(canvas, 0, 0, width, keep, 0, 0, width, keep);
  return out;
}

export function SheetExcerpt(props: { pdf: PDFDocumentProxy | null; segments: Segment[]; prompt: string; context?: string | null }) {
  let host!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  const [crops, setCrops] = createSignal<HTMLCanvasElement[]>([]);
  const [failed, setFailed] = createSignal(false);

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });

  createEffect(
    on([() => props.pdf, () => JSON.stringify(props.segments), width], ([pdf, , w]) => {
      setCrops([]);
      setFailed(false);
      if (!pdf || !props.segments.length || w < 40) return;
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = Math.round(w * dpr);
      void (async () => {
        try {
          const out: HTMLCanvasElement[] = [];
          for (const s of props.segments) {
            const page = await renderPage(pdf, s.page, px);
            const top = Math.floor(s.top * page.height);
            const height = Math.max(1, Math.ceil((s.bottom - s.top) * page.height));
            const crop = document.createElement('canvas');
            crop.width = page.width;
            crop.height = height;
            crop.getContext('2d')!.drawImage(page, 0, top, page.width, height, 0, 0, page.width, height);
            const trimmed = trimBottom(crop, Math.round(10 * dpr));
            trimmed.className = 'block h-auto w-full';
            out.push(trimmed);
          }
          if (!cancelled) setCrops(out);
        } catch {
          if (!cancelled) setFailed(true);
        }
      })();
    }),
  );

  const usePdf = () => !!props.pdf && props.segments.length > 0 && !failed();

  return (
    <div ref={host} class="min-w-0">
      <Show
        when={usePdf()}
        fallback={
          <div class="lecture text-[14px] leading-relaxed">
            <Show when={props.context}>
              <div class="mb-2 text-muted" innerHTML={renderMarkdown(props.context!)} />
            </Show>
            <div innerHTML={renderMarkdown(props.prompt || '')} />
          </div>
        }
      >
        <Show when={crops().length} fallback={<div class="h-28 animate-pulse rounded-lg bg-soft" />}>
          <div class="sheet-excerpt space-y-1 bg-white">
            <For each={crops()}>{(c) => c}</For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
