import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CitationFilter } from '../src/citations.ts';

const run = (pieces: string[]) => {
  const f = new CitationFilter();
  const text = pieces.map((p) => f.push(p)).join('') + f.flush();
  return { text, citations: f.citations };
};

test('markers leave the spoken text, with the space before them', () => {
  const r = run(['A group has an identity [3]. It is unique [3][5] too.']);
  assert.equal(r.text, 'A group has an identity. It is unique too.');
  const second = 'A group has an identity. It is unique'.length;
  assert.deepEqual(r.citations, [
    { ref: 3, at: 'A group has an identity'.length },
    { ref: 3, at: second },
    { ref: 5, at: second },
  ]);
});

test('markers split across pieces are still recognized', () => {
  const r = run(['Inverses exist ', '[', '1', '2', ', ', '4', ']', '. Next']);
  assert.equal(r.text, 'Inverses exist. Next');
  assert.deepEqual(r.citations.map((c) => c.ref), [12, 4]);
  assert.equal(r.citations[0].at, 'Inverses exist'.length);
});

test('other brackets pass through unchanged', () => {
  for (const s of ['the interval [a, b] here', 'see [123] now', 'odd [[2]] case', 'list [] empty', 'tail [7']) {
    const r = run([s]);
    if (s === 'odd [[2]] case') {
      assert.equal(r.text, 'odd [] case');
      assert.deepEqual(r.citations.map((c) => c.ref), [2]);
    } else {
      assert.equal(r.text, s);
      assert.deepEqual(r.citations, []);
    }
  }
});

test('whitespace is held only until the next word', () => {
  const f = new CitationFilter();
  assert.equal(f.push('Hello '), 'Hello');
  assert.equal(f.push('there'), ' there');
  assert.equal(f.push('\n\n'), '');
  assert.equal(f.flush(), '\n\n');
});
