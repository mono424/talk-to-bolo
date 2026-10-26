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
--
-- `IF NOT EXISTS`, not OVERWRITE: `spky deploy` applies this whole schema on
-- every deploy, and redefining a record access without `WITH JWT` mints a new
-- signing key, which signs every user out. To change an access on purpose,
-- redefine it with OVERWRITE in a migration (that signs everyone out once).
-- ##################################################################

-- Email + password accounts for the web app.
DEFINE ACCESS IF NOT EXISTS account ON DATABASE TYPE RECORD
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
DEFINE ACCESS IF NOT EXISTS agent ON DATABASE TYPE RECORD
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
  DELETE fetcher WHERE course = $before.id;
  DELETE homework WHERE course = $before.id;
  DELETE document WHERE course = $before.id;
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
-- Where the content came from: typed/pasted text, a markdown file, a PDF
-- that the API converted to markdown + images, or LaTeX source (`tex`, kept
-- as written and indexed through its Markdown, shared/latex.ts).
DEFINE FIELD OVERWRITE kind ON TABLE material TYPE string
  ASSERT $value IN ['text', 'markdown', 'pdf', 'tex']
  PERMISSIONS FOR update WHERE false;
-- The lecture itself, as markdown (LaTeX for `tex`). Images extracted from a PDF are referenced
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
-- The source that imported it (see SOURCES below) and where a person opens
-- the original. NONE for material the student added. A source updates its
-- material when the original changes.
DEFINE FIELD OVERWRITE fetcher ON TABLE material TYPE option<record<fetcher>>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE source_url ON TABLE material TYPE option<string>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE created_at ON TABLE material TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE material TYPE datetime VALUE time::now();

DEFINE INDEX OVERWRITE material_course ON TABLE material FIELDS course;

DEFINE EVENT OVERWRITE material_deleted ON TABLE material WHEN $event = "DELETE" THEN {
  UPDATE homework SET sheet = NONE WHERE sheet = $before.id;
  UPDATE paper SET material = NONE WHERE material = $before.id;
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
-- The assistant a study session took place in ("ChatGPT"), when the student
-- studied there and it logged the session through the MCP server. Such a
-- session has a recap and no transcript. NONE for a voice call with Bolo.
DEFINE FIELD OVERWRITE assistant ON TABLE call TYPE option<string>;
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
-- HOMEWORK
--
-- The student's answers to an exercise sheet (a material), written in the
-- app: one `homework` per sheet and one `answer` per part of it, in sheet
-- order. The app splits the sheet into parts (shared/homework.ts) and creates
-- both itself; an answer row per part keeps edits on two devices apart.
-- ##################################################################

DEFINE TABLE OVERWRITE homework SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth.id
    FOR create WHERE owner = $auth.id AND course.owner = $auth.id;

DEFINE FIELD OVERWRITE owner ON TABLE homework TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE course ON TABLE homework TYPE record<course> READONLY; -- @parent
-- The exercise sheet. NONE once the sheet is deleted: the answers stay.
DEFINE FIELD OVERWRITE sheet ON TABLE homework TYPE option<record<material>>;
DEFINE FIELD OVERWRITE title ON TABLE homework TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD OVERWRITE created_at ON TABLE homework TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE homework TYPE datetime VALUE time::now();

DEFINE INDEX OVERWRITE homework_course ON TABLE homework FIELDS course;

DEFINE EVENT OVERWRITE homework_deleted ON TABLE homework WHEN $event = "DELETE" THEN {
  DELETE answer WHERE homework = $before.id;
};

-- One part of the sheet and the student's answer to it.
DEFINE TABLE OVERWRITE answer SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth.id
    FOR create WHERE owner = $auth.id AND homework.owner = $auth.id;

DEFINE FIELD OVERWRITE owner ON TABLE answer TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE homework ON TABLE answer TYPE record<homework> READONLY; -- @parent
-- Order on the sheet, and the part's stable key there ("1.b.ii").
DEFINE FIELD OVERWRITE position ON TABLE answer TYPE int;
DEFINE FIELD OVERWRITE key ON TABLE answer TYPE string;
DEFINE FIELD OVERWRITE question ON TABLE answer TYPE string;
DEFINE FIELD OVERWRITE question_title ON TABLE answer TYPE option<string>;
-- The margin label within the question: "b (ii)", "(c)", "" for a whole question.
DEFINE FIELD OVERWRITE label ON TABLE answer TYPE string;
DEFINE FIELD OVERWRITE points ON TABLE answer TYPE option<float>;
-- The exercise: its own text, and the introduction above it.
DEFINE FIELD OVERWRITE prompt ON TABLE answer TYPE string DEFAULT '';
DEFINE FIELD OVERWRITE context ON TABLE answer TYPE option<string>;
-- Where the exercise is on a PDF sheet: the page, the label its excerpt
-- starts at, and once found, the excerpt itself as JSON
-- ([{ page, top, bottom }], fractions of the page height).
DEFINE FIELD OVERWRITE page ON TABLE answer TYPE option<int>;
DEFINE FIELD OVERWRITE anchor ON TABLE answer TYPE option<string>;
DEFINE FIELD OVERWRITE anchor_page ON TABLE answer TYPE option<int>;
DEFINE FIELD OVERWRITE region ON TABLE answer TYPE option<string>;
-- The answer, as Markdown with $math$. Pasted images are `answer-image:<id>`.
DEFINE FIELD OVERWRITE content ON TABLE answer TYPE string DEFAULT '';
DEFINE FIELD OVERWRITE created_at ON TABLE answer TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE answer TYPE datetime VALUE time::now();

DEFINE INDEX OVERWRITE answer_homework ON TABLE answer FIELDS homework, position;

-- ##################################################################
-- DOCUMENTS
--
-- Free writing in a course, a research proposal or an essay: one Markdown
-- text in the app's editor, with the papers it draws on beside it. A
-- `paper` is an entry of a document's bibliography: a course material (its
-- PDF opens next to the text) or a reference typed in by hand. The text
-- cites one as `[@<paper key>]` or `[@<paper key>, p. 4]`, several as
-- `[@a; @b]`; Export PDF formats them and lists the cited papers.
-- ##################################################################

DEFINE TABLE OVERWRITE document SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth.id
    FOR create WHERE owner = $auth.id AND course.owner = $auth.id;

DEFINE FIELD OVERWRITE owner ON TABLE document TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE course ON TABLE document TYPE record<course> READONLY; -- @parent
DEFINE FIELD OVERWRITE title ON TABLE document TYPE string ASSERT string::len($value) > 0;
-- The text, as Markdown with $math$ and citations. Pasted images are `answer-image:<id>`.
DEFINE FIELD OVERWRITE content ON TABLE document TYPE string DEFAULT '';
-- How citations print: (Author, 2024) or [1].
DEFINE FIELD OVERWRITE cite_style ON TABLE document TYPE string DEFAULT 'author-year'
  ASSERT $value IN ['author-year', 'numeric'];
DEFINE FIELD OVERWRITE created_at ON TABLE document TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE document TYPE datetime VALUE time::now();

DEFINE INDEX OVERWRITE document_course ON TABLE document FIELDS course;

DEFINE EVENT OVERWRITE document_deleted ON TABLE document WHEN $event = "DELETE" THEN {
  DELETE paper WHERE document = $before.id;
};

-- A paper a document draws on, in the order it was added.
DEFINE TABLE OVERWRITE paper SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth.id
    FOR create WHERE owner = $auth.id AND document.owner = $auth.id;

DEFINE FIELD OVERWRITE owner ON TABLE paper TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE document ON TABLE paper TYPE record<document> READONLY; -- @parent
-- The course material holding the paper. NONE for a reference typed in, or once the material is deleted.
DEFINE FIELD OVERWRITE material ON TABLE paper TYPE option<record<material>>;
DEFINE FIELD OVERWRITE title ON TABLE paper TYPE string ASSERT string::len($value) > 0;
-- As the bibliography writes them: "Vaswani, A.; Shazeer, N.", "2017", "NeurIPS".
DEFINE FIELD OVERWRITE authors ON TABLE paper TYPE option<string>;
DEFINE FIELD OVERWRITE year ON TABLE paper TYPE option<string>;
DEFINE FIELD OVERWRITE venue ON TABLE paper TYPE option<string>;
DEFINE FIELD OVERWRITE url ON TABLE paper TYPE option<string>;
DEFINE FIELD OVERWRITE created_at ON TABLE paper TYPE datetime DEFAULT time::now() READONLY;

DEFINE INDEX OVERWRITE paper_document ON TABLE paper FIELDS document;

-- ##################################################################
-- SOURCES
--
-- A source (`fetcher`) brings a course's material in by itself: the files
-- and pages of a bCourses (Canvas) course, or the PDFs linked from a course
-- website. The API checks it on a schedule and imports what is new or
-- changed (apps/api/src/fetch). Its Canvas token and what it imported are
-- server-only (apps/api/src/server-schema.surql).
-- ##################################################################

DEFINE TABLE OVERWRITE fetcher SCHEMAFULL
  PERMISSIONS
    FOR select, update, delete WHERE owner = $auth.id
    FOR create WHERE owner = $auth.id AND course.owner = $auth.id;

DEFINE FIELD OVERWRITE owner ON TABLE fetcher TYPE record<user> READONLY;
DEFINE FIELD OVERWRITE course ON TABLE fetcher TYPE record<course> READONLY; -- @parent
-- canvas: a bCourses (or other Canvas) course. web: one public web page.
DEFINE FIELD OVERWRITE kind ON TABLE fetcher TYPE string
  ASSERT $value IN ['canvas', 'web']
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE name ON TABLE fetcher TYPE string ASSERT string::len($value) > 0;
-- web: the page. canvas: the Canvas origin, e.g. https://bcourses.berkeley.edu.
DEFINE FIELD OVERWRITE url ON TABLE fetcher TYPE string
  PERMISSIONS FOR update WHERE false;
-- The Canvas course id. NONE for web.
DEFINE FIELD OVERWRITE canvas_course ON TABLE fetcher TYPE option<string>
  PERMISSIONS FOR update WHERE false;
-- Comma-separated words: only items whose name or URL contains one are
-- imported. NONE: every PDF.
DEFINE FIELD OVERWRITE include ON TABLE fetcher TYPE option<string>;
-- Also import pages (Canvas pages, the web page's own text) as Markdown.
DEFINE FIELD OVERWRITE import_pages ON TABLE fetcher TYPE bool DEFAULT false;
-- Also import LaTeX sources (.tex) as `tex` material. Optional: sources from
-- before it existed have none (false), and a plain bool would make every
-- UPDATE of such a row fail to coerce NONE.
DEFINE FIELD OVERWRITE import_tex ON TABLE fetcher TYPE option<bool> DEFAULT false;
DEFINE FIELD OVERWRITE enabled ON TABLE fetcher TYPE bool DEFAULT true;
-- Hours between scheduled checks.
DEFINE FIELD OVERWRITE every_hours ON TABLE fetcher TYPE int DEFAULT 6
  ASSERT $value >= 1 AND $value <= 168;
-- A custom hockeymask mapping (JSON) instead of the template built from the
-- fields above. Set through the API, which compiles it first.
DEFINE FIELD OVERWRITE mapping ON TABLE fetcher TYPE option<string>
  PERMISSIONS FOR update WHERE false;
-- Fields from here on are written by the API only.
-- idle: never ran. running. ok. partial: some items failed. failed.
DEFINE FIELD OVERWRITE status ON TABLE fetcher TYPE string DEFAULT 'idle'
  ASSERT $value IN ['idle', 'running', 'ok', 'partial', 'failed']
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE last_error ON TABLE fetcher TYPE option<string>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE has_token ON TABLE fetcher TYPE bool DEFAULT false
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE imported_count ON TABLE fetcher TYPE int DEFAULT 0
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE run_started_at ON TABLE fetcher TYPE option<datetime>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE last_run_at ON TABLE fetcher TYPE option<datetime>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE next_run_at ON TABLE fetcher TYPE option<datetime>
  PERMISSIONS FOR update WHERE false;
DEFINE FIELD OVERWRITE created_at ON TABLE fetcher TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE fetcher TYPE datetime VALUE time::now();

DEFINE INDEX OVERWRITE fetcher_course ON TABLE fetcher FIELDS course;

-- Material a source imported stays: it is the student's now.
DEFINE EVENT OVERWRITE fetcher_deleted ON TABLE fetcher WHEN $event = "DELETE" THEN {
  DELETE fetch_run WHERE fetcher = $before.id;
  UPDATE material SET fetcher = NONE WHERE fetcher = $before.id;
};

-- One check of a source, for its history. Written by the API.
DEFINE TABLE OVERWRITE fetch_run SCHEMAFULL
  PERMISSIONS
    FOR select, delete WHERE owner = $auth.id
    FOR create, update WHERE false;

DEFINE FIELD OVERWRITE owner ON TABLE fetch_run TYPE record<user>;
DEFINE FIELD OVERWRITE fetcher ON TABLE fetch_run TYPE record<fetcher>; -- @parent
DEFINE FIELD OVERWRITE status ON TABLE fetch_run TYPE string DEFAULT 'running'
  ASSERT $value IN ['running', 'ok', 'partial', 'failed'];
-- Items the mapping kept, and what became of them.
DEFINE FIELD OVERWRITE found ON TABLE fetch_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE created ON TABLE fetch_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE updated ON TABLE fetch_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE failed ON TABLE fetch_run TYPE int DEFAULT 0;
-- Left for the next run (a run imports a bounded number of items).
DEFINE FIELD OVERWRITE deferred ON TABLE fetch_run TYPE int DEFAULT 0;
-- What went wrong, one line per problem.
DEFINE FIELD OVERWRITE detail ON TABLE fetch_run TYPE option<string>;
DEFINE FIELD OVERWRITE started_at ON TABLE fetch_run TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE finished_at ON TABLE fetch_run TYPE option<datetime>;

DEFINE INDEX OVERWRITE fetch_run_fetcher ON TABLE fetch_run FIELDS fetcher, started_at;

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
