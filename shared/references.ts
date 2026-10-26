/**
 * The references a draft mentions, for turning it into a document with its
 * papers beside it (apps/web/src/lib/documents.ts, apps/api/src/documents.ts).
 * A reference is a link after its authors and year, as a reading list or a
 * draft writes it: "Stark et al. (2019): [Broadband polarimetric …](https://doi.org/…)",
 * also "Padmanabhan and Prakash (2025, preprint) [title](url)". Each is matched
 * to the course material holding the same paper, when there is one.
 */

export interface FoundReference {
  /** As written: "Stark et al.", "Padmanabhan and Prakash". */
  authors: string;
  year: string;
  title: string;
  url: string;
}

const NAME = String.raw`\p{Lu}[\p{L}'’-]+`;
const REFERENCE = new RegExp(
  String.raw`(${NAME}(?:\s+et\s+al\.?|(?:,\s*${NAME})*\s+(?:and|&)\s+${NAME})?)\s*\((\d{4})[a-z]?[^)\n]*\)\s*[:,.-]?\s*\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)`,
  'gu',
);

const cleanTitle = (s: string) =>
  s
    .replace(/^[\s*_]+|[\s*_.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The references in a document's Markdown, each once (by link), in order. */
export function findReferences(markdown: string): FoundReference[] {
  const out: FoundReference[] = [];
  const seen = new Set<string>();
  for (const m of markdown.matchAll(REFERENCE)) {
    const url = m[4];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ authors: m[1].replace(/\s+/g, ' ').trim(), year: m[2], title: cleanTitle(m[3]), url });
  }
  return out;
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (s: string) => new Set(fold(s).match(/[a-z0-9]{4,}/g) ?? []);

/**
 * The material holding each reference's paper, by first author, year and
 * title words in the material's title ("Midterm paper P02: Stark et al. 2019
 * - Broadband polarimetric …"). A material serves one reference at most.
 */
export function matchMaterials<M extends { id: string; title: string }>(refs: FoundReference[], materials: readonly M[]): (M | null)[] {
  const used = new Set<string>();
  return refs.map((ref) => {
    const author = fold(ref.authors.split(/[\s,]+/)[0] ?? '');
    const want = words(ref.title);
    let best: { m: M; score: number } | null = null;
    for (const m of materials) {
      if (used.has(m.id)) continue;
      const title = fold(m.title);
      if (!author || !title.includes(author) || !title.includes(ref.year)) continue;
      const have = words(m.title);
      const shared = [...want].filter((w) => have.has(w)).length;
      const score = want.size ? shared / want.size : 0;
      if (score >= 0.3 && (!best || score > best.score)) best = { m, score };
    }
    if (best) used.add(best.m.id);
    return best?.m ?? null;
  });
}

/** A material's text as a document starts from it: Markdown, without PDF page marks. */
export function draftMarkdown(markdown: string): string {
  return markdown
    .replace(/^<!-- page \d+ -->\n?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
