import Anthropic from '@anthropic-ai/sdk';
import type { Env } from './env';

export const claude = (env: Env) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });

/**
 * On a safety decline the API re-runs the request on Anthropic's recommended
 * fallback model inside the same call, instead of returning a refusal. A voice
 * tutor would otherwise go silent mid-call.
 */
export const FALLBACK = {
  betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: 'default' as const,
};

/** All text blocks of a message, joined. */
export const textOf = (msg: Anthropic.Beta.BetaMessage) =>
  msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
