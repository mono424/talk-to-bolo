import type { IngestParams } from './ingest';

export interface Env {
  AI: Ai;
  INGEST: Workflow<IngestParams>;

  APP_ORIGIN: string;
  /** Public API origin used for OAuth issuer and MCP audience, when proxied. */
  API_ORIGIN?: string;
  SURREAL_URL: string;
  SURREAL_NS: string;
  SURREAL_DB: string;
  SURREAL_USER: string;
  SURREAL_PASS: string;
  SURREAL_AUTH_NS?: string;
  SURREAL_AUTH_DB?: string;

  ANTHROPIC_API_KEY: string;
  CLAUDE_MODEL: string;
  CLAUDE_PDF_MODEL: string;
  EMBEDDING_MODEL: string;

  /** SurrealDB Agent Memory Context API base, including /api/v1/{context_id}. */
  AGENT_MEMORY_URL?: string;
  AGENT_MEMORY_API_KEY?: string;

  ELEVENLABS_API_KEY: string;
  ELEVENLABS_AGENT_ID: string;
  LLM_SHARED_SECRET: string;
}

/** Identity of the signed-in user behind a request. */
export interface Caller {
  userId: string;
  token: string;
}

export type AppEnv = { Bindings: Env; Variables: { caller: Caller } };
