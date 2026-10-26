import { createEffect, on, onCleanup, onMount } from 'solid-js';
import {
  Annotation,
  type ChangeSpec,
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  type Range,
  type StateCommand,
  StateField,
  Transaction,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { MarkdownConfig } from '@lezer/markdown';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { focusField, liveMarkdown } from '../lib/live-markdown';

/**
 * The app's writing editor: one or more texts as one document. A homework
 * gives it every answer, and the parts follow each other in sheet order,
 * each question under its heading and each part's label in the margin, so
 * writing feels like one page. The parts are still separate texts: their
 * boundaries are tracked through every edit and no edit may remove one (a
 * selection across parts clears each of them, Backspace at a part's start
 * steps back into the one before). A document gives it a single text with
 * no label. Markdown and $math$ render in place (lib/live-markdown.ts);
 * `extensions` add to that (a document's citations). Loaded on demand, with
 * CodeMirror.
 */

export interface EditorPart {
  id: string;
  question: string;
  questionTitle: string;
  label: string;
}

interface Props {
  parts: EditorPart[];
  /** A part's current text (the saved row or a draft): followed when it changes elsewhere. */
  content: (id: string) => string;
  onInput: (id: string, text: string) => void;
  /** The part holding the cursor, `null` once the writer leaves with Escape. */
  onActive: (id: string | null) => void;
  onBlur: () => void;
  /** Uploads a pasted or dropped image for a part, resolving to its markdown. */
  uploadImage: (id: string, file: File) => Promise<string | null>;
  /** Room taken at the top of the window (the exercise pinned on phones). */
  topInset?: () => number;
  /** Shown in an empty part, default "Write your answer". */
  placeholder?: string;
  /** What a screen reader calls the editor, default "Answers". */
  label?: string;
  class?: string;
  /** More Markdown syntax and CodeMirror extensions, given once. */
  syntax?: MarkdownConfig[];
  extensions?: Extension[];
  /** The view, once made: for the page to insert text or send it effects. */
  onView?: (view: EditorView) => void;
}

// ── The parts and their boundaries ────────────────────────────────────────
//
// The document is the parts' texts joined by a newline each; `seps` holds
// the position of every joining newline. Text inserted right before one
// belongs to the part it ends, so they map forward (assoc 1).

interface Layout {
  parts: readonly EditorPart[];
  seps: readonly number[];
}

const layoutField = StateField.define<Layout>({
  create: () => ({ parts: [], seps: [] }),
  update(layout, tr) {
    if (!tr.docChanged) return layout;
    return { parts: layout.parts, seps: layout.seps.map((p) => tr.changes.mapPos(p, 1)) };
  },
});

function bounds(layout: Layout, length: number, i: number) {
  return { from: i ? layout.seps[i - 1] + 1 : 0, to: i < layout.seps.length ? layout.seps[i] : length };
}

function partAt(layout: Layout, pos: number) {
  let i = 0;
  while (i < layout.seps.length && layout.seps[i] < pos) i++;
  return i;
}

/** Changes made by the app (another device's text), not typed. */
const synced = Annotation.define<boolean>();

/** Rewrites an edit that would remove a boundary into one that keeps them all. */
const keepBoundaries = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(synced)) return tr;
  const { seps } = tr.startState.field(layoutField);
  let crosses = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (seps.some((s) => s >= fromA && s < toA)) crosses = true;
  });
  if (!crosses) return tr;

  const specs: ChangeSpec[] = [];
  let first = -1;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (first < 0) first = fromA;
    // What the change removed, but for the boundaries in it; its text goes in the first part.
    const spans: { from: number; to: number; insert?: string }[] = [];
    let at = fromA;
    for (const s of seps) {
      if (s < fromA || s >= toA) continue;
      if (s > at) spans.push({ from: at, to: s });
      at = s + 1;
    }
    if (toA > at) spans.push({ from: at, to: toA });
    const text = inserted.toString();
    if (text && spans[0]?.from === fromA) spans[0].insert = text;
    else if (text) specs.push({ from: fromA, insert: text });
    specs.push(...spans);
  });
  const changes = tr.startState.changes(specs);
  return {
    changes,
    selection: EditorSelection.cursor(changes.mapPos(first, 1)),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    userEvent: tr.annotation(Transaction.userEvent),
  };
});

// ── How the parts look ────────────────────────────────────────────────────

class QuestionWidget extends WidgetType {
  constructor(
    readonly number: string,
    readonly title: string,
    readonly first: boolean,
  ) {
    super();
  }
  eq(other: QuestionWidget) {
    return other.number === this.number && other.title === this.title && other.first === this.first;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = `cm-hw-question${this.first ? ' cm-hw-question-first' : ''}`;
    const number = document.createElement('span');
    number.className = 'cm-hw-qnum';
    number.textContent = this.number;
    const title = document.createElement('span');
    title.textContent = this.title;
    el.append(number, title);
    return el;
  }
}

class PlaceholderWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: PlaceholderWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-hw-placeholder';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = this.text;
    return el;
  }
}

const placeholderText = Facet.define<string, string>({ combine: (values) => values[0] ?? 'Write your answer' });
const activeLine = Decoration.line({ class: 'cm-hw-active' });

function structure(state: EditorState): DecorationSet {
  const layout = state.field(layoutField);
  const focused = state.field(focusField);
  const active = focused ? partAt(layout, state.selection.main.head) : -1;
  const placeholder = Decoration.widget({ widget: new PlaceholderWidget(state.facet(placeholderText)), side: 1 });
  const out: Range<Decoration>[] = [];
  layout.parts.forEach((part, i) => {
    const { from, to } = bounds(layout, state.doc.length, i);
    const newQuestion = i === 0 || layout.parts[i - 1].question !== part.question;
    if (newQuestion && part.question) {
      const title = part.questionTitle || `Question ${part.question}`;
      out.push(Decoration.widget({ widget: new QuestionWidget(part.question, title, i === 0), block: true, side: -1 }).range(from));
    }
    out.push(
      Decoration.line({ class: newQuestion ? 'cm-hw-part' : 'cm-hw-part cm-hw-gap', attributes: { 'data-label': part.label } }).range(from),
    );
    // A single text asks to be written in even before it is focused.
    if (from === to && i !== active && layout.parts.length === 1) out.push(placeholder.range(from));
    if (i !== active) return;
    for (let pos = from; ; ) {
      const line = state.doc.lineAt(pos);
      out.push(activeLine.range(line.from));
      if (line.to >= to) break;
      pos = line.to + 1;
    }
    if (from === to) out.push(placeholder.range(from));
  });
  return Decoration.set(out, true);
}

const structureField = StateField.define<DecorationSet>({
  create: structure,
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.startState.field(focusField) !== tr.state.field(focusField)) return structure(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── Commands ──────────────────────────────────────────────────────────────

/** The cursor to the end of the next or previous part. */
const toPart =
  (by: 1 | -1): StateCommand =>
  ({ state, dispatch }) => {
    const layout = state.field(layoutField);
    const i = partAt(layout, state.selection.main.head) + by;
    if (i < 0 || i >= layout.parts.length) return false;
    dispatch(state.update({ selection: EditorSelection.cursor(bounds(layout, state.doc.length, i).to), scrollIntoView: true, userEvent: 'select' }));
    return true;
  };

const inList = (state: EditorState) => {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(state.selection.main.head, -1); node; node = node.parent) {
    if (node.name === 'ListItem') return true;
  }
  return false;
};

/** Wraps the selection in `mark`, or unwraps it when it already is. */
const toggleWrap =
  (mark: string): StateCommand =>
  ({ state, dispatch }) => {
    const n = mark.length;
    dispatch(
      state.update(
        state.changeByRange((r) => {
          if (state.sliceDoc(r.from - n, r.from) === mark && state.sliceDoc(r.to, r.to + n) === mark) {
            return {
              changes: [
                { from: r.from - n, to: r.from },
                { from: r.to, to: r.to + n },
              ],
              range: EditorSelection.range(r.from - n, r.to - n),
            };
          }
          return {
            changes: [
              { from: r.from, insert: mark },
              { from: r.to, insert: mark },
            ],
            range: EditorSelection.range(r.from + n, r.to + n),
          };
        }),
        { scrollIntoView: true, userEvent: 'input' },
      ),
    );
    return true;
  };

const imagesOf = (data: DataTransfer | null) => [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'));

export default function Editor(props: Props) {
  let host!: HTMLDivElement;

  onMount(() => {
    const parts = props.parts;
    const seps: number[] = [];
    let doc = '';
    parts.forEach((part, i) => {
      if (i) {
        seps.push(doc.length);
        doc += '\n';
      }
      doc += props.content(part.id);
    });

    let alive = true;
    // Where pasted images go once uploaded, kept in place while you type on.
    const anchors = new Set<{ pos: number }>();

    const upload = (view: EditorView, pos: number, files: File[]) => {
      const anchor = { pos };
      anchors.add(anchor);
      const layout = view.state.field(layoutField);
      const id = layout.parts[partAt(layout, pos)].id;
      void (async () => {
        for (const file of files) {
          const md = await props.uploadImage(id, file);
          if (!md || !alive) continue;
          const at = anchor.pos;
          const line = view.state.doc.lineAt(at);
          const insert = `${at === line.from ? '' : '\n'}${md}\n`;
          const follow = view.state.selection.main.empty && view.state.selection.main.head === at;
          view.dispatch({
            changes: { from: at, insert },
            selection: follow ? EditorSelection.cursor(at + insert.length) : undefined,
            userEvent: 'input.paste',
          });
          anchor.pos = at + insert.length;
        }
        anchors.delete(anchor);
      })();
    };

    const reconcile = () => {
      if (!alive) return;
      const state = view.state;
      const layout = state.field(layoutField);
      // The part being written is the writer's until they leave it.
      const editing = view.hasFocus ? partAt(layout, state.selection.main.head) : -1;
      const changes: ChangeSpec[] = [];
      layout.parts.forEach((part, i) => {
        if (i === editing) return;
        const text = props.content(part.id);
        const { from, to } = bounds(layout, state.doc.length, i);
        if (state.sliceDoc(from, to) !== text) changes.push({ from, to, insert: text });
      });
      if (changes.length) view.dispatch({ changes, annotations: [synced.of(true), Transaction.addToHistory.of(false)] });
    };

    const view: EditorView = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          layoutField.init(() => ({ parts, seps })),
          keepBoundaries,
          history(),
          EditorView.lineWrapping,
          EditorState.allowMultipleSelections.of(false),
          liveMarkdown(props.syntax),
          placeholderText.of(props.placeholder ?? 'Write your answer'),
          structureField,
          ...(props.extensions ?? []),
          keymap.of([
            { key: 'Tab', run: (v) => (inList(v.state) ? indentMore(v) : toPart(1)(v)) },
            { key: 'Shift-Tab', run: (v) => (inList(v.state) ? indentLess(v) : toPart(-1)(v)) },
            { key: 'Mod-b', run: toggleWrap('**') },
            { key: 'Mod-i', run: toggleWrap('*') },
            {
              key: 'Escape',
              run: (v) => {
                v.contentDOM.blur();
                props.onActive(null);
                return true;
              },
            },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          // `$` around a selection makes it a formula.
          EditorView.inputHandler.of((v, _from, _to, text) => text === '$' && !v.state.selection.main.empty && toggleWrap('$')(v)),
          EditorView.domEventHandlers({
            paste(e, v) {
              const files = imagesOf(e.clipboardData);
              if (!files.length) return false;
              e.preventDefault();
              upload(v, v.state.selection.main.head, files);
              return true;
            },
            drop(e, v) {
              const files = imagesOf(e.dataTransfer);
              if (!files.length) return false;
              e.preventDefault();
              upload(v, v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head, files);
              return true;
            },
          }),
          EditorView.scrollMargins.of(() => ({ top: (props.topInset?.() ?? 0) + 16, bottom: 48 })),
          EditorView.contentAttributes.of({
            'aria-label': props.label ?? 'Answers',
            spellcheck: 'true',
            autocorrect: 'on',
            autocapitalize: 'sentences',
          }),
          EditorView.updateListener.of((u) => {
            const layout = u.state.field(layoutField);
            if (u.docChanged) {
              for (const a of anchors) a.pos = u.changes.mapPos(a.pos, -1);
              if (!u.transactions.every((t) => t.annotation(synced))) {
                const touched = new Set<number>();
                u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
                  for (let i = partAt(layout, fromB); i <= partAt(layout, toB); i++) touched.add(i);
                });
                for (const i of touched) {
                  const { from, to } = bounds(layout, u.state.doc.length, i);
                  props.onInput(layout.parts[i].id, u.state.sliceDoc(from, to));
                }
              }
            }
            if (u.view.hasFocus && (u.selectionSet || u.docChanged || u.focusChanged)) {
              props.onActive(layout.parts[partAt(layout, u.state.selection.main.head)]?.id ?? null);
            }
            if (u.focusChanged && !u.view.hasFocus) {
              props.onBlur();
              queueMicrotask(reconcile);
            }
          }),
        ],
      }),
    });

    props.onView?.(view);

    // Text that changed elsewhere (another device, a save coming back) flows in.
    createEffect(
      on(
        () => props.parts.map((p) => props.content(p.id)),
        () => queueMicrotask(reconcile),
        { defer: true },
      ),
    );

    onCleanup(() => {
      alive = false;
      view.destroy();
    });
  });

  return <div ref={host} class={`answer-editor ${props.class ?? ''}`} />;
}
