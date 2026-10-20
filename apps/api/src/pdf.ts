import { PDFDocument } from 'pdf-lib';
import { encode as encodePng } from 'fast-png';
import { extractImages, extractText, getDocumentProxy } from 'unpdf';
import type Anthropic from '@anthropic-ai/sdk';
import type { Env } from './env';
import { claude, FALLBACK, textOf } from './claude';
import { Surreal, UserError, fromBase64, toBase64 } from './surreal';

/** The uploaded PDF, reassembled from its stored parts. */
export async function loadPdf(env: Env, materialId: string): Promise<Uint8Array> {
  const db = Surreal.system(env);
  const count = await db.query<number>(
    'RETURN count(SELECT id FROM source_part WHERE material = type::record($m))',
    { m: materialId },
  );
  if (!count) throw new UserError('The uploaded PDF is missing. Upload it again.');
  const parts: Uint8Array[] = [];
  // A few parts per request: each comes back base64 in JSON.
  for (let from = 0; from < count; from += 3) {
    const rows = await db.query<{ b64: string }[]>(
      `SELECT idx, encoding::base64::encode(data) AS b64 FROM source_part
       WHERE material = type::record($m) AND idx >= $from AND idx < $to ORDER BY idx`,
      { m: materialId, from, to: from + 3 },
    );
    for (const r of rows) parts.push(fromBase64(r.b64));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await getDocumentProxy(bytes.slice());
  return pdf.numPages;
}

// ── Images ────────────────────────────────────────────────────────────────

const MIN_SIDE = 64;
const MAX_SIDE = 1600;
const MAX_PNG_BYTES = 2.5 * 1024 * 1024;

export interface ExtractedImage {
  page: number;
  width: number;
  height: number;
  png: Uint8Array;
  hash: string;
}

/**
 * Raster images embedded in pages [from, to], as PNG. Icons and bullets are
 * skipped, large images scaled down. Vector drawings are not images to PDF.js;
 * the converter describes those in words instead.
 */
export async function extractPageImages(bytes: Uint8Array, from: number, to: number): Promise<ExtractedImage[]> {
  // Images above ~8 megapixels (full-page scans) are not decoded at all: at
  // 4 bytes a pixel they would not fit in a Worker's 128 MB.
  const pdf = await getDocumentProxy(bytes.slice(), { maxImageSize: 8_000_000 });
  const out: ExtractedImage[] = [];
  for (let page = from; page <= Math.min(to, pdf.numPages); page++) {
    let images;
    try {
      images = await extractImages(pdf, page);
    } catch (err) {
      console.warn(`[pdf] images on page ${page} skipped`, err);
      continue;
    }
    const seen = new Set<string>();
    for (const im of images) {
      if (im.width < MIN_SIDE || im.height < MIN_SIDE) continue;
      const scaled = downscale(im.data, im.width, im.height, im.channels, MAX_SIDE);
      const png = encodePng({ width: scaled.width, height: scaled.height, data: scaled.data, channels: im.channels, depth: 8 });
      if (png.byteLength > MAX_PNG_BYTES) continue;
      const hash = await sha256(scaled.data);
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push({ page, width: scaled.width, height: scaled.height, png, hash });
    }
  }
  return out;
}

/** Box-filter downscale so the longest side is at most `max`. */
function downscale(data: Uint8ClampedArray, w: number, h: number, ch: number, max: number) {
  const scale = Math.max(w, h) / max;
  if (scale <= 1) return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: w, height: h };
  const nw = Math.max(1, Math.round(w / scale));
  const nh = Math.max(1, Math.round(h / scale));
  const out = new Uint8Array(nw * nh * ch);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(h, Math.floor((y + 1) * scale));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(w, Math.floor((x + 1) * scale));
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            sum += data[(yy * w + xx) * ch + c];
            n++;
          }
        }
        out[(y * nw + x) * ch + c] = n ? Math.round(sum / n) : 0;
      }
    }
  }
  return { data: out, width: nw, height: nh };
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Markdown ──────────────────────────────────────────────────────────────

export interface PageImageRef {
  id: string;
  page: number;
  width: number | null;
  height: number | null;
}

const CONVERT_SYSTEM = `You convert lecture material (PDF pages: slides, scripts, notes, papers) into faithful Markdown for a study app. A student will read it, and a voice tutor will teach from it.

Rules:
- Begin every page with a line \`<!-- page N -->\`, using the page numbers you are given.
- Keep all of the content in the original language. Do not summarize, shorten, translate or add commentary.
- Structure: slide titles and section titles become \`##\` headings (\`###\` below them). Drop running headers, footers, page numbers, slide numbers and logos that repeat on every page.
- Lists, tables (GitHub Markdown) and code blocks as in the source. Merge text that the layout split across lines or columns.
- Math in LaTeX: inline \`$...$\`, display \`$$...$$\`.
- Pictures: the raster images extracted from these pages are listed with ids. Put each one where it belongs as \`![short caption](asset:ID)\`, with a caption that says what it shows. Diagrams, charts and drawings that are not in the list (vector graphics) get a one to three sentence description in italics that starts with "*Figure:*".
- Output only the Markdown.`;

/**
 * Pages [from, to] as Markdown, written by Claude from the page text and page
 * images. Falls back to the plain text layer if the model call fails.
 */
export async function convertPages(
  env: Env,
  bytes: Uint8Array,
  from: number,
  to: number,
  total: number,
  title: string,
  images: PageImageRef[],
): Promise<string> {
  const slice = await PDFDocument.create();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const indices = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  for (const p of await slice.copyPages(src, indices)) slice.addPage(p);
  const sliceBytes = await slice.save();

  const imageList = indices
    .map((i) => i + 1)
    .map((page) => {
      const here = images.filter((im) => im.page === page);
      if (!here.length) return null;
      const list = here.map((im) => `asset:${im.id}${im.width ? ` (${im.width}x${im.height})` : ''}`).join(', ');
      return `Page ${page}: ${list}`;
    })
    .filter(Boolean)
    .join('\n');

  const prompt = `These are pages ${from} to ${to} of "${title}" (${total} pages in total). The first page of this excerpt is page ${from}.

Images extracted from these pages, in the order they appear on each page:
${imageList || '(none)'}`;

  try {
    const stream = claude(env).beta.messages.stream({
      model: env.CLAUDE_PDF_MODEL,
      max_tokens: 48000,
      ...FALLBACK,
      output_config: { effort: 'medium' },
      system: CONVERT_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: toBase64(sliceBytes) },
            } as Anthropic.Beta.BetaRequestDocumentBlock,
            { type: 'text', text: prompt },
          ],
        },
      ],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('The model declined to convert these pages.');
    const md = textOf(msg).trim();
    if (!md) throw new Error('Empty conversion.');
    return md;
  } catch (err) {
    console.error(`[pdf] Claude conversion of pages ${from}-${to} failed, using the text layer`, err);
    return plainTextPages(bytes, from, to, images);
  }
}

async function plainTextPages(bytes: Uint8Array, from: number, to: number, images: PageImageRef[]): Promise<string> {
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  const parts: string[] = [];
  for (let page = from; page <= to; page++) {
    const pics = images.filter((im) => im.page === page).map((im) => `![](asset:${im.id})`);
    parts.push([`<!-- page ${page} -->`, (text[page - 1] ?? '').trim(), ...pics].filter(Boolean).join('\n\n'));
  }
  return parts.join('\n\n');
}

/**
 * Makes sure every extracted image appears in the markdown: any the converter
 * did not place goes at the end of its page.
 */
export function placeMissingImages(markdown: string, images: PageImageRef[]): string {
  const missing = images.filter((im) => !markdown.includes(`asset:${im.id}`));
  if (!missing.length) return markdown;
  let out = markdown;
  const byPage = new Map<number, PageImageRef[]>();
  for (const im of missing) byPage.set(im.page, [...(byPage.get(im.page) ?? []), im]);
  for (const [page, ims] of [...byPage.entries()].sort((a, b) => b[0] - a[0])) {
    const block = ims.map((im) => `![](asset:${im.id})`).join('\n\n');
    const next = out.indexOf(`<!-- page ${page + 1} -->`);
    out = next >= 0 ? `${out.slice(0, next)}${block}\n\n${out.slice(next)}` : `${out}\n\n${block}`;
  }
  return out;
}

