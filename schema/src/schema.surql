-- ##################################################################
-- STUDYCALL SCHEMA
--
-- Source of truth for the database. `spky generate` turns it into the typed
-- client schema (apps/web/src/schema.gen.ts). Tables the client never syncs
-- (search chunks with their embeddings, extracted images, the parts of each
-- uploaded PDF) live in apps/api/src/server-schema.surql, and their bytes are
-- files in the `materials` bucket (schema/buckets/materials.surql).
-- ##################################################################

-- ##################################################################
-- ACCESS
-- ##################################################################

-- Email + password accounts for the web app.
DEFINE ACCESS OVERWRITE account ON DATABASE TYPE RECORD
  SIGNUP {
    RETURN CREATE ONLY user SET
      email    = string::lowercase($email),
      name     = $name,
      password = crypto::argon2::generate($password);
  }
  SIGNIN ( SELECT * FROM user WHERE email = string::lowercase($email) AND crypto::argon2::compare(password, $password) )
  -- The API Worker checks this token on every request (it asks SurrealDB for
  -- `$auth.id`), and the client has no refresh flow, so the token lives as
  -- long as the session.
  DURATION FOR TOKEN 30d, FOR SESSION 30d
;

-- AI clients (the MCP server) sign in with a personal API key the user created
-- in Settings. The session they get IS the key's owner, so every permission
-- below applies to them unchanged. Only the key's SHA-256 is stored.
DEFINE ACCESS OVERWRITE agent ON DATABASE TYPE RECORD
  SIGNIN (
    SELECT * FROM user WHERE id = (
      SELECT VALUE owner FROM api_key WHERE key_hash = crypto::sha256($key) AND revoked_at = NONE LIMIT 1
    )[0]
  )
  DURATION FOR TOKEN 1h, FOR SESSION 1h
;

-- ##################################################################
-- USER
-- ##################################################################

DEFINE TABLE OVERWRITE user SCHEMAFULL
  PERMISSIONS
    FOR select, update WHERE id = $auth.id
    FOR create, delete WHERE false;

DEFINE FIELD OVERWRITE email ON TABLE user TYPE string
  ASSERT string::contains($value, "@")
  PERMISSIONS FOR update WHERE false;
DEFINE INDEX OVERWRITE unique_email ON TABLE user FIELDS email UNIQUE;

DEFINE FIELD OVERWRITE name ON TABLE user TYPE string
  ASSERT string::len($value) > 0;

DEFINE FIELD OVERWRITE password ON TABLE user TYPE string
  PERMISSIONS FOR select, update WHERE false;

DEFINE FIELD OVERWRITE created_at ON TABLE user TYPE datetime DEFAULT time::now() READONLY;

-- ##################################################################
-- COURSES
-- ##################################################################

DEFINE TABLE OVERWRITE course SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth.id
    FOR create WHERE owner = $auth.id;

DEFINE FIELD OVERWRITE owner ON TABLE course TYPE record<user> READONLY; -- @parent
DEFINE FIELD OVERWRITE title ON TABLE course TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD OVERWRITE description ON TABLE course TYPE option<string>;
-- Divider-tab color of the course in the sidebar (one of the UI's palette keys).
DEFINE FIELD OVERWRITE color ON TABLE course TYPE string DEFAULT 'blue';
-- Language the tutor speaks in calls of this course (ISO 639-1, e.g. "en",
-- "de"). Lecture material may be in any language.
DEFINE FIELD OVERWRITE language ON TABLE course TYPE string DEFAULT 'en'
  ASSERT string::len($value) = 2;
-- Extra instructions for the tutor in every call of this course ("the exam is
-- oral", "focus on proofs", ...).
DEFINE FIELD OVERWRITE tutor_notes ON TABLE course TYPE option<string>;
DEFINE FIELD OVERWRITE created_at ON TABLE course TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE course TYPE datetime VALUE time::now();

DEFINE INDEX OVERWRITE course_owner ON TABLE course FIELDS owner;

-- Deleting a course deletes everything in it. Events run without the caller's
-- permissions, so the server-only tables are reached too.
DEFINE EVENT OVERWRITE course_deleted ON TABLE course WHEN $event = "DELETE" THEN {
  DELETE material WHERE course = $before.id;
  DELETE call WHERE course = $before.id;
};

-- ##################################################################
-- MATERIALS
-- ##################################################################

DEFINE TABLE OVERWRITE material SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth.id
    -- The course must be the user's own too: the API searches a course's
    -- material for the tutor, and nobody may plant text in someone else's.
    FOR create WHERE owner = $auth.id AND course.owner = $auth.id;

DEFINE FIELD OVERWRITE owner ON TABLE material TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE course ON TABLE material TYPE record<course> READONLY; -- @parent
DEFINE FIELD OVERWRITE title ON TABLE material TYPE string ASSERT string::len($value) > 0;
-- Where the content came from: typed/pasted text, a markdown file, or a PDF
-- that the API converted to markdown + images.
DEFINE FIELD OVERWRITE kind ON TABLE material TYPE string
  ASSERT $value IN ['text', 'markdown', 'pdf']
  PERMISSIONS FOR update WHERE false;
-- The lecture itself, as markdown. Images extracted from a PDF are referenced
-- as `![caption](asset:<id>)`. Can be long, so the sync engine only carries
-- the record and the client fetches the body directly (@opaque).
-- @opaque
DEFINE FIELD OVERWRITE content ON TABLE material TYPE string DEFAULT '';
-- Lifecycle of the server-side processing (PDF conversion, chunking,
-- embedding). `ready` means the tutor can search it.
-- Fields from here to `index_rev` are written by the API only (clients may
-- set them when creating the row, never change them).
DEFINE FIELD OVERWRITE status ON TABLE material TYPE string DEFAULT 'pending'
  ASSERT $value IN ['pending', 'processing', 'ready', 'failed']
  PERMISSIONS FOR update WHERE false;
-- Human-readable progress line while processing ("Converting pages 11-20").
DEFINE FIELD OVERWRITE status_detail ON TABLE material TYPE option<string>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE error ON TABLE material TYPE option<string>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE source_name ON TABLE material TYPE option<string>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE source_size ON TABLE material TYPE option<int>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE page_count ON TABLE material TYPE option<int>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE chunk_count ON TABLE material TYPE int DEFAULT 0
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE image_count ON TABLE material TYPE int DEFAULT 0
  PERMISSIONS FOR update WHERE false;
-- Bumped by the API on every (re)index, so a stale run can tell it lost.
DEFINE FIELD OVERWRITE index_rev ON TABLE material TYPE int DEFAULT 0
  PERMISSIONS FOR update WHERE false;
-- Last section the student has reached, using the search index's zero-based
-- positions. Uploading material never marks it as reached or understood.
DEFINE FIELD OVERWRITE learned_through ON TABLE material TYPE int DEFAULT -1
  ASSERT $value >= -1
  PERMISSIONS FOR update WHERE false;
-- Revision of the material's AgentMemory graph, written by the API.
DEFINE FIELD OVERWRITE memory_rev ON TABLE material TYPE int DEFAULT 0
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE created_at ON TABLE material TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE material TYPE datetime VALUE time::now();

DEFINE INDEX OVERWRITE material_course ON TABLE material FIELDS course;

DEFINE EVENT OVERWRITE material_deleted ON TABLE material WHEN $event = "DELETE" THEN {
  DELETE chunk WHERE material = $before.id;
  DELETE asset WHERE material = $before.id;
  DELETE source_part WHERE material = $before.id;
};

-- ##################################################################
-- CALLS
-- ##################################################################

-- One voice session with the tutor. Created by the API when a call starts,
-- so the client only reads it.
DEFINE TABLE OVERWRITE call SCHEMAFULL
  PERMISSIONS
    FOR select, delete WHERE owner = $auth.id
    FOR create, update WHERE false;

DEFINE FIELD OVERWRITE owner ON TABLE call TYPE record<user>;
DEFINE FIELD OVERWRITE course ON TABLE call TYPE record<course>; -- @parent
-- The lecture the call is about. NONE = the whole course.
DEFINE FIELD OVERWRITE material ON TABLE call TYPE option<record<material>>;
-- explain: walk me through the lecture. quiz: ask me questions. qa: I ask.
DEFINE FIELD OVERWRITE mode ON TABLE call TYPE string
  ASSERT $value IN ['explain', 'quiz', 'qa'];
DEFINE FIELD OVERWRITE status ON TABLE call TYPE string DEFAULT 'starting'
  ASSERT $value IN ['starting', 'live', 'ended'];
DEFINE FIELD OVERWRITE started_at ON TABLE call TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE ended_at ON TABLE call TYPE option<datetime>;
-- Written after the call: what was covered and what to review.
DEFINE FIELD OVERWRITE recap ON TABLE call TYPE option<string>;
-- SHA-256 of the per-call key the voice agent presents to the API's LLM
-- endpoint. Never readable.
DEFINE FIELD OVERWRITE key_hash ON TABLE call TYPE string
  PERMISSIONS FOR select WHERE false;
DEFINE FIELD OVERWRITE conversation_id ON TABLE call TYPE option<string>;

DEFINE INDEX OVERWRITE call_course ON TABLE call FIELDS course;

DEFINE EVENT OVERWRITE call_deleted ON TABLE call WHEN $event = "DELETE" THEN {
  DELETE call_turn WHERE call = $before.id;
  DELETE turn_source WHERE call = $before.id;
};

-- The transcript, one row per spoken turn. Written by the API as the call
-- runs, so the client shows it live through sync.
DEFINE TABLE OVERWRITE call_turn SCHEMAFULL
  PERMISSIONS
    FOR select WHERE owner = $auth.id
    FOR create, update, delete WHERE false;

DEFINE FIELD OVERWRITE owner ON TABLE call_turn TYPE record<user>;
DEFINE FIELD OVERWRITE call ON TABLE call_turn TYPE record<call>; -- @parent
DEFINE FIELD OVERWRITE seq ON TABLE call_turn TYPE int;
DEFINE FIELD OVERWRITE role ON TABLE call_turn TYPE string ASSERT $value IN ['student', 'tutor'];
DEFINE FIELD OVERWRITE text ON TABLE call_turn TYPE string;
DEFINE FIELD OVERWRITE created_at ON TABLE call_turn TYPE datetime DEFAULT time::now();

DEFINE INDEX OVERWRITE call_turn_call ON TABLE call_turn FIELDS call, seq UNIQUE;

-- The lecture passages a tutor turn cited, one row per citation. Written by
-- the API with the turn, so the transcript shows them as links into the
-- material (a PDF opens at the page).
DEFINE TABLE OVERWRITE turn_source SCHEMAFULL
  PERMISSIONS
    FOR select WHERE owner = $auth.id
    FOR create, update, delete WHERE false;

DEFINE FIELD OVERWRITE owner ON TABLE turn_source TYPE record<user>;
DEFINE FIELD OVERWRITE call ON TABLE turn_source TYPE record<call>; -- @parent
-- The tutor turn (call_turn.seq) and the passage number the tutor cited.
DEFINE FIELD OVERWRITE seq ON TABLE turn_source TYPE int;
DEFINE FIELD OVERWRITE ref ON TABLE turn_source TYPE int;
DEFINE FIELD OVERWRITE material ON TABLE turn_source TYPE record<material>;
-- The material's title when cited, so the link reads well after a rename or
-- deletion.
DEFINE FIELD OVERWRITE title ON TABLE turn_source TYPE string;
DEFINE FIELD OVERWRITE page ON TABLE turn_source TYPE option<int>;
DEFINE FIELD OVERWRITE page_end ON TABLE turn_source TYPE option<int>;
DEFINE FIELD OVERWRITE heading ON TABLE turn_source TYPE option<string>;
-- Where in the turn's text the citation was made. A reply cut short by an
-- interruption keeps only the citations it got to.
DEFINE FIELD OVERWRITE at ON TABLE turn_source TYPE int;
DEFINE FIELD OVERWRITE created_at ON TABLE turn_source TYPE datetime DEFAULT time::now();

DEFINE INDEX OVERWRITE turn_source_call ON TABLE turn_source FIELDS call, seq;

-- ##################################################################
-- API KEYS (MCP access for AI clients)
-- ##################################################################

-- The browser generates the key, shows it once, and stores only its SHA-256.
DEFINE TABLE OVERWRITE api_key SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth.id
    FOR create WHERE owner = $auth.id;

DEFINE FIELD OVERWRITE owner ON TABLE api_key TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE name ON TABLE api_key TYPE string ASSERT string::len($value) > 0;
-- First characters of the key, so the user can tell keys apart.
DEFINE FIELD OVERWRITE prefix ON TABLE api_key TYPE string READONLY;
DEFINE FIELD OVERWRITE key_hash ON TABLE api_key TYPE string READONLY
  PERMISSIONS FOR select WHERE false;
DEFINE FIELD OVERWRITE created_at ON TABLE api_key TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE revoked_at ON TABLE api_key TYPE option<datetime>;

-- Its lookup index lives in apps/api/src/server-schema.surql: sp00ky refuses an
-- index on a field clients cannot read.
