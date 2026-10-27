import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latexToMarkdown, markdownMacros } from '../../../shared/latex.ts';
import { chunkMarkdown, lectureMarkdown } from '../../../shared/lecture.ts';

const doc = (body: string, preamble = '') => `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

test('a problem set becomes sections with its math and macros', () => {
  const md = latexToMarkdown(doc(
    `\\section*{CS 171: Problem Set 1\\\\ {\\small Due: \\duedate}}
\\subsection*{1. Shift cipher (10 points)} % graded
Break it with keys $k_1, k_2 \\in \\Z$, i.e.\\ 50\\% of \\$ cases --- easily.
\\[ \\Enc_k(m) = m + k \\bmod 26 \\]`,
    '\\newcommand{\\Z}{\\mathbb{Z}}\n\\newcommand{\\Enc}{\\mathsf{Enc}}\n\\newcommand{\\duedate}{September 11}',
  ));
  assert.equal(markdownMacros(md), '\\newcommand{\\Z}{\\mathbb{Z}}\n\\newcommand{\\Enc}{\\mathsf{Enc}}\n\\newcommand{\\duedate}{September 11}');
  const body = md.slice(md.indexOf('-->') + 3).trim();
  assert.equal(body, [
    '## CS 171: Problem Set 1 - Due: September 11',
    '',
    '### 1. Shift cipher (10 points)',
    '',
    'Break it with keys $k_1, k_2 \\in \\Z$, i.e. 50% of $ cases - easily.',
    '',
    '$$',
    '\\Enc_k(m) = m + k \\bmod 26',
    '$$',
  ].join('\n'));
  // Sections come from the converted text; the macros comment is not indexed.
  const chunks = chunkMarkdown(lectureMarkdown('tex', doc('\\section{A}\nSome text about ciphers and keys.', '\\newcommand{\\x}{y}')));
  assert.deepEqual(chunks.map((c) => c.heading), ['A']);
  assert.doesNotMatch(chunks[0].text, /newcommand/);
  assert.equal(lectureMarkdown('markdown', '# Same'), '# Same');
});

test('lists, environments, tables and verbatim', () => {
  const md = latexToMarkdown(doc(`\\title{Notes}\\author{Ada \\and Alan}\\maketitle
\\begin{theorem}[Shannon]
Perfect secrecy needs $|K| \\ge |M|$.
\\end{theorem}
\\begin{align*}
a &= b \\\\
c &= d
\\end{align*}
\\begin{enumerate}[label=(\\alph*)]
  \\item First \\textbf{bold} and \\emph{it}
  \\begin{itemize}
    \\item nested \\texttt{code}
  \\end{itemize}
  \\item Second, see \\href{https://x.example}{the site}
\\end{enumerate}
\\begin{tabular}{|l|c|}\\hline
Scheme & Secure? \\\\ \\hline
OTP & yes \\\\
\\end{tabular}
\\begin{verbatim}
  x % 2
\\end{verbatim}
\\begin{proof}
Trivial.
\\end{proof}
Vigen\\\`{e}re and na\\"ive.`));
  assert.equal(md, [
    '# Notes',
    '',
    'Ada, Alan',
    '',
    '**Theorem (Shannon).** Perfect secrecy needs $|K| \\ge |M|$.',
    '',
    '$$',
    '\\begin{aligned}a &= b \\\\',
    'c &= d\\end{aligned}',
    '$$',
    '',
    '- (a) First **bold** and _it_',
    '',
    '  - nested `code`',
    '- (b) Second, see [the site](https://x.example)',
    '',
    '| Scheme | Secure? |',
    '| --- | --- |',
    '| OTP | yes |',
    '',
    '```',
    '  x % 2',
    '```',
    '',
    '_Proof._ Trivial. ∎',
    '',
    'Vigenère and naïve.',
  ].join('\n'));
});

test('fragments and malformed input never throw', () => {
  assert.equal(latexToMarkdown('Just $x$ and \\unknown{kept} \\relax'), 'Just $x$ and kept');
  for (const bad of ['\\begin{itemize}\\item open', '{{{', '$unclosed', '\\section{', '\\newcommand{\\a}{\\a}\\a', '\\newcommand{\\a}{\\a\\a}\\a', '']) {
    assert.equal(typeof latexToMarkdown(bad), 'string');
  }
});

test('colors stay as spans when asked, and only their text otherwise', () => {
  const tex = doc(
    `\\placeholder{TBD} and \\textcolor[HTML]{00FF7F}{mint}, \\textcolor{red!50!black}{dark}, \\colorbox{note}{boxed}, \\textcolor{nosuch}{plain}.`,
    `\\usepackage{xcolor}\n\\definecolor{note}{rgb}{1,1,0.5}\n\\newcommand{\\placeholder}[1]{\\textcolor{red}{#1}}`,
  );
  assert.equal(latexToMarkdown(tex).split('\n').at(-1), 'TBD and mint, dark, boxed, plain.');
  assert.equal(
    latexToMarkdown(tex, { colors: true }).split('\n').at(-1),
    '<span style="color:#ff0000">TBD</span> and <span style="color:#00ff7f">mint</span>, <span style="color:#800000">dark</span>, <span style="background-color:#ffff80">boxed</span>, plain.',
  );
});
