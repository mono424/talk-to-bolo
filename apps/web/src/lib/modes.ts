import type { CallMode } from './api';

export const MODES: { value: CallMode; label: string; hint: string }[] = [
  { value: 'explain', label: 'Explain it', hint: 'The tutor walks you through the lecture and checks in as you go.' },
  { value: 'quiz', label: 'Quiz me', hint: 'One question at a time, getting harder, with feedback on every answer.' },
  { value: 'qa', label: 'I ask', hint: 'You lead with questions, the tutor answers from your material.' },
];

export const modeLabel = (mode: string | null | undefined) => MODES.find((m) => m.value === mode)?.label ?? '';

/** A session the student held in an assistant (call.assistant) is marked with its name in lists. */
export const viaLabel = (assistant: string | null | undefined) => (assistant ? ` · ${assistant}` : '');
