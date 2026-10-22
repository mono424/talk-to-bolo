/**
 * Takes the tutor's citation markers out of a streamed reply before it is
 * spoken. The tutor writes `[3]`, `[3, 5]` or `[3][5]` after a sentence that
 * uses a numbered passage; the voice must not read them, and the transcript
 * shows them as links instead.
 *
 * Text arrives in arbitrary pieces, so a piece ending in `[1` is held until it
 * is clear whether a marker follows, and so is trailing whitespace ("claim
 * [3]." becomes "claim."). Any other bracket passes through unchanged.
 */
export interface Citation {
  ref: number;
  /** Characters of clean text before the marker. */
  at: number;
}

const MARKER = /^\[\d{1,2}(?:\s*,\s*\d{1,2})*\]$/;
const MARKER_PREFIX = /^\[(?:\d{1,2}(?:\s*,\s*\d{1,2})*(?:\s*,?\s*)?)?$/;
const MAX_MARKER = 16;

export class CitationFilter {
  readonly citations: Citation[] = [];
  private length = 0;
  private space = '';
  private marker: string | null = null;
  private out = '';

  /** Feeds one piece of the reply; returns the clean text that may go out now. */
  push(text: string): string {
    for (const c of text) this.char(c);
    return this.take();
  }

  /** The text still held back, at the end of the reply. */
  flush(): string {
    this.emit(this.space + (this.marker ?? ''));
    this.space = '';
    this.marker = null;
    return this.take();
  }

  private char(c: string) {
    if (this.marker !== null) {
      const next = this.marker + c;
      if (MARKER.test(next)) {
        for (const n of next.match(/\d+/g) ?? []) this.citations.push({ ref: Number(n), at: this.length });
        // The space before a marker goes with it.
        this.space = '';
        this.marker = null;
      } else if (next.length <= MAX_MARKER && MARKER_PREFIX.test(next)) {
        this.marker = next;
      } else {
        // Not a marker after all: what was held is text, and `c` starts afresh.
        this.emit(this.space + this.marker);
        this.space = '';
        this.marker = null;
        this.char(c);
      }
    } else if (c === '[') {
      this.marker = c;
    } else if (/\s/.test(c)) {
      this.space += c;
    } else {
      this.emit(this.space + c);
      this.space = '';
    }
  }

  private emit(s: string) {
    this.out += s;
    this.length += s.length;
  }

  private take(): string {
    const s = this.out;
    this.out = '';
    return s;
  }
}
