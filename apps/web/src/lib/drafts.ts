import { createEffect, createSignal, onCleanup } from 'solid-js';
import { idString } from './ids';

/**
 * Text saved as you type: what the editor holds is a draft per row until it
 * is written, a moment after the last keystroke, on leaving the editor, or
 * when the page closes. Used for homework answers (a row per part) and for
 * documents (one row).
 */

const SAVE_DELAY_MS = 500;

export function createDrafts<R extends { id: unknown; content?: string | null }>(opts: {
  rows: () => readonly R[];
  save: (id: string, value: string) => Promise<unknown>;
}) {
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const text = (row: R) => drafts()[idString(row.id)] ?? row.content ?? '';
  const textOf = (id: string) => {
    const row = opts.rows().find((r) => idString(r.id) === id);
    return row ? text(row) : '';
  };

  // A saved draft stays until its row has caught up: the editor follows the
  // row, and must not be handed the text from before the save.
  const settling = new Map<string, { value: string; stale: string }>();
  const settle = (id: string, value: string) =>
    setDrafts((d) => {
      if (d[id] !== value) return d;
      const { [id]: _saved, ...rest } = d;
      return rest;
    });
  createEffect(() => {
    for (const row of opts.rows()) {
      const id = idString(row.id);
      const wait = settling.get(id);
      // The row now holds the save, or something newer from another device.
      if (wait && (row.content === wait.value || row.content !== wait.stale)) {
        settling.delete(id);
        settle(id, wait.value);
      }
    }
  });

  const save = (id: string) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const value = drafts()[id];
    if (value === undefined) return;
    void opts.save(id, value).then(() => {
      const row = opts.rows().find((r) => idString(r.id) === id);
      if (!row || row.content === value) settle(id, value);
      else settling.set(id, { value, stale: row.content ?? '' });
    });
  };
  const saveAll = () => {
    for (const id of [...timers.keys()]) save(id);
  };
  onCleanup(saveAll);

  const edit = (id: string, value: string) => {
    setDrafts((d) => ({ ...d, [id]: value }));
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => save(id), SAVE_DELAY_MS));
  };

  /** Some text is not saved yet. */
  const unsaved = () => Object.keys(drafts()).length > 0;

  return { text, textOf, edit, saveAll, unsaved };
}
