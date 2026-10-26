import { createEffect, on, onCleanup, onMount, Show } from 'solid-js';
import { basicSetup, EditorView } from 'codemirror';
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { tags } from '@lezer/highlight';
import { texCitations } from '../lib/citations';

/**
 * The editor of a LaTeX document (routes/Document.tsx): the source with
 * syntax highlighting, `\cite{` offering the document's papers, and the
 * rendered document beside it or instead of it (`view`). The text is the
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
  /** The rendered document, as HTML. */
  preview: () => string;
  view: 'source' | 'preview' | 'split';
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

  return (
    <div class={`grid h-full min-h-0 min-w-0 gap-4 ${props.view === 'split' ? 'grid-cols-2' : 'grid-cols-1'}`}>
      <div ref={host} class={`tex-editor h-full min-h-0 min-w-0 ${props.view === 'preview' ? 'hidden' : ''}`} />
      <Show when={props.view !== 'source'}>
        <div class="scroll-quiet h-full min-h-0 min-w-0 overflow-y-auto rounded-[14px] border border-line px-5 py-4 sm:px-8 sm:py-6" aria-label="Preview">
          <Show when={props.preview().trim()} fallback={<p class="text-[14px] text-muted">The rendered document shows here.</p>}>
            <div class="lecture" innerHTML={props.preview()} />
          </Show>
        </div>
      </Show>
    </div>
  );
}
