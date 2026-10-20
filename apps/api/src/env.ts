import type { IngestParams } from './ingest';

export interface Env {
  AI: Ai;
  INGEST: Workflow<IngestParams>;

  APP_ORIGIN: string;
  SURREAL_URL: string;
  SURREAL_NS: string;
  SURREAL_DB: string;
  SURREAL_USER: string;
  SURREAL_PASS: string;

  ANTHROPIC_API_KEY: string;
  CLAUDE_MODEL: string;
  CLAUDE_PDF_MODEL: string;
  EMBEDDING_MODEL: string;

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
