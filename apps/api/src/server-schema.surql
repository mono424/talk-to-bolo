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


-- Receipts for confirmed conversation evidence. Separate from generated
-- transcript rows, with a stable observed time across retries.
DEFINE TABLE OVERWRITE learning_exchange SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE owner ON TABLE learning_exchange TYPE record<user>;
DEFINE FIELD OVERWRITE call ON TABLE learning_exchange TYPE record<call>;
DEFINE FIELD OVERWRITE observed_at ON TABLE learning_exchange TYPE datetime;
DEFINE FIELD OVERWRITE applied ON TABLE learning_exchange TYPE bool DEFAULT false;
DEFINE INDEX IF NOT EXISTS learning_exchange_call ON TABLE learning_exchange FIELDS call;
DEFINE TABLE OVERWRITE learning_focus SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE owner ON TABLE learning_focus TYPE record<user>;
DEFINE FIELD OVERWRITE call ON TABLE learning_focus TYPE record<call>;
DEFINE FIELD OVERWRITE material ON TABLE learning_focus TYPE record<material>;
DEFINE FIELD OVERWRITE rev ON TABLE learning_focus TYPE int;
DEFINE FIELD OVERWRITE position ON TABLE learning_focus TYPE int;
DEFINE FIELD OVERWRITE teaching ON TABLE learning_focus TYPE bool;
DEFINE INDEX IF NOT EXISTS learning_focus_call ON TABLE learning_focus FIELDS call;
DEFINE EVENT OVERWRITE learning_exchange_call_deleted ON TABLE call WHEN $event = 'DELETE' THEN {
  DELETE learning_exchange WHERE call = $before.id;
  DELETE learning_focus WHERE call = $before.id;
};

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
-- First and last PDF page the chunk was taken from (shared/lecture.ts
-- chunkPages). NONE for typed and Markdown material.
DEFINE FIELD OVERWRITE page ON TABLE chunk TYPE option<int>;
DEFINE FIELD OVERWRITE page_end ON TABLE chunk TYPE option<int>;
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

-- Images extracted from PDFs. The PNG is the file /assets/<id> of the
-- `materials` bucket (schema/buckets/materials.surql), never a field: a synced
-- table holding the bytes made the SSP keep every image in memory. The API
-- serves it at /material-assets/<id>; the id is random and unguessable.
DEFINE TABLE OVERWRITE asset SCHEMAFULL
  -- Server only: the web app reads it through this API, never through sync.
  COMMENT 'sp00ky:nosync'
  PERMISSIONS
    FOR select WHERE owner = $auth.id
    FOR create, update, delete WHERE false;

DEFINE FIELD OVERWRITE owner ON TABLE asset TYPE record<user>;
DEFINE FIELD OVERWRITE material ON TABLE asset TYPE record<material>;
DEFINE FIELD OVERWRITE page ON TABLE asset TYPE option<int>;
DEFINE FIELD OVERWRITE mime ON TABLE asset TYPE string;
DEFINE FIELD OVERWRITE width ON TABLE asset TYPE option<int>;
DEFINE FIELD OVERWRITE height ON TABLE asset TYPE option<int>;
-- The bytes moved to the `materials` bucket (scripts/migrate-files-to-bucket.surql).
REMOVE FIELD IF EXISTS data ON TABLE asset;
-- SHA-256 of the pixels: a logo repeated on every slide is dropped.
DEFINE FIELD OVERWRITE hash ON TABLE asset TYPE option<string>;
DEFINE FIELD OVERWRITE created_at ON TABLE asset TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS asset_material ON TABLE asset FIELDS material;

-- Every way a row goes (a re-run, the repeated-image pass, a deleted material)
-- takes its file with it.
DEFINE EVENT OVERWRITE asset_file ON TABLE asset WHEN $event = 'DELETE'
  THEN type::file('materials', '/assets/' + <string>record::id($before.id)).delete();

-- The uploaded PDF, split into parts of at most 1 MiB (SurrealDB's HTTP body
-- limit). The original, kept for the viewer and citations until the material
-- is deleted.
DEFINE TABLE OVERWRITE source_part SCHEMAFULL
  -- Server only: the web app reads it through this API, never through sync.
  COMMENT 'sp00ky:nosync'
  PERMISSIONS
    FOR select WHERE owner = $auth.id
    FOR create, update, delete WHERE false;

DEFINE FIELD OVERWRITE owner ON TABLE source_part TYPE record<user>;
DEFINE FIELD OVERWRITE material ON TABLE source_part TYPE record<material>;
DEFINE FIELD OVERWRITE idx ON TABLE source_part TYPE int;
-- The bytes moved to the `materials` bucket (scripts/migrate-files-to-bucket.surql).
REMOVE FIELD IF EXISTS data ON TABLE source_part;

DEFINE INDEX IF NOT EXISTS source_part_material ON TABLE source_part FIELDS material, idx UNIQUE;

-- The bytes are the file /sources/<id> of the `materials` bucket.
DEFINE EVENT OVERWRITE source_part_file ON TABLE source_part WHEN $event = 'DELETE'
  THEN type::file('materials', '/sources/' + <string>record::id($before.id)).delete();

-- The `agent` access (main schema) looks API keys up by hash on every MCP
-- sign-in.
DEFINE INDEX IF NOT EXISTS api_key_hash ON TABLE api_key FIELDS key_hash UNIQUE;

-- Public OAuth clients and short-lived authorization state. None of these
-- credentials or hashes are synced to the browser. A client is registered
-- here (DCR, `bolo_` ids) or identified by the https URL of its metadata
-- document (CIMD, `oauth_client:m<hash of the URL>`, refreshed on authorize).
DEFINE TABLE OVERWRITE oauth_client SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE client_id ON TABLE oauth_client TYPE string;
DEFINE FIELD OVERWRITE client_name ON TABLE oauth_client TYPE string;
DEFINE FIELD OVERWRITE redirect_uris ON TABLE oauth_client TYPE array<string>;
-- When a metadata document client's document was last read.
DEFINE FIELD OVERWRITE fetched_at ON TABLE oauth_client TYPE option<datetime>;
DEFINE FIELD OVERWRITE created_at ON TABLE oauth_client TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS oauth_client_id ON TABLE oauth_client FIELDS client_id UNIQUE;

DEFINE TABLE OVERWRITE oauth_request SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE client ON TABLE oauth_request TYPE record<oauth_client>;
DEFINE FIELD OVERWRITE redirect_uri ON TABLE oauth_request TYPE string;
DEFINE FIELD OVERWRITE state ON TABLE oauth_request TYPE option<string>;
-- The issuer the client discovered; the redirect back carries it as `iss`.
DEFINE FIELD OVERWRITE issuer ON TABLE oauth_request TYPE option<string>;
DEFINE FIELD OVERWRITE resource ON TABLE oauth_request TYPE string;
DEFINE FIELD OVERWRITE scope ON TABLE oauth_request TYPE string;
DEFINE FIELD OVERWRITE challenge ON TABLE oauth_request TYPE string;
DEFINE FIELD OVERWRITE expires_at ON TABLE oauth_request TYPE datetime;
DEFINE FIELD OVERWRITE consumed_at ON TABLE oauth_request TYPE option<datetime>;

-- Connections are listed beside personal keys in Settings, giving the
-- existing disconnect action immediate effect on this grant and its tokens.
DEFINE TABLE OVERWRITE oauth_grant SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE owner ON TABLE oauth_grant TYPE record<user>;
DEFINE FIELD OVERWRITE client ON TABLE oauth_grant TYPE record<oauth_client>;
DEFINE FIELD OVERWRITE connection ON TABLE oauth_grant TYPE record<api_key>;
DEFINE FIELD OVERWRITE resource ON TABLE oauth_grant TYPE string;
DEFINE FIELD OVERWRITE scope ON TABLE oauth_grant TYPE string;
DEFINE FIELD OVERWRITE expires_at ON TABLE oauth_grant TYPE datetime;
DEFINE FIELD OVERWRITE revoked_at ON TABLE oauth_grant TYPE option<datetime>;
DEFINE FIELD OVERWRITE created_at ON TABLE oauth_grant TYPE datetime DEFAULT time::now();

DEFINE TABLE OVERWRITE oauth_code SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE grant ON TABLE oauth_code TYPE record<oauth_grant>;
DEFINE FIELD OVERWRITE code_hash ON TABLE oauth_code TYPE string;
DEFINE FIELD OVERWRITE redirect_uri ON TABLE oauth_code TYPE string;
DEFINE FIELD OVERWRITE challenge ON TABLE oauth_code TYPE string;
DEFINE FIELD OVERWRITE expires_at ON TABLE oauth_code TYPE datetime;
DEFINE FIELD OVERWRITE consumed_at ON TABLE oauth_code TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS oauth_code_hash ON TABLE oauth_code FIELDS code_hash UNIQUE;

DEFINE TABLE OVERWRITE oauth_refresh SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE grant ON TABLE oauth_refresh TYPE record<oauth_grant>;
DEFINE FIELD OVERWRITE token_hash ON TABLE oauth_refresh TYPE string;
DEFINE FIELD OVERWRITE expires_at ON TABLE oauth_refresh TYPE datetime;
DEFINE FIELD OVERWRITE consumed_at ON TABLE oauth_refresh TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS oauth_refresh_hash ON TABLE oauth_refresh FIELDS token_hash UNIQUE;

DEFINE TABLE OVERWRITE oauth_access SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD OVERWRITE grant ON TABLE oauth_access TYPE record<oauth_grant>;
DEFINE FIELD OVERWRITE owner ON TABLE oauth_access TYPE record<user>;
DEFINE FIELD OVERWRITE token_hash ON TABLE oauth_access TYPE string;
DEFINE FIELD OVERWRITE expires_at ON TABLE oauth_access TYPE datetime;
DEFINE FIELD OVERWRITE revoked_at ON TABLE oauth_access TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS oauth_access_hash ON TABLE oauth_access FIELDS token_hash UNIQUE;

-- Opaque OAuth access tokens become ordinary owner-scoped sessions, keeping
-- every MCP tool behind the same table permissions as the signed-in app.
-- Unlike fields, access definitions generate a signing key. Keep it stable
-- across Worker isolates; changes to this definition require a migration.
DEFINE ACCESS IF NOT EXISTS oauth_agent ON DATABASE TYPE RECORD
  SIGNIN (
    SELECT * FROM user WHERE id = (
      SELECT VALUE owner FROM oauth_access WHERE token_hash = crypto::sha256($oauth_key)
        AND revoked_at = NONE AND expires_at > time::now()
        AND grant.revoked_at = NONE AND grant.expires_at > time::now()
        AND grant.connection.id != NONE AND grant.connection.revoked_at = NONE AND grant.connection.owner = owner AND grant.owner = owner LIMIT 1
    )[0]
  )
  DURATION FOR TOKEN 1h, FOR SESSION 1h
;
