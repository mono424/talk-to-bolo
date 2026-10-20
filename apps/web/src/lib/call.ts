import { Conversation, type VoiceConversation } from '@elevenlabs/client';
import { createSignal, onCleanup } from 'solid-js';
import { endCall, startCall, type CallMode } from './api';
import type { Db } from './query';

export type CallPhase = 'idle' | 'connecting' | 'live' | 'ending' | 'ended' | 'error';

/**
 * One voice call with the tutor. ElevenLabs runs the audio (speech in, turn
 * taking, speech out) over WebRTC; every reply comes from Claude through the
 * API Worker, which also writes the transcript to SurrealDB.
 */
export function useTutorCall(db: Db) {
  const [phase, setPhase] = createSignal<CallPhase>('idle');
  const [callId, setCallId] = createSignal<string | null>(null);
  const [speaking, setSpeaking] = createSignal(false);
  const [level, setLevel] = createSignal(0);
  const [muted, setMuted] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let conversation: VoiceConversation | undefined;
  let conversationId: string | null = null;
  let raf = 0;

  // Whoever is talking drives the orb: the tutor's voice while it speaks,
  // the microphone while it listens.
  const meter = () => {
    if (conversation) {
      const v = speaking() ? conversation.getOutputVolume() : conversation.getInputVolume();
      setLevel((prev) => prev * 0.6 + v * 0.4);
    }
    raf = requestAnimationFrame(meter);
  };

  async function start(input: { courseId: string; materialId?: string | null; mode: CallMode }) {
    if (phase() === 'connecting' || phase() === 'live') return;
    setError(null);
    setPhase('connecting');
    try {
      // Ask for the microphone first, so a denied permission fails before a
      // call row is created.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());

      const started = await startCall(db, input);
      setCallId(started.callId);

      conversation = (await Conversation.startSession({
        conversationToken: started.conversationToken,
        connectionType: 'webrtc',
        dynamicVariables: {
          student_name: started.studentName,
          call_id: started.callId,
          secret__call_key: started.callKey,
        },
        overrides: {
          agent: { firstMessage: started.firstMessage, language: started.language as never },
        },
        onConnect: ({ conversationId: id }) => {
          conversationId = id;
          setPhase('live');
        },
        onModeChange: ({ mode }) => setSpeaking(mode === 'speaking'),
        onDisconnect: () => {
          if (phase() === 'live' || phase() === 'connecting') void finish();
        },
        onError: (message) => {
          console.error('[call]', message);
          setError(typeof message === 'string' ? message : 'The call dropped.');
        },
      })) as VoiceConversation;
      cancelAnimationFrame(raf);
      meter();
    } catch (err) {
      console.error('[call] start failed', err);
      setError(describe(err));
      setPhase('error');
      await conversation?.endSession().catch(() => {});
      conversation = undefined;
    }
  }

  async function finish() {
    if (phase() === 'ending' || phase() === 'ended') return;
    setPhase('ending');
    cancelAnimationFrame(raf);
    setLevel(0);
    const c = conversation;
    conversation = undefined;
    await c?.endSession().catch(() => {});
    const id = callId();
    if (id) await endCall(db, id, conversationId).catch((err) => console.error('[call] end failed', err));
    setPhase('ended');
  }

  function toggleMute() {
    const next = !muted();
    conversation?.setMicMuted(next);
    setMuted(next);
  }

  onCleanup(() => {
    if (conversation) void finish();
  });

  return { phase, callId, speaking, level, muted, error, start, finish, toggleMute };
}

function describe(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Microphone access is blocked. Allow it in the browser’s site settings, then start the call again.';
  }
  if (err instanceof Error) return err.message;
  return 'The call could not start.';
}
