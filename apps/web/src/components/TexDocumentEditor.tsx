import { createEffect, on, onCleanup, onMount } from 'solid-js';
import { basicSetup, EditorView } from 'codemirror';
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { tags } from '@lezer/highlight';
import { texCitations } from '../lib/citations';

/**
 * The editor of a LaTeX document (routes/Document.tsx): the source with
 * syntax highlighting and `\cite{` offering the document's papers. Its
 * rendering is a tab of the panel beside it. The text is the
 * page's, saved as you type: it follows changes from elsewhere (another
 * device, ChatGPT) while the editor is not focused. Loaded on demand, with
 * CodeMirror.
 */

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.tagName], color: 'var(--blue)' },
  { tag: [tags.bracket, tags.squareBracket], color: 'var(--muted)' },
  { tag: tags.comment, color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [tags.string, tags.atom], color: 'var(--green)' },
  { tag: [tags.number, tags.special(tags.string)], color: '#b86c68' },
  { tag: tags.variableName, color: 'var(--fg)' },
]);

/** Changes made by the app (text from elsewhere), not typed. */
const synced = Annotation.define<boolean>();

export default function TexDocumentEditor(props: {
  content: () => string;
  onInput: (text: string) => void;
  onBlur: () => void;
  onView?: (view: EditorView) => void;
  label: string;
}) {
  let host!: HTMLDivElement;

  onMount(() => {
    let alive = true;
    const view: EditorView = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.content(),
        extensions: [
          basicSetup,
          StreamLanguage.define(stex),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          texCitations(),
          EditorView.contentAttributes.of({ 'aria-label': props.label, spellcheck: 'true' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.every((t) => t.annotation(synced))) props.onInput(u.state.doc.toString());
            if (u.focusChanged && !u.view.hasFocus) {
              props.onBlur();
              queueMicrotask(reconcile);
            }
          }),
        ],
      }),
    });

    // The text being written is the writer's until they leave the editor.
    const reconcile = () => {
      if (!alive || view.hasFocus) return;
      const text = props.content();
      if (view.state.doc.toString() === text) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: [synced.of(true), Transaction.addToHistory.of(false)] });
    };
    createEffect(on(props.content, () => queueMicrotask(reconcile), { defer: true }));

    props.onView?.(view);
    onCleanup(() => {
      alive = false;
      view.destroy();
    });
  });

  return <div ref={host} class="tex-editor flat h-full min-h-0 min-w-0" />;
}
