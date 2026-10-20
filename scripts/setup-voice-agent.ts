/**
 * Creates (or updates) the ElevenLabs voice agent that Studycall calls run on.
 *
 * The agent does speech-to-text, turn taking, interruptions and text-to-speech.
 * Its "brain" is a Custom LLM: the API Worker's OpenAI-compatible endpoint at
 * `<API_URL>/llm/v1/chat/completions`, which builds the tutor prompt from the
 * course in SurrealDB, retrieves lecture context and streams Claude's answer.
 *
 * Usage (from the repo root):
 *   ELEVENLABS_API_KEY=... API_URL=https://studycall-api.<you>.workers.dev \
 *   LLM_SHARED_SECRET=... pnpm setup:voice
 *
 * Re-run with ELEVENLABS_AGENT_ID=... to update the existing agent in place.
 * Prints the agent id: set it as the Worker's ELEVENLABS_AGENT_ID.
 */

const XI = 'https://api.elevenlabs.io';

const env = (name: string, fallback?: string): string => {
  const v = process.env[name]?.trim() || fallback;
  if (!v) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }
  return v;
};

const apiKey = env('ELEVENLABS_API_KEY');
const apiUrl = env('API_URL').replace(/\/+$/, '');
const llmSecret = env('LLM_SHARED_SECRET');
const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
// A premade ElevenLabs voice. Pick another in the ElevenLabs voice library and
// pass its id to change how the tutor sounds.
const voiceId = env('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM');
const model = env('CLAUDE_MODEL', 'claude-opus-5-5');

async function xi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${XI}${path}`, {
    method,
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function main() {
  // The shared secret the agent presents to the Worker's LLM endpoint
  // (`Authorization: Bearer <secret>`), stored as a workspace secret so it
  // never sits in the agent config in plain text.
  const secret = await xi<{ secret_id: string }>('POST', '/v1/convai/secrets', {
    type: 'new',
    name: `studycall-llm-${Date.now()}`,
    value: llmSecret,
  });

  const config = {
    name: 'Studycall tutor',
    conversation_config: {
      agent: {
        // Overridden per call by the Worker's first message for the mode.
        first_message: 'Hi {{student_name}}, ready when you are.',
        language: 'en',
        dynamic_variables: {
          dynamic_variable_placeholders: {
            student_name: 'there',
            call_id: '',
            secret__call_key: '',
          },
        },
        prompt: {
          // The Worker replaces this with the real tutor prompt, built from the
          // course in SurrealDB. Kept here only as a fallback description.
          prompt: 'You are a friendly spoken study tutor.',
          llm: 'custom-llm',
          // Claude takes no sampling parameters: leave temperature out.
          temperature: null,
          custom_llm: {
            url: `${apiUrl}/llm/v1`,
            model_id: model,
            api_key: { secret_id: secret.secret_id },
            api_type: 'chat_completions',
            // Which call this is, and the per-call key proving it. The key is a
            // `secret__` variable, so it never reaches a prompt or a log.
            request_headers: {
              'X-Call-Id': { variable_name: 'call_id' },
              'X-Call-Key': { variable_name: 'secret__call_key' },
            },
          },
          built_in_tools: {
            end_call: {
              type: 'system',
              name: 'end_call',
              description: 'End the call when the student says goodbye or asks to stop.',
              params: { system_tool_type: 'end_call' },
            },
          },
          backup_llm_config: { preference: 'disabled' },
        },
      },
      tts: {
        // Multilingual and low latency: the tutor speaks the course language.
        model_id: 'eleven_flash_v2_5',
        voice_id: voiceId,
        stability: 0.5,
        similarity_boost: 0.8,
        speed: 1.0,
      },
      asr: {
        provider: 'scribe_realtime',
        quality: 'high',
        user_input_audio_format: 'pcm_16000',
      },
      turn: {
        mode: 'turn',
        turn_eagerness: 'patient',
        turn_timeout: 10,
        // While Claude thinks and the lecture is searched, say something short
        // instead of going silent.
        soft_timeout_config: { timeout_seconds: 3, message: 'Hmm, let me think.' },
      },
      conversation: { max_duration_seconds: 3600 },
    },
    platform_settings: {
      // Calls only start with a conversation token the Worker requested.
      auth: { enable_auth: true },
      overrides: {
        conversation_config_override: {
          agent: { first_message: true, language: true },
        },
      },
    },
  };

  if (agentId) {
    await xi('PATCH', `/v1/convai/agents/${agentId}`, config);
    console.log(`Updated agent ${agentId}`);
  } else {
    const created = await xi<{ agent_id: string }>('POST', '/v1/convai/agents/create', config);
    console.log(`Created agent ${created.agent_id}`);
    console.log('\nSet it on the Worker:');
    console.log(`  pnpm --filter @studycall/api exec wrangler secret put ELEVENLABS_AGENT_ID   # ${created.agent_id}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
