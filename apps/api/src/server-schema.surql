-- ##################################################################
-- SERVER-ONLY TABLES, owned by the API Worker
--
-- Not part of the sp00ky schema (schema/src/schema.surql): nothing here is
-- synced to the client, and the vector/full-text index syntax is SurrealDB 3,
-- which sp00ky's schema parser does not read yet. The Worker applies this file
-- once per isolate (see ensureServerSchema in src/service.ts), so it must stay
-- idempotent: indexes and the analyzer use IF NOT EXISTS, because redefining
-- an index rebuilds it. To change one, REMOVE it by hand first.
--
-- The `material_deleted` / `course_deleted` events in the main schema clean
-- these tables up.
-- ##################################################################


-- Search sections of a material. Written by the API Worker only. Readable by
-- the owner so the API can run the search with the user's own session.
DEFINE TABLE OVERWRITE chunk SCHEMAFULL
  PERMISSIONS
    FOR select WHERE owner = $auth.id
    FOR create, update, delete WHERE false;

DEFINE FIELD OVERWRITE owner ON TABLE chunk TYPE record<user>;
DEFINE FIELD OVERWRITE course ON TABLE chunk TYPE record<course>;
DEFINE FIELD OVERWRITE material ON TABLE chunk TYPE record<material>;
DEFINE FIELD OVERWRITE rev ON TABLE chunk TYPE int;
DEFINE FIELD OVERWRITE position ON TABLE chunk TYPE int;
-- The heading path the chunk sits under ("Week 3 > Gradient descent").
DEFINE FIELD OVERWRITE heading ON TABLE chunk TYPE option<string>;
DEFINE FIELD OVERWRITE text ON TABLE chunk TYPE string;
DEFINE FIELD OVERWRITE embedding ON TABLE chunk TYPE array<float>;
DEFINE FIELD OVERWRITE created_at ON TABLE chunk TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS chunk_course ON TABLE chunk FIELDS course;
DEFINE INDEX IF NOT EXISTS chunk_material ON TABLE chunk FIELDS material;

-- Semantic search. 1024 = @cf/qwen/qwen3-embedding-0.6b (multilingual) on
-- Workers AI; change both together.
DEFINE INDEX IF NOT EXISTS chunk_embedding ON TABLE chunk FIELDS embedding
  HNSW DIMENSION 1024 DIST COSINE TYPE F32;

-- Keyword search, combined with the vector hits (hybrid search). No stemmer:
-- lecture material comes in any language.
DEFINE ANALYZER IF NOT EXISTS lecture_text TOKENIZERS blank, class, punct FILTERS lowercase, ascii;
DEFINE INDEX IF NOT EXISTS chunk_text ON TABLE chunk FIELDS text FULLTEXT ANALYZER lecture_text BM25;

-- Images extracted from PDFs, stored as bytes. The API serves them at
-- /assets/<id>; the id is random and unguessable.
DEFINE TABLE OVERWRITE asset SCHEMAFULL
  PERMISSIONS
    FOR select WHERE owner = $auth.id
    FOR create, update, delete WHERE false;

DEFINE FIELD OVERWRITE owner ON TABLE asset TYPE record<user>;
DEFINE FIELD OVERWRITE material ON TABLE asset TYPE record<material>;
DEFINE FIELD OVERWRITE page ON TABLE asset TYPE option<int>;
DEFINE FIELD OVERWRITE mime ON TABLE asset TYPE string;
DEFINE FIELD OVERWRITE width ON TABLE asset TYPE option<int>;
DEFINE FIELD OVERWRITE height ON TABLE asset TYPE option<int>;
DEFINE FIELD OVERWRITE data ON TABLE asset TYPE bytes;
-- SHA-256 of the pixels: a logo repeated on every slide is dropped.
DEFINE FIELD OVERWRITE hash ON TABLE asset TYPE option<string>;
DEFINE FIELD OVERWRITE created_at ON TABLE asset TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS asset_material ON TABLE asset FIELDS material;

-- The uploaded PDF, split into parts of at most 1 MiB (SurrealDB's HTTP body
-- limit). Kept so a material can be re-processed.
DEFINE TABLE OVERWRITE source_part SCHEMAFULL
  PERMISSIONS
    FOR select WHERE owner = $auth.id
    FOR create, update, delete WHERE false;

DEFINE FIELD OVERWRITE owner ON TABLE source_part TYPE record<user>;
DEFINE FIELD OVERWRITE material ON TABLE source_part TYPE record<material>;
DEFINE FIELD OVERWRITE idx ON TABLE source_part TYPE int;
DEFINE FIELD OVERWRITE data ON TABLE source_part TYPE bytes;

DEFINE INDEX IF NOT EXISTS source_part_material ON TABLE source_part FIELDS material, idx UNIQUE;

-- The `agent` access (main schema) looks API keys up by hash on every MCP
-- sign-in.
DEFINE INDEX IF NOT EXISTS api_key_hash ON TABLE api_key FIELDS key_hash UNIQUE;
