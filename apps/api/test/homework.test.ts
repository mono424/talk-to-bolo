import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSheet } from '../../../shared/homework.ts';
import { lectureMarkdown } from '../../../shared/lecture.ts';

const brief = (parts: ReturnType<typeof parseSheet>) => parts.map((p) => `${p.key} ${p.label}|${p.points ?? '-'}|p${p.page ?? '-'}|${p.anchor}`);

test('a PDF problem set splits into questions, lettered parts and roman sub-parts', () => {
  const sheet = [
    '<!-- page 1 -->',
    '',
    'PHYS 101 HOMEWORK 3',
    'Instructions: show all work. Include labeled diagrams for',
    'Question 3.',
    'Question 1. Optics basics (20 points)',
    'Part (a). Refraction (10 points)',
    '(i) 4 points. State Snell’s law.',
    '(ii) 6 points. Derive the critical angle.',
    '<!-- page 2 -->',
    'Part (b). Lenses (10 points)',
    'A thin lens has focal length f = 5 cm.',
    '(i), 5 points. Find the image distance.',
    'Use the lens equation.',
    '(ii) 5 points. Is the image real?',
    'Question 2. Absorbance (20 points)',
    'A sample absorbs at 280 nm.',
    '(i) 10 points. Use Beer–Lambert.',
    '(c) 10 points. Discuss errors.',
    '<!-- page 3 -->',
    'Question 3. Design an assay (30 points)',
    'For each assay: (1) components; (2) observable.',
    '(1) identify its components;',
    '(2) explain the observable.',
    '<!-- page 4 -->',
    'Constants and useful relationships',
    'Planck constant, h 6.626e-34 J s',
  ].join('\n');
  const parts = parseSheet(sheet);
  assert.deepEqual(brief(parts), [
    '1.a.i a (i)|4|p1|Question 1',
    '1.a.ii a (ii)|6|p1|(ii)',
    '1.b.i b (i)|5|p2|Part (b)',
    '1.b.ii b (ii)|5|p2|(ii)',
    '2.i (i)|10|p2|Question 2',
    '2.c c|10|p2|(c)',
    '3 |30|p3|Question 3',
  ]);
  const b1 = parts[2];
  assert.equal(b1.questionTitle, 'Optics basics');
  assert.equal(b1.prompt, '5 points. Find the image distance.\nUse the lens equation.');
  assert.match(b1.context ?? '', /Lenses \(10 points\)\nA thin lens has focal length/);
  // Numbered items inside a question are its text, and the formula sheet is not.
  assert.match(parts[6].prompt, /\(1\) identify its components;\n\(2\) explain the observable\./);
  assert.doesNotMatch(parts[6].prompt, /Planck/);
});

test('a LaTeX sheet splits along its numbered sections and lists', () => {
  const tex = `\\documentclass{article}\\begin{document}
\\section*{Problem Set 1}
\\subsection*{1. Shift cipher (10 points)}
Break the shift cipher.
\\subsection*{2. Kerckhoffs}
Pick a tool and:
\\begin{enumerate}[label=(\\alph*)]
\\item Try it out.
\\item Check the source.
\\end{enumerate}
\\end{document}`;
  const parts = parseSheet(lectureMarkdown('tex', tex));
  assert.deepEqual(brief(parts), ['1 |10|p-|1.', '2.a a|-|p-|2.', '2.b b|-|p-|(b)']);
  assert.equal(parts[0].questionTitle, 'Shift cipher');
  assert.equal(parts[1].prompt, 'Try it out.');
});

test('a sheet without structure is one answer, and repeated labels stay unique', () => {
  assert.deepEqual(brief(parseSheet('Write an essay about light.')), ['1 Answer|-|p1|']);
  const twice = parseSheet('Question 1. A\n(i) x\n(i) y');
  assert.deepEqual(twice.map((p) => p.key), ['1.i', '1.i~2']);
  // "(i)" right after "(h)" is the letter i.
  const letters = parseSheet('Question 1. A\n(g) g\n(h) h\n(i) i\n(j) j');
  assert.deepEqual(letters.map((p) => p.key), ['1.g', '1.h', '1.i', '1.j']);
});
