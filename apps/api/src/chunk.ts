/**
 * Splits a lecture's markdown into search chunks: one heading section at a
 * time, paragraphs packed up to ~TARGET characters, each chunk carrying the
 * heading path it sits under. Deterministic, so every workflow step that
 * re-chunks the same content gets the same list.
 */
export interface Chunk {
  heading: string | null;
  text: string;
}

const TARGET = 1400;
const MAX = 2200;

export function chunkMarkdown(markdown: string): Chunk[] {
  const lines = cleanForIndex(markdown).split('\n');
  const path: string[] = [];
  const sections: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      path.length = level - 1;
      path[level - 1] = h[2].trim();
      sections.push({ heading: path.filter(Boolean).join(' > '), body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const paragraphs = section.body
      .join('\n')
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap(splitLong);
    let buf = '';
    for (const p of paragraphs) {
      if (buf && buf.length + p.length + 2 > TARGET) {
        chunks.push({ heading: section.heading, text: buf });
        buf = '';
      }
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    if (buf) chunks.push({ heading: section.heading, text: buf });
  }
  return chunks.filter((c) => c.text.replace(/\W/g, '').length > 20);
}

/** Text the tutor and the index see: figures become their captions, page markers go. */
export function cleanForIndex(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\(asset:[A-Za-z0-9_-]+\)/g, (_m, alt: string) => (alt ? `[Figure: ${alt}]` : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLong(p: string): string[] {
  if (p.length <= MAX) return [p];
  const out: string[] = [];
  const sentences = p.split(/(?<=[.!?])\s+/);
  let buf = '';
  for (const s of sentences) {
    if (buf && buf.length + s.length + 1 > TARGET) {
      out.push(buf);
      buf = '';
    }
    buf = buf ? `${buf} ${s}` : s;
    while (buf.length > MAX) {
      out.push(buf.slice(0, MAX));
      buf = buf.slice(MAX);
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** The text that gets embedded: heading path first, so it carries context. */
export const embedText = (c: Chunk) => (c.heading ? `${c.heading}\n\n${c.text}` : c.text);
