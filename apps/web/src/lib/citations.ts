import { type EditorState, type Extension, Facet, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { MarkdownConfig } from '@lezer/markdown';
import { Tag } from '@lezer/highlight';
import { focusField } from './live-markdown';

/**
 * Citations in a document (schema `paper`), written Pandoc style: `[@key]`,
 * `[@key, p. 4]`, several as `[@a; @b, ch. 2]`, the key being the paper's
 * record key. In the editor a citation reads as it prints, "(Vaswani et al.,
 * 2017, p. 4)" or "[1, p. 4]", until the cursor enters it; a click opens the
 * paper beside the text. `[@` offers the document's papers by author, title
 * or year. Export PDF formats them the same way and lists what was cited.
 */

export interface Paper {
  key: string;
  title: string;
  authors?: string | null;
  year?: string | null;
  venue?: string | null;
  url?: string | null;
}

export type CiteStyle = 'author-year' | 'numeric';

export interface Cite {
  key: string;
  /** What follows the key: "p. 4", "ch. 2". */
  locator: string;
}

const ITEM = String.raw`@[A-Za-z0-9_]+(?:,[^\]\n;]*)?`;
const CITATION_SRC = String.raw`\[${ITEM}(?:;\s*${ITEM})*\]`;
const CITATION = new RegExp(CITATION_SRC, 'g');
const CITATION_AT = new RegExp(`^${CITATION_SRC}`);

/** The papers a citation names, from its text with or without the brackets. */
export function parseCites(src: string): Cite[] {
  const inner = src.startsWith('[') ? src.slice(1, -1) : src;
  return inner.split(';').flatMap((part) => {
    const m = /^\s*@([A-Za-z0-9_]+)\s*(?:,\s*(.*))?$/.exec(part);
    return m ? [{ key: m[1], locator: (m[2] ?? '').trim() }] : [];
  });
}

/** How often the text cites each paper, by key. */
export function countCites(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(CITATION)) for (const c of parseCites(m[0])) out.set(c.key, (out.get(c.key) ?? 0) + 1);
  return out;
}

/** The page a locator points at ("p. 4", "pp. 4-6"), to open the PDF there. */
export const locatorPage = (locator: string) => {
  const m = /\bpp?\.?\s*(\d+)/i.exec(locator);
  return m ? Number(m[1]) : null;
};

// ── Names ─────────────────────────────────────────────────────────────────

/**
 * The authors of a paper, one per entry. Written "Vaswani, A.; Shazeer, N."
 * or "Ashish Vaswani and Noam Shazeer"; commas separate names only when each
 * piece is a full name ("A. Vaswani, N. Shazeer"), not "Vaswani, A.".
 */
export function authorList(authors: string | null | undefined): string[] {
  const s = authors?.trim();
  if (!s) return [];
  const parts = s.includes(';') ? s.split(';') : s.split(/\s+(?:and|&)\s+|,\s*(?:and|&)\s+/);
  return parts
    .flatMap((part) => {
      const pieces = part.split(/\s*,\s*/);
      return pieces.length > 1 && pieces.every((p) => /\S\s+\S/.test(p.trim())) ? pieces : [part];
    })
    .map((p) => p.trim())
    .filter(Boolean);
}

const surname = (name: string) => (name.includes(',') ? name.slice(0, name.indexOf(',')) : name.split(/\s+/).at(-1) ?? name).trim();

const shortTitle = (title: string) => {
  const words = title.split(/\s+/);
  return words.length > 4 ? `${words.slice(0, 4).join(' ')}…` : title;
};

/** Who a citation names: "Vaswani", "Vaswani and Shazeer", "Vaswani et al.", or the title. */
export function citeNames(paper: Paper): string {
  const names = authorList(paper.authors).map(surname);
  if (!names.length) return `“${shortTitle(paper.title)}”`;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

export const citeYear = (paper: Paper) => paper.year?.trim() || 'n.d.';

/** A paper's short label, as the editor's suggestions show it. */
export const paperLabel = (paper: Paper) => `${citeNames(paper)} ${citeYear(paper)}`;

// ── Formatting ────────────────────────────────────────────────────────────

export interface CiteContext {
  papers: ReadonlyMap<string, Paper>;
  style: CiteStyle;
  /** Numeric style: each cited key's number, by first citation. */
  numbers: ReadonlyMap<string, number>;
}

/** Each cited key's number in order of first citation (numeric style). */
export function numbering(text: string, papers: ReadonlyMap<string, Paper>): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(CITATION)) {
    for (const c of parseCites(m[0])) if (papers.has(c.key) && !out.has(c.key)) out.set(c.key, out.size + 1);
  }
  return out;
}

/** A citation as it prints: "(Vaswani et al., 2017, p. 4; Shazeer, 2019)" or "[1, p. 4; 2]". */
export function formatCite(cites: Cite[], cx: CiteContext): string {
  const items = cites.map((c) => {
    const paper = cx.papers.get(c.key);
    const loc = c.locator ? `, ${c.locator}` : '';
    if (cx.style === 'numeric') return `${cx.numbers.get(c.key) ?? '?'}${loc}`;
    return paper ? `${citeNames(paper)}, ${citeYear(paper)}${loc}` : `?${loc}`;
  });
  return cx.style === 'numeric' ? `[${items.join('; ')}]` : `(${items.join('; ')})`;
}

// Code keeps its brackets, as markdown.ts keeps its dollars.
const CODE = /(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)|`+[^`\n]+?`+/g;
// Brackets stay: `\[` would open display math in renderMarkdown, and "[1]" with no link definition prints as it is.
const escapeMd = (s: string) => s.replace(/[`*_<>]/g, '\\$&');

/**
 * A document's Markdown with its citations formatted, for printing, and the
 * papers it cites in the order its reference list gives them: by number, or
 * by author and year.
 */
export function printCitations(md: string, papers: readonly Paper[], style: CiteStyle): { markdown: string; cited: Paper[] } {
  const byKey = new Map(papers.map((p) => [p.key, p]));
  const cx: CiteContext = { papers: byKey, style, numbers: numbering(md, byKey) };
  const cited = new Set<string>();
  const format = (part: string) =>
    part.replace(CITATION, (src) => {
      const cites = parseCites(src);
      for (const c of cites) if (byKey.has(c.key)) cited.add(c.key);
      return escapeMd(formatCite(cites, cx));
    });
  let text = '';
  let at = 0;
  for (const m of md.matchAll(CODE)) {
    text += format(md.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  text += format(md.slice(at));
  const list = [...cited].map((k) => byKey.get(k)!);
  if (style === 'numeric') list.sort((a, b) => cx.numbers.get(a.key)! - cx.numbers.get(b.key)!);
  else list.sort((a, b) => citeNames(a).localeCompare(citeNames(b)) || citeYear(a).localeCompare(citeYear(b)));
  return { markdown: text, cited: list };
}

// ── In the editor ─────────────────────────────────────────────────────────

const citeTag = Tag.define();

/** `[@…]` as a node of its own, so the Markdown parser does not read it as a link. */
export const citationSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'Citation', style: citeTag }],
  parseInline: [
    {
      name: 'Citation',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 || cx.char(pos + 1) !== 64) return -1;
        const m = CITATION_AT.exec(cx.slice(pos, cx.end));
        return m ? cx.addElement(cx.elt('Citation', pos, pos + m[0].length)) : -1;
      },
    },
  ],
};

const setPapers = StateEffect.define<{ papers: readonly Paper[]; style: CiteStyle }>();

interface PapersState {
  list: readonly Paper[];
  byKey: ReadonlyMap<string, Paper>;
  style: CiteStyle;
}

const papersField = StateField.define<PapersState>({
  create: () => ({ list: [], byKey: new Map(), style: 'author-year' }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setPapers)) value = { list: e.value.papers, byKey: new Map(e.value.papers.map((p) => [p.key, p])), style: e.value.style };
    }
    return value;
  },
});

/** Hands the editor the document's papers and style, whenever they change. */
export const updatePapers = (view: EditorView, papers: readonly Paper[], style: CiteStyle) =>
  view.dispatch({ effects: setPapers.of({ papers, style }) });

/** Opens a cited paper beside the text, at the page cited. */
const openCite = Facet.define<(key: string, page: number | null) => void, ((key: string, page: number | null) => void) | null>({
  combine: (values) => values[0] ?? null,
});

class CiteWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly hint: string,
    readonly key: string,
    readonly page: number | null,
    readonly missing: boolean,
  ) {
    super();
  }
  eq(other: CiteWidget) {
    return other.text === this.text && other.hint === this.hint && other.key === this.key && other.page === this.page && other.missing === this.missing;
  }
  toDOM(view: EditorView) {
    const el = document.createElement('span');
    el.className = `cm-cite${this.missing ? ' cm-cite-missing' : ''}`;
    el.textContent = this.text;
    el.title = this.hint;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!this.missing) view.state.facet(openCite)?.(this.key, this.page);
    });
    return el;
  }
  // A click opens the paper; the source shows when the cursor walks in.
  ignoreEvent(e: Event) {
    return e.type === 'mousedown' || e.type === 'click';
  }
}

function citeDecorations(state: EditorState): DecorationSet {
  const { byKey, style } = state.field(papersField);
  const focused = state.field(focusField);
  const touches = (from: number, to: number) => focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const cx: CiteContext = { papers: byKey, style, numbers: style === 'numeric' ? numbering(state.doc.toString(), byKey) : new Map() };
  const out: Range<Decoration>[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  tree.iterate({
    enter({ name, from, to }) {
      if (name !== 'Citation') return;
      if (touches(from, to)) {
        out.push(Decoration.mark({ class: 'cm-cite-src' }).range(from, to));
        return false;
      }
      const cites = parseCites(state.sliceDoc(from, to));
      const missing = cites.some((c) => !byKey.has(c.key));
      const hint = cites
        .map((c) => {
          const p = byKey.get(c.key);
          return p ? [p.authors, p.year, p.title].filter(Boolean).join(' · ') + (c.locator ? ` (${c.locator})` : '') : 'A paper no longer in this document';
        })
        .join('\n');
      const first = cites[0];
      out.push(
        Decoration.replace({ widget: new CiteWidget(formatCite(cites, cx), hint, first?.key ?? '', locatorPage(first?.locator ?? ''), missing) }).range(from, to),
      );
      return false;
    },
  });
  return Decoration.set(out, true);
}

const citeField = StateField.define<DecorationSet>({
  create: citeDecorations,
  update(deco, tr) {
    const changed =
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setPapers)) ||
      tr.startState.field(focusField) !== tr.state.field(focusField) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState);
    return changed ? citeDecorations(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The document's papers after `[@`, found by author, title, year or key. */
function suggest(cx: CompletionContext): CompletionResult | null {
  const line = cx.state.doc.lineAt(cx.pos);
  const before = cx.state.sliceDoc(line.from, cx.pos);
  if (!/\[@[^\]\n]*$/.test(before)) return null;
  const word = /@([^\s@;,\]]*)$/.exec(before);
  if (!word) return null;
  const { list } = cx.state.field(papersField);
  if (!list.length) return null;
  const query = word[1].toLowerCase();
  const from = cx.pos - word[1].length;
  const options: Completion[] = list
    .filter((p) => !query || p.key.toLowerCase().startsWith(query) || [p.authors, p.title, p.year].some((v) => v?.toLowerCase().includes(query)))
    .map((p, i) => ({
      label: paperLabel(p),
      detail: p.title,
      boost: -i,
      apply: (view, _completion, start, end) => {
        const close = view.state.sliceDoc(end, end + 1) === ']' || /^[^\[\n]*\]/.test(view.state.sliceDoc(end, line.to)) ? '' : ']';
        view.dispatch({
          changes: { from: start, to: end, insert: p.key + close },
          selection: { anchor: start + p.key.length + close.length },
          userEvent: 'input.complete',
        });
      },
    }));
  return options.length ? { from, options, filter: false } : null;
}

/**
 * Inserts a citation at the cursor: into the citation the cursor is at the
 * end of (`; @key`), or as a new one with a space before it.
 */
export function insertCitation(view: EditorView, key: string, locator = '') {
  const { state } = view;
  const { from, to } = state.selection.main;
  const item = `@${key}${locator ? `, ${locator}` : ''}`;
  const node = syntaxTree(state).resolveInner(from, 1);
  let insert: string;
  let at = from;
  let end = to;
  if (node.name === 'Citation' && from === to && from === node.to - 1) {
    insert = `; ${item}`;
  } else if (node.name === 'Citation' && from === to) {
    at = end = node.to;
    insert = ` [${item}]`;
  } else {
    const prev = state.sliceDoc(from - 1, from);
    insert = `${prev && !/[\s([]/.test(prev) ? ' ' : ''}[${item}]`;
  }
  view.dispatch({
    changes: { from: at, to: end, insert },
    selection: { anchor: at + insert.length },
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
}

/** Citations for the editor. `onOpen` shows a cited paper. */
export function citations(onOpen: (key: string, page: number | null) => void): Extension {
  return [
    papersField,
    citeField,
    openCite.of(onOpen),
    autocompletion({ override: [suggest], icons: false }),
  ];
}
