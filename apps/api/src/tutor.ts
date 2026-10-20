import { cleanForIndex } from './chunk';
import type { CourseRow, MaterialRow } from './service';

export type CallMode = 'explain' | 'quiz' | 'qa';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
  pt: 'Portuguese',
  pl: 'Polish',
  tr: 'Turkish',
};

export const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code;

/** Above this the whole lecture no longer goes into the prompt; search covers it. */
const FULL_TEXT_LIMIT = 150_000;

const MODE_GUIDE: Record<CallMode, string> = {
  explain: `Walk the student through the material in its order, one idea at a time. Explain each idea simply with an example, then check understanding with one short question before moving on. Keep track of where you are and do not skip ahead unless the student asks. If an answer shows a gap, explain it another way.`,
  quiz: `Quiz the student on the material. Ask one question at a time, starting easy and getting harder. Mix recall, "why" and application questions, and vary the topics. After each answer, say whether it was right, correct it briefly if not, and ask the next question. Every five questions or so, say how they are doing and which topic to review.`,
  qa: `The student leads. Answer their questions precisely and briefly from the material, then check whether that helped or offer a related point worth knowing. If they run out of questions, suggest an important topic from the material they have not asked about.`,
};

/**
 * The tutor's system prompt for a call. Stable for the whole call (it is
 * prompt-cached): the per-turn search results are added separately.
 */
export function tutorSystemPrompt(input: {
  course: CourseRow;
  material: MaterialRow | null;
  outline: { title: string; headings: string[] }[];
  mode: CallMode;
  studentName: string;
}): string {
  const { course, material, outline, mode, studentName } = input;
  const lang = languageName(course.language);
  const parts: string[] = [
    `You are Bolo, the TalkToBolo tutor for the course "${course.title}", on a live voice call with ${studentName}, a student. Everything you write is spoken aloud by a text-to-speech voice, and you hear the student through speech recognition.`,
    `How to talk:
- Like a good tutor in office hours: warm, clear and concise. Usually one to three sentences per turn, then hand the turn back.
- Plain spoken language only. No markdown, lists, headings, emojis, URLs or symbols. Read math out loud in words ("x squared plus one", "the integral from zero to one of f of x").
- One question at a time, then wait for the answer.
- Speech recognition makes mistakes: if a word makes no sense, go with the closest sensible reading, or ask.
- If the student interrupts or changes the subject, follow them.
- Speak ${lang}. Keep technical terms as the material uses them.
- Teach from the course material below. If it does not cover something, say so in a few words and answer from general knowledge.
- When the student wants to stop or says goodbye, give a one-sentence recap of what to review, say goodbye, and use the end_call tool.`,
    `What this call is for: ${MODE_GUIDE[mode]}`,
  ];
  if (course.description) parts.push(`About the course: ${course.description}`);
  if (course.tutor_notes) parts.push(`The student's instructions for you: ${course.tutor_notes}`);

  if (material) {
    const text = cleanForIndex(material.content);
    if (text.length <= FULL_TEXT_LIMIT) {
      parts.push(`The lecture for this call, "${material.title}":\n<lecture>\n${text}\n</lecture>`);
    } else {
      parts.push(
        `The lecture for this call is "${material.title}". It is long, so you get its outline here and the passages relevant to each turn alongside the conversation.\n<outline>\n${headingsOf(material.content).join('\n')}\n</outline>`,
      );
    }
  }
  if (!material || outline.length > 1) {
    const list = outline
      .map((m) => `- ${m.title}${m.headings.length ? `: ${m.headings.slice(0, 25).join('; ')}` : ''}`)
      .join('\n');
    parts.push(
      `${material ? 'Other material in the course' : 'The course material'} (passages relevant to each turn are added alongside the conversation):\n<materials>\n${list || '(none yet)'}\n</materials>`,
    );
  }
  return parts.join('\n\n');
}

export function headingsOf(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) out.push(`${'  '.repeat(m[1].length - 1)}${m[2].trim()}`);
  }
  return out;
}

const FIRST: Record<string, Record<CallMode, (name: string, topic: string) => string>> = {
  en: {
    explain: (n, t) => `Hi ${n}! Let's go through ${t} together. I'll explain it step by step and check in with you along the way. Ready to start?`,
    quiz: (n, t) => `Hi ${n}! Quiz time on ${t}. I'll ask one question at a time, starting easy. Ready for the first one?`,
    qa: (n, t) => `Hi ${n}! I have ${t} in front of me. What would you like to go over?`,
  },
  de: {
    explain: (n, t) => `Hallo ${n}! Lass uns ${t} zusammen durchgehen. Ich erkläre es Schritt für Schritt und frage zwischendurch nach. Bereit?`,
    quiz: (n, t) => `Hallo ${n}! Zeit für ein Quiz zu ${t}. Ich stelle dir eine Frage nach der anderen, erst leicht, dann schwerer. Bereit für die erste?`,
    qa: (n, t) => `Hallo ${n}! Ich habe ${t} vor mir. Was möchtest du durchgehen?`,
  },
  fr: {
    explain: (n, t) => `Bonjour ${n} ! Parcourons ${t} ensemble. Je vais l'expliquer étape par étape et vérifier avec toi en chemin. On commence ?`,
    quiz: (n, t) => `Bonjour ${n} ! C'est l'heure du quiz sur ${t}. Une question à la fois, en commençant facile. On commence par la première ?`,
    qa: (n, t) => `Bonjour ${n} ! J'ai ${t} sous les yeux. Qu'est-ce que tu veux revoir ?`,
  },
  es: {
    explain: (n, t) => `¡Hola ${n}! Repasemos ${t} juntos. Te lo explico paso a paso y voy comprobando contigo. ¿Empezamos?`,
    quiz: (n, t) => `¡Hola ${n}! Hora del quiz sobre ${t}. Una pregunta cada vez, empezando por lo fácil. ¿Empezamos con la primera?`,
    qa: (n, t) => `¡Hola ${n}! Tengo ${t} delante. ¿Qué quieres repasar?`,
  },
};

/** What the tutor says when the call connects, in the course language. */
export function firstMessage(language: string, mode: CallMode, studentName: string, topic: string): string {
  const table = FIRST[language] ?? FIRST.en;
  return table[mode](studentName, topic);
}

export const RECAP_SYSTEM = `You write a short study recap of a voice tutoring session, for the student to read afterwards. Use Markdown with these three short sections, and nothing else:

## What we covered
## How it went
## Review next

Be specific to the conversation: name the concepts, the questions the student got right or wrong, and the misunderstandings that came up. Keep it under 200 words. Write in the language of the conversation.`;
