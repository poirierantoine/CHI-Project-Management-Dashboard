/**
 * db/init.js — Database bootstrap
 *
 * Runs once at server startup. Creates the SQLite file, applies the schema,
 * and seeds with the original dashboard data if the database is empty.
 *
 * Returns the open `db` handle so server.js can import and reuse it.
 * better-sqlite3 is synchronous — no async/await needed.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure the data directory exists (created by Docker or first local run)
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'dashboard.db'));

// WAL (Write-Ahead Log) mode: readers don't block writers and vice versa.
// Essential when multiple people are loading the page while someone submits a check-in.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── SCHEMA ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    phase        TEXT    DEFAULT '',
    goal         TEXT    DEFAULT '',
    goal_approved INTEGER DEFAULT 0,
    week_status  TEXT    DEFAULT '',
    status       TEXT    DEFAULT 'green',
    celebrate    TEXT    DEFAULT '',
    decision     TEXT    DEFAULT '',
    week_h       INTEGER DEFAULT 0,
    mo_h         INTEGER DEFAULT 0,
    proposed     INTEGER DEFAULT 0,
    dormant      INTEGER DEFAULT 0,
    color        TEXT    DEFAULT '#888',
    tl_start     REAL    DEFAULT 0,
    tl_end       REAL    DEFAULT 1
  );

  -- Many-to-many: who is on which project and in what role
  CREATE TABLE IF NOT EXISTS project_team (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    person_name TEXT    NOT NULL,
    role        TEXT    NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  -- Each project's milestones and deadlines
  CREATE TABLE IF NOT EXISTS project_milestones (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    label      TEXT    NOT NULL,
    type       TEXT    DEFAULT 'm',  -- 'm' = milestone, 'd' = deadline
    date       TEXT    DEFAULT '',
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  -- Weekly status trail, one row per status change
  CREATE TABLE IF NOT EXISTS project_status_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    week_label  TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    note        TEXT    DEFAULT '',
    recorded_at TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS people (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    ini        TEXT    NOT NULL,
    role       TEXT    DEFAULT 'c',
    avail      TEXT    DEFAULT 'green',
    avail_txt  TEXT    DEFAULT '',
    total_h    INTEGER DEFAULT 37,
    avail_h    INTEGER DEFAULT 0,
    submitted  INTEGER DEFAULT 0,
    inactive   INTEGER DEFAULT 0,
    emoji             TEXT    DEFAULT '',
    po_note           TEXT    DEFAULT '',
    pm_note           TEXT    DEFAULT '',
    leadership        TEXT    DEFAULT '',
    last_checkin_week TEXT    DEFAULT ''
  );

  -- Each person's weekly schedule: 5 days x 3 slots (morning/early-aft/late-aft)
  CREATE TABLE IF NOT EXISTS people_schedule (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id  INTEGER NOT NULL,
    day        TEXT    NOT NULL,
    slot       INTEGER NOT NULL,    -- 0=morning 1=early-aft 2=late-aft
    available  INTEGER DEFAULT 1,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
  );

  -- Per-person, per-project allocation: hours this week and next, plus a note
  CREATE TABLE IF NOT EXISTS people_projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id   INTEGER NOT NULL,
    project_id  INTEGER NOT NULL,
    hours_this  INTEGER DEFAULT 0,
    hours_next  INTEGER DEFAULT 0,
    note        TEXT    DEFAULT '',
    updated_by  TEXT    DEFAULT '',
    updated_at  TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (person_id)  REFERENCES people(id)   ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  -- Submitted check-in forms; stored as a JSON blob (full form dump)
  CREATE TABLE IF NOT EXISTS checkins (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT    NOT NULL,   -- 'c' | 'pm' | 'po'
    person_name  TEXT    NOT NULL,
    week_label   TEXT    DEFAULT '',
    submitted_at TEXT    DEFAULT (datetime('now')),
    data         TEXT    NOT NULL    -- JSON blob
  );

  -- Monthly review snapshots; data stored as JSON to avoid over-normalising
  CREATE TABLE IF NOT EXISTS monthly_reviews (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    month    TEXT    NOT NULL UNIQUE,  -- 'YYYY-MM'
    saved    INTEGER DEFAULT 0,
    saved_on TEXT    DEFAULT NULL,
    data     TEXT    NOT NULL          -- JSON blob
  );

  -- People with manager privileges (can add/remove people, projects, managers)
  CREATE TABLE IF NOT EXISTS managers (
    name TEXT PRIMARY KEY
  );

  -- Audit trail of significant changes
  CREATE TABLE IF NOT EXISTS change_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT    DEFAULT (datetime('now')),
    editor  TEXT    NOT NULL DEFAULT '',
    action  TEXT    NOT NULL,
    subject TEXT    NOT NULL DEFAULT '',
    detail  TEXT    NOT NULL DEFAULT ''
  );
`);

// ─── MIGRATIONS (safe to run on every boot) ──────────────────────────────────
try { db.exec('ALTER TABLE people ADD COLUMN last_checkin_week TEXT DEFAULT ""'); } catch(e) { /* column already exists */ }
try { db.exec('CREATE TABLE IF NOT EXISTS managers (name TEXT PRIMARY KEY)'); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now')), editor TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '')`); } catch(e) {}

// ─── SEED (runs only once, when the DB is empty) ─────────────────────────────

const isEmpty = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c === 0;
if (isEmpty) seed();

// Ensure default managers are always present — must run AFTER seed() so people exist
['Jacob Sherson', 'Morten Røndal Olsen'].forEach(name => {
  if (db.prepare('SELECT 1 FROM people WHERE name = ?').get(name)) {
    db.prepare('INSERT OR IGNORE INTO managers (name) VALUES (?)').run(name);
  }
});

module.exports = db;

// ─── SEED DATA ───────────────────────────────────────────────────────────────

function seed() {
  const insertProject = db.prepare(`
    INSERT INTO projects (id,name,phase,goal,goal_approved,week_status,status,celebrate,decision,week_h,mo_h,proposed,dormant,color,tl_start,tl_end)
    VALUES (@id,@name,@phase,@goal,@goalApproved,@weekStatus,@status,@celebrate,@decision,@weekH,@moH,@proposed,@dormant,@color,@tlStart,@tlEnd)
  `);
  const insertTeam = db.prepare('INSERT INTO project_team (project_id,person_name,role) VALUES (?,?,?)');
  const insertMilestone = db.prepare('INSERT INTO project_milestones (project_id,label,type,date) VALUES (?,?,?,?)');
  const insertHistory = db.prepare('INSERT INTO project_status_history (project_id,week_label,status,note) VALUES (?,?,?,?)');

  const PROJECTS = [
    {
      id: 1, name: 'CABKA Project', phase: 'Planning', goal: 'Complete phase 1 technical setup', goalApproved: 1, weekStatus: 'Kick-off done. VM setup in progress.', status: 'green', celebrate: '', decision: '', weekH: 12, moH: 44, proposed: 0, dormant: 0, color: '#4a8c2a', tlStart: 0.1, tlEnd: 0.75,
      po: [{ n: 'Jacob Sherson' }], pm: [{ n: 'Frederik Kjeldsen' }], contrib: [{ n: 'Maceo G.', r: 'C' }],
      marks: [{ l: 'Phase 1 end', t: 'm', d: '2026-05-10' }, { l: 'Handover', t: 'd', d: '2026-06-15' }],
      hist: [{ wk: 'Wk 17', s: 'green', note: 'Kick-off done. VM setup in progress with Maceo.' }, { wk: 'Wk 16', s: 'green', note: 'Planning complete. Awaiting VM credentials.' }, { wk: 'Wk 15', s: 'green', note: 'Project kicked off. Team aligned on scope.' }, { wk: 'Wk 14', s: 'green', note: '' }]
    },
    {
      id: 2, name: 'HI Industry Partner Survey', phase: 'Analysis', goal: 'Talk to contact persons, go through reports', goalApproved: 1, weekStatus: 'Frederik meeting contact persons. Two reports reviewed.', status: 'green', celebrate: 'We got all 8 partners to respond — fastest turnaround yet!', decision: '', weekH: 6, moH: 22, proposed: 0, dormant: 0, color: '#1D9E75', tlStart: 0.05, tlEnd: 0.6,
      po: [{ n: 'Jacob Sherson' }], pm: [{ n: 'Frederik Kjeldsen' }], contrib: [{ n: 'Alexis V.', r: 'C' }, { n: 'Lærke T.', r: 'C' }],
      marks: [{ l: 'Report deadline', t: 'd', d: '2026-05-30' }],
      hist: [{ wk: 'Wk 17', s: 'green', note: 'Frederik meeting contact persons. Two reports reviewed.' }, { wk: 'Wk 16', s: 'amber', note: 'Waiting on two partners to respond to outreach.' }, { wk: 'Wk 15', s: 'green', note: 'Partner list finalised. Outreach sent.' }, { wk: 'Wk 14', s: 'green', note: '' }]
    },
    {
      id: 3, name: 'KogniKit KU', phase: 'Development', goal: 'Finish data analysis, decouple game instances', goalApproved: 1, weekStatus: 'Sára vibe-coding new games. Decoupling in progress.', status: 'green', celebrate: '', decision: '', weekH: 10, moH: 38, proposed: 0, dormant: 0, color: '#7F77DD', tlStart: 0, tlEnd: 0.65,
      po: [{ n: 'Jacob Sherson' }, { n: 'Janet Rafner' }], pm: [{ n: 'Blanka Szöllösi' }], contrib: [{ n: 'Abel N.', r: 'C' }, { n: 'Thomas H.', r: 'C' }],
      marks: [{ l: 'Pipeline done', t: 'm', d: '2026-04-30' }],
      hist: [{ wk: 'Wk 17', s: 'green', note: 'Sára vibe-coding new games. Decoupling in progress.' }, { wk: 'Wk 16', s: 'green', note: 'CFA pipeline submitted for review.' }, { wk: 'Wk 15', s: 'amber', note: 'Pipeline delayed — dependency on game instance config.' }, { wk: 'Wk 14', s: 'green', note: '' }]
    },
    {
      id: 4, name: 'Quantum readiness chatbot', phase: 'Development', goal: 'Ship internal dev build for review', goalApproved: 1, weekStatus: 'Alexander and Chloe aligning on architecture.', status: 'green', celebrate: '', decision: '', weekH: 8, moH: 30, proposed: 0, dormant: 0, color: '#378ADD', tlStart: 0.2, tlEnd: 0.7,
      po: [{ n: 'Jacob Sherson' }], pm: [{ n: 'Eleni Karydi' }], contrib: [{ n: 'Alexander V.', r: 'C' }, { n: 'Chloe L.', r: 'C' }],
      marks: [{ l: 'Internal review', t: 'm', d: '2026-05-15' }],
      hist: [{ wk: 'Wk 17', s: 'green', note: 'Alexander and Chloe aligning on architecture.' }, { wk: 'Wk 16', s: 'green', note: 'Dev build scope agreed. Work underway.' }, { wk: 'Wk 15', s: 'green', note: 'Chatbot structure defined.' }, { wk: 'Wk 14', s: 'amber', note: 'Scope unclear — needed Jacob input before starting.' }]
    },
    {
      id: 5, name: 'Quantum Strategies Chatbot', phase: 'Development', goal: 'Complete content integration', goalApproved: 1, weekStatus: '', status: 'green', celebrate: '', decision: '', weekH: 5, moH: 18, proposed: 0, dormant: 0, color: '#1D9E75', tlStart: 0.25, tlEnd: 0.72,
      po: [{ n: 'Jacob Sherson' }], pm: [{ n: 'Eleni Karydi' }], contrib: [{ n: 'Chloe L.', r: 'C' }],
      marks: [], hist: []
    },
    {
      id: 6, name: 'Quantum Student Chatbot', phase: '', goal: '', goalApproved: 0, weekStatus: '', status: 'green', celebrate: '', decision: '', weekH: 3, moH: 10, proposed: 0, dormant: 0, color: '#5DCAA5', tlStart: 0.3, tlEnd: 0.75,
      po: [], pm: [], contrib: [], marks: [], hist: []
    },
    {
      id: 7, name: 'Tech Circle Innovation', phase: 'Research', goal: 'Prepare interview guide, run first interviews', goalApproved: 1, weekStatus: 'Janet presenting at HHAI. TechCircle interview this week.', status: 'green', celebrate: '', decision: '', weekH: 7, moH: 24, proposed: 0, dormant: 0, color: '#b07010', tlStart: 0.1, tlEnd: 0.8,
      po: [{ n: 'Jacob Sherson' }, { n: 'Janet Rafner' }], pm: [{ n: 'Morten Røndal' }], contrib: [{ n: 'Frederik K.', r: 'C' }, { n: 'Lærke T.', r: 'C' }, { n: 'Casper T.', r: 'C' }, { n: 'Alexander V.', r: 'C' }],
      marks: [{ l: 'Report draft', t: 'm', d: '2026-06-01' }],
      hist: [{ wk: 'Wk 17', s: 'green', note: 'Janet presenting at HHAI. TechCircle interview this week.' }, { wk: 'Wk 16', s: 'green', note: 'Interview guide finalised. First interview scheduled.' }, { wk: 'Wk 15', s: 'green', note: 'Stakeholder list agreed.' }, { wk: 'Wk 14', s: 'green', note: '' }]
    },
    {
      id: 8, name: 'Operations Task Force', phase: 'Internal', goal: 'Employee handbook with SOPs before summer', goalApproved: 1, weekStatus: 'Handbook structure drafted. SOPs in progress.', status: 'green', celebrate: '', decision: 'Need Jacob to approve the new onboarding SOP before it goes to the team.', weekH: 4, moH: 14, proposed: 0, dormant: 0, color: '#909090', tlStart: 0, tlEnd: 0.55,
      po: [{ n: 'Morten Røndal' }], pm: [{ n: 'Morten Røndal' }], contrib: [{ n: 'Blanka S.', r: 'C' }, { n: 'Frederik K.', r: 'C' }, { n: 'Mille B.', r: 'C' }],
      marks: [{ l: 'Handbook done', t: 'd', d: '2026-06-30' }],
      hist: [{ wk: 'Wk 17', s: 'green', note: 'Handbook structure drafted. SOPs in progress.' }, { wk: 'Wk 16', s: 'green', note: 'First draft of structure complete.' }, { wk: 'Wk 15', s: 'green', note: 'Scope agreed with team.' }, { wk: 'Wk 14', s: 'green', note: '' }]
    },
    {
      id: 9, name: 'CHI Chatbot Standardization', phase: 'Scoping', goal: 'Present dev roadmap to Jacob for approval', goalApproved: 1, weekStatus: 'Dev roadmap being drafted.', status: 'amber', celebrate: '', decision: 'Need Jacob to block time to review the roadmap before end of April.', weekH: 2, moH: 6, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.28, tlEnd: 0.58,
      po: [{ n: 'Jacob Sherson' }, { n: 'Morten Røndal' }], pm: [{ n: 'Alexander Velev' }], contrib: [],
      marks: [{ l: 'Roadmap presented', t: 'd', d: '2026-04-30' }],
      hist: [{ wk: 'Wk 17', s: 'amber', note: 'Dev roadmap being drafted.' }, { wk: 'Wk 16', s: 'amber', note: 'Roadmap stalled — waiting on architecture decision.' }, { wk: 'Wk 15', s: 'amber', note: 'Scoping ongoing. More time needed.' }, { wk: 'Wk 14', s: 'green', note: 'Scoping started.' }]
    },
    {
      id: 10, name: 'CHI In-house RAG', phase: 'Dev — custom GPT', goal: '20 queries evaluated by CHI staff', goalApproved: 0, weekStatus: '20 queries to evaluate by CHI staff.', status: 'amber', celebrate: '', decision: '', weekH: 6, moH: 20, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.22, tlEnd: 0.62,
      po: [{ n: 'Morten Røndal' }], pm: [{ n: 'Casper Thylkjær' }], contrib: [{ n: 'Alexander V.', r: 'C' }],
      marks: [{ l: 'Eval complete', t: 'd', d: '2026-05-07' }],
      hist: [{ wk: 'Wk 17', s: 'amber', note: '20 queries to evaluate by CHI staff.' }, { wk: 'Wk 16', s: 'amber', note: 'Evaluation sheet ready. Need CHI staff time.' }, { wk: 'Wk 15', s: 'red', note: 'Blocked — no one available to evaluate.' }, { wk: 'Wk 14', s: 'amber', note: 'RAG deployed. Eval not started.' }]
    },
    {
      id: 11, name: 'CrowdThinking Festivals', phase: '', goal: '', goalApproved: 0, weekStatus: '', status: 'amber', celebrate: '', decision: '', weekH: 4, moH: 14, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.15, tlEnd: 0.85,
      po: [{ n: 'Janet Rafner' }], pm: [{ n: 'Morten Røndal' }], contrib: [{ n: 'Carina G.', r: 'C' }, { n: 'Lærke T.', r: 'C' }, { n: 'Blanka S.', r: 'I' }],
      marks: [], hist: []
    },
    {
      id: 12, name: 'DigiQ tech infrastructure', phase: '', goal: '', goalApproved: 0, weekStatus: '', status: 'amber', celebrate: '', decision: '', weekH: 3, moH: 10, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.3, tlEnd: 0.9,
      po: [{ n: 'Jacob Sherson' }], pm: [{ n: 'Eleni Karydi' }], contrib: [{ n: 'Thomas H.', r: 'C' }],
      marks: [], hist: []
    },
    {
      id: 13, name: 'ESG Project', phase: '', goal: '3 page abstract 17/4', goalApproved: 1, weekStatus: '3 page abstract submitted.', status: 'amber', celebrate: 'Abstract submitted on time!', decision: '', weekH: 2, moH: 7, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.25, tlEnd: 0.5,
      po: [{ n: 'Jacob Sherson' }, { n: 'Janet Rafner' }], pm: [{ n: 'Frederik Kjeldsen' }], contrib: [],
      marks: [{ l: 'Abstract', t: 'd', d: '2026-04-17' }],
      hist: [{ wk: 'Wk 17', s: 'amber', note: '3 page abstract submitted.' }, { wk: 'Wk 16', s: 'amber', note: 'Abstract draft in review.' }, { wk: 'Wk 15', s: 'amber', note: 'Writing underway. Tight deadline.' }, { wk: 'Wk 14', s: 'green', note: 'Abstract scoped.' }]
    },
    {
      id: 14, name: 'FERC bot', phase: '', goal: 'Two page abstract — conference in May', goalApproved: 1, weekStatus: 'Abstract mid April. Conference in May.', status: 'amber', celebrate: '', decision: '', weekH: 5, moH: 16, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.2, tlEnd: 0.65,
      po: [{ n: 'Jacob Sherson' }], pm: [{ n: 'Frederik Kjeldsen' }], contrib: [{ n: 'Mille B.', r: 'C' }],
      marks: [{ l: 'Abstract', t: 'd', d: '2026-04-20' }, { l: 'Conference', t: 'm', d: '2026-05-20' }],
      hist: [{ wk: 'Wk 17', s: 'amber', note: 'Abstract mid April. Conference in May.' }, { wk: 'Wk 16', s: 'amber', note: 'Abstract being written.' }, { wk: 'Wk 15', s: 'amber', note: 'Abstract not started yet — capacity issues.' }, { wk: 'Wk 14', s: 'amber', note: 'Bot development ongoing.' }]
    },
    {
      id: 15, name: 'GenAI Box w. Bagger Sørensen', phase: 'Developing', goal: 'Test at Flexwind in May', goalApproved: 1, weekStatus: 'Test at Flexwind May.', status: 'amber', celebrate: '', decision: '', weekH: 5, moH: 18, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.15, tlEnd: 0.65,
      po: [{ n: 'Jacob Sherson' }], pm: [{ n: 'Frederik Kjeldsen' }], contrib: [{ n: 'Alexis V.', r: 'C' }],
      marks: [{ l: 'Flexwind test', t: 'm', d: '2026-05-22' }], hist: []
    },
    {
      id: 16, name: 'HI Consultance Interface', phase: 'Scoping', goal: '', goalApproved: 0, weekStatus: '', status: 'amber', celebrate: '', decision: '', weekH: 1, moH: 3, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.35, tlEnd: 0.75,
      po: [], pm: [], contrib: [], marks: [], hist: []
    },
    {
      id: 17, name: 'HI Manifesto', phase: '', goal: '', goalApproved: 0, weekStatus: '', status: 'amber', celebrate: '', decision: '', weekH: 0, moH: 0, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0, tlEnd: 0.9,
      po: [{ n: 'Jacob Sherson' }], pm: [{ n: 'Morten Røndal' }], contrib: [{ n: 'Daniel L.', r: 'C' }, { n: 'Frederik K.', r: 'C' }],
      marks: [], hist: []
    },
    {
      id: 18, name: 'Internal GenAI Box', phase: 'Research + dev', goal: '', goalApproved: 0, weekStatus: '', status: 'amber', celebrate: '', decision: '', weekH: 2, moH: 8, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.2, tlEnd: 0.8,
      po: [], pm: [], contrib: [], marks: [], hist: []
    },
    {
      id: 19, name: 'KogniKit AU', phase: '', goal: 'End of month: have something to see and test', goalApproved: 0, weekStatus: 'End of month have something to see and test.', status: 'amber', celebrate: '', decision: '', weekH: 6, moH: 20, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.18, tlEnd: 0.7,
      po: [{ n: 'Jacob Sherson' }], pm: [{ n: 'Blanka Szöllösi' }], contrib: [{ n: 'Lærke T.', r: 'C' }, { n: 'Sára S.', r: 'C' }],
      marks: [{ l: 'Demo ready', t: 'd', d: '2026-04-30' }], hist: []
    },
    {
      id: 20, name: 'Quantum HR Workflow', phase: '', goal: '', goalApproved: 0, weekStatus: '', status: 'amber', celebrate: '', decision: '', weekH: 2, moH: 7, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.25, tlEnd: 0.7,
      po: [], pm: [], contrib: [], marks: [], hist: []
    },
    {
      id: 21, name: 'Quantum Jobs', phase: '', goal: '', goalApproved: 0, weekStatus: '', status: 'amber', celebrate: '', decision: '', weekH: 3, moH: 10, proposed: 0, dormant: 0, color: '#EF9F27', tlStart: 0.2, tlEnd: 0.85,
      po: [{ n: 'Eleni Karydi' }], pm: [], contrib: [], marks: [], hist: []
    },
    {
      id: 22, name: 'AU Connect grant', phase: 'Waiting on answer', goal: 'Get funding, make plan forward', goalApproved: 1, weekStatus: 'Application sent. Waiting.', status: 'red', celebrate: '', decision: '', weekH: 5, moH: 14, proposed: 0, dormant: 1, color: '#c0392b', tlStart: 0.1, tlEnd: 0.55,
      po: [], pm: [], contrib: [],
      marks: [{ l: 'Submission', t: 'd', d: '2026-04-14' }], hist: []
    },
    {
      id: 23, name: 'Innobooster', phase: '', goal: '', goalApproved: 0, weekStatus: 'Idle.', status: 'gray', celebrate: '', decision: '', weekH: 0, moH: 0, proposed: 0, dormant: 1, color: '#c0bfba', tlStart: 0, tlEnd: 0.5,
      po: [{ n: 'Janet Rafner' }], pm: [{ n: 'Morten Røndal' }], contrib: [], marks: [], hist: []
    },
    {
      id: 24, name: 'Innovation Management Project', phase: 'Finished?', goal: '', goalApproved: 0, weekStatus: '', status: 'gray', celebrate: '', decision: '', weekH: 0, moH: 0, proposed: 0, dormant: 1, color: '#c0bfba', tlStart: 0, tlEnd: 0.35,
      po: [{ n: 'Janet Rafner' }], pm: [], contrib: [{ n: 'Chloe L.', r: 'C' }], marks: [], hist: []
    },
    {
      id: 25, name: 'Metacognition Lab study', phase: 'Delivered', goal: 'Move to new architecture?', goalApproved: 0, weekStatus: 'Project as good as done. Demo video left.', status: 'gray', celebrate: '', decision: '', weekH: 0, moH: 0, proposed: 0, dormant: 1, color: '#c0bfba', tlStart: 0, tlEnd: 0.3,
      po: [{ n: 'Janet Rafner' }], pm: [{ n: 'Frederik Kjeldsen' }], contrib: [{ n: 'Mille B.', r: 'C' }], marks: [], hist: []
    },
    {
      id: 26, name: 'Quantum Dashboard', phase: '', goal: '', goalApproved: 0, weekStatus: '', status: 'gray', celebrate: '', decision: '', weekH: 0, moH: 0, proposed: 0, dormant: 1, color: '#c0bfba', tlStart: 0, tlEnd: 0.4,
      po: [], pm: [], contrib: [], marks: [], hist: []
    },
    {
      id: 27, name: 'Ringkøbing Skjern Collab', phase: '', goal: '', goalApproved: 0, weekStatus: '', status: 'gray', celebrate: '', decision: '', weekH: 0, moH: 0, proposed: 0, dormant: 1, color: '#c0bfba', tlStart: 0, tlEnd: 0.4,
      po: [], pm: [], contrib: [], marks: [], hist: []
    },
  ];

  const seedAll = db.transaction(() => {
    PROJECTS.forEach(p => {
      insertProject.run(p);
      p.po.forEach(t => insertTeam.run(p.id, t.n, 'PO'));
      p.pm.forEach(t => insertTeam.run(p.id, t.n, 'PM'));
      p.contrib.forEach(t => insertTeam.run(p.id, t.n, t.r || 'C'));
      p.marks.forEach(m => insertMilestone.run(p.id, m.l, m.t, m.d));
      p.hist.forEach(h => insertHistory.run(p.id, h.wk, h.s, h.note));
    });
  });
  seedAll();

  // ── PEOPLE ──────────────────────────────────────────────────────────────────

  const insertPerson = db.prepare(`INSERT INTO people (name,ini,role,avail,avail_txt,total_h,avail_h,submitted,inactive,emoji,po_note,pm_note,leadership) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertSched = db.prepare(`INSERT INTO people_schedule (person_id,day,slot,available) VALUES (?,?,?,?)`);
  const insertPP = db.prepare(`INSERT INTO people_projects (person_id,project_id,hours_this,hours_next,note) VALUES (?,?,?,?,?)`);

  // Map project names to IDs for linking allocations
  const projIdByName = {};
  PROJECTS.forEach(p => { projIdByName[p.name] = p.id; });

  const PEOPLE = [
    {
      name: 'Jacob Sherson', ini: 'JS', role: 'po', avail: 'amber', availTxt: 'Not open', totalH: 37, availH: 0, sub: 1, emoji: '😐',
      sched: { Mon: [1, 1, 0], Tue: [1, 1, 1], Wed: [1, 0, 0], Thu: [1, 1, 0], Fri: [1, 0, 0] },
      projs: [], poNote: 'Heads down on grant strategy this week. Available for urgent decisions via Basecamp ping.', pmNote: '', leadership: ''
    },
    {
      name: 'Janet Rafner', ini: 'JR', role: 'po', avail: 'red', availTxt: 'Overloaded (−3h)', totalH: 37, availH: 0, sub: 1, emoji: '🤯',
      sched: { Mon: [0, 0, 0], Tue: [1, 1, 0], Wed: [0, 0, 0], Thu: [1, 1, 1], Fri: [0, 0, 0] },
      projs: [], poNote: 'Deep in HHAI follow-ups. Lots of new connections to bring back. Supervising masters students this week — Basecamp ping is best if you need me.', pmNote: '', leadership: 'HHAI follow-ups need a home. Several contacts want to continue conversations — do we scope these as new projects or route them into existing ones?'
    },
    {
      name: 'Simon Goorney', ini: 'SG', role: 'po', avail: 'green', availTxt: 'Open (4h)', totalH: 37, availH: 4, sub: 0, emoji: '',
      sched: { Mon: [1, 1, 0], Tue: [1, 1, 0], Wed: [1, 1, 0], Thu: [0, 0, 0], Fri: [0, 0, 0] },
      projs: [], poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Frederik Brosbøl Kjeldsen', ini: 'FK', role: 'pm', avail: 'amber', availTxt: 'Not open', totalH: 37, availH: 0, sub: 1, emoji: '😐',
      sched: { Mon: [1, 1, 0], Tue: [1, 1, 1], Wed: [1, 1, 0], Thu: [1, 1, 0], Fri: [1, 0, 0] },
      projs: [{ proj: 'CABKA Project', h: 4, nxt: 4, note: 'Stakeholder updates' }, { proj: 'ESG Project', h: 3, nxt: 3, note: 'Abstract submitted!' }],
      poNote: '', pmNote: 'ESG abstract was submitted on time, great team effort.', leadership: 'A company called Byforma reached out about HI workshops. Might be worth scoping — could be a new client.'
    },
    {
      name: 'Morten Røndal Olsen', ini: 'MR', role: 'pm', avail: 'amber', availTxt: 'Not open', totalH: 18, availH: 0, sub: 1, emoji: '😐',
      sched: { Mon: [1, 1, 1], Tue: [1, 1, 0], Wed: [1, 1, 0], Thu: [1, 1, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'CHI In-house RAG', h: 3, nxt: 2, note: 'Strategic oversight' }, { proj: 'Operations Task Force', h: 4, nxt: 4, note: 'Handbook coordination' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Thomas Halgaard', ini: 'TH', role: 'pm', avail: 'green', availTxt: 'Open (4h)', totalH: 37, availH: 4, sub: 1, emoji: '😊',
      sched: { Mon: [1, 1, 0], Tue: [1, 1, 0], Wed: [1, 0, 0], Thu: [0, 0, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'KogniKit KU', h: 4, nxt: 4, note: 'Game UI work' }, { proj: 'DigiQ tech infrastructure', h: 3, nxt: 3, note: '' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Bianka Szöllösi', ini: 'BS', role: 'pm', avail: 'green', availTxt: 'Open — projects (6h)', totalH: 37, availH: 6, sub: 0, emoji: '',
      sched: { Mon: [1, 1, 0], Tue: [1, 0, 0], Wed: [0, 0, 0], Thu: [1, 1, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'KogniKit KU', h: 5, nxt: 5, note: '' }, { proj: 'Operations Task Force', h: 2, nxt: 2, note: '' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Eleni Karydi', ini: 'EK', role: 'pm', avail: 'amber', availTxt: 'Not open', totalH: 15, availH: 0, sub: 1, emoji: '😐',
      sched: { Mon: [1, 1, 0], Tue: [1, 0, 0], Wed: [1, 1, 0], Thu: [0, 0, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'Quantum readiness chatbot', h: 5, nxt: 5, note: 'Architecture review' }, { proj: 'DigiQ tech infrastructure', h: 3, nxt: 3, note: '' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Casper Thylkjær', ini: 'CT', role: 'pm', avail: 'amber', availTxt: 'Open — small tasks (4h)', totalH: 15, availH: 4, sub: 1, emoji: '😐',
      sched: { Mon: [0, 0, 0], Tue: [1, 1, 0], Wed: [1, 0, 0], Thu: [1, 1, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'CHI In-house RAG', h: 6, nxt: 4, note: 'New system prompt for RAG MVP, finished eval sheet' }],
      poNote: '', pmNote: 'Good momentum on the RAG this week.', leadership: 'Inbound request from Aarsleff about a potential collaboration. Not sure if this is a project or just a meeting.'
    },
    {
      name: 'Abel Nagy', ini: 'AN', role: 'c', avail: 'green', availTxt: 'Open (3h)', totalH: 15, availH: 3, sub: 1, emoji: '😊',
      sched: { Mon: [1, 1, 0], Tue: [1, 0, 0], Wed: [0, 0, 0], Thu: [1, 1, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'KogniKit KU', h: 4, nxt: 4, note: 'Data analysis tasks' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Alexander Velev', ini: 'AV', role: 'c', avail: 'amber', availTxt: 'Open (0h)', totalH: 15, availH: 0, sub: 1, emoji: '😊',
      sched: { Mon: [1, 1, 0], Tue: [0, 0, 0], Wed: [1, 1, 0], Thu: [1, 0, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'CHI Chatbot Standardization', h: 4, nxt: 3, note: 'Met Jacob, aligned next steps' }, { proj: 'Quantum readiness chatbot', h: 3, nxt: 4, note: 'Dev work' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Alexis Vrielynck', ini: 'AV', role: 'c', avail: 'amber', availTxt: 'Open (0h)', totalH: 37, availH: 0, sub: 1, emoji: '⚡',
      sched: { Mon: [1, 1, 0], Tue: [1, 1, 1], Wed: [1, 0, 0], Thu: [1, 1, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'Quantum Jobs', h: 5, nxt: 6, note: 'Quantum Jobs content, AI box work' }, { proj: 'GenAI Box w. Bagger Sørensen', h: 3, nxt: 3, note: 'Langfuse integration' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Antoine Poirier', ini: 'AP', role: 'c', avail: 'green', availTxt: 'Open (5h)', totalH: 37, availH: 5, sub: 0, emoji: '',
      sched: { Mon: [1, 1, 0], Tue: [1, 1, 0], Wed: [1, 1, 0], Thu: [1, 0, 0], Fri: [0, 0, 0] },
      projs: [], poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Carina Gibat', ini: 'CG', role: 'c', avail: 'amber', availTxt: 'Open (2h)', totalH: 15, availH: 2, sub: 1, emoji: '😊',
      sched: { Mon: [0, 0, 0], Tue: [1, 1, 0], Wed: [1, 0, 0], Thu: [0, 0, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'CrowdThinking Festivals', h: 3, nxt: 3, note: 'Event planning' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Chloe Lucas', ini: 'CL', role: 'c', avail: 'amber', availTxt: 'Not open', totalH: 37, availH: 0, sub: 1, emoji: '😐',
      sched: { Mon: [1, 1, 0], Tue: [1, 1, 1], Wed: [1, 1, 0], Thu: [1, 0, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'Quantum readiness chatbot', h: 5, nxt: 5, note: 'Chatbot dev' }, { proj: 'Quantum Strategies Chatbot', h: 3, nxt: 3, note: 'Content integration' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Daniel Le', ini: 'DL', role: 'c', avail: 'green', availTxt: 'Open (4h)', totalH: 15, availH: 4, sub: 1, emoji: '😊',
      sched: { Mon: [1, 0, 0], Tue: [1, 1, 0], Wed: [0, 0, 0], Thu: [1, 1, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'HI Manifesto', h: 3, nxt: 3, note: 'Content writing' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Lærke Thansen', ini: 'LT', role: 'c', avail: 'amber', availTxt: 'Open (2h)', totalH: 15, availH: 2, sub: 0, emoji: '',
      sched: { Mon: [1, 0, 0], Tue: [0, 0, 0], Wed: [1, 1, 0], Thu: [1, 0, 0], Fri: [0, 0, 0] },
      projs: [{ proj: 'KogniKit AU', h: 4, nxt: 4, note: '' }, { proj: 'CrowdThinking Festivals', h: 3, nxt: 3, note: '' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Mille Berg', ini: 'MB', role: 'c', avail: 'green', availTxt: 'Open (3h)', totalH: 15, availH: 3, sub: 0, emoji: '',
      sched: { Mon: [0, 0, 0], Tue: [1, 1, 0], Wed: [0, 0, 0], Thu: [1, 0, 0], Fri: [1, 1, 0] },
      projs: [{ proj: 'FERC bot', h: 4, nxt: 4, note: '' }, { proj: 'Operations Task Force', h: 2, nxt: 2, note: '' }],
      poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Rigmor Lyck Hansen', ini: 'RL', role: 'c', avail: 'green', availTxt: 'Open (4h)', totalH: 15, availH: 4, sub: 0, emoji: '',
      sched: { Mon: [1, 1, 0], Tue: [0, 0, 0], Wed: [1, 0, 0], Thu: [1, 1, 0], Fri: [0, 0, 0] },
      projs: [], poNote: '', pmNote: '', leadership: ''
    },
    {
      name: 'Sára Szabó', ini: 'SS', role: 'c', avail: 'amber', availTxt: 'Open (0h)', totalH: 15, availH: 0, sub: 1, emoji: '😊',
      sched: { Mon: [0, 0, 0], Tue: [1, 1, 0], Wed: [1, 1, 0], Thu: [0, 0, 0], Fri: [1, 0, 0] },
      projs: [{ proj: 'KogniKit KU', h: 5, nxt: 6, note: 'Onboarded Lærke, vibe-coding new games' }, { proj: 'KogniKit AU', h: 3, nxt: 3, note: 'Meeting coordination' }],
      poNote: '', pmNote: '', leadership: ''
    },
  ];

  const seedPeople = db.transaction(() => {
    PEOPLE.forEach(p => {
      const res = insertPerson.run(p.name, p.ini, p.role, p.avail, p.availTxt, p.totalH, p.availH, p.sub, 0, p.emoji, p.poNote, p.pmNote, p.leadership);
      const pid = res.lastInsertRowid;
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].forEach(d => {
        const slots = p.sched[d] || [0, 0, 0];
        slots.forEach((avail, slot) => insertSched.run(pid, d, slot, avail));
      });
      p.projs.forEach(proj => {
        const projId = projIdByName[proj.proj];
        if (projId) insertPP.run(pid, projId, proj.h, proj.nxt, proj.note);
      });
    });
  });
  seedPeople();

  // ── MONTHLY REVIEWS ──────────────────────────────────────────────────────────

  const insertReview = db.prepare('INSERT INTO monthly_reviews (month,saved,saved_on,data) VALUES (?,?,?,?)');

  const reviews = {
    '2026-03': {
      label: 'March 2026',
      projects: [
        { name: 'KogniKit KU', status: 'green', goal: 'Complete CFA pipeline and submit for review', outcome: 'hit', statusTrail: ['green', 'green', 'amber', 'green'], hoursLogged: 38, hoursProjected: 40, celebrate: 'Pipeline submitted ahead of schedule', decision: '' },
        { name: 'Tech Circle Innovation', status: 'green', goal: 'Conduct 3 stakeholder interviews', outcome: 'partial', statusTrail: ['amber', 'green', 'green', 'green'], hoursLogged: 22, hoursProjected: 28, celebrate: '', decision: '' },
        { name: 'CHI In-house RAG', status: 'amber', goal: 'Deploy internal RAG with 10 test queries', outcome: 'missed', statusTrail: ['amber', 'amber', 'red', 'amber'], hoursLogged: 18, hoursProjected: 24, celebrate: '', decision: 'Needed more dev time than scoped — revisit estimate' },
        { name: 'Operations Task Force', status: 'green', goal: 'First draft of handbook structure', outcome: 'hit', statusTrail: ['green', 'green', 'green', 'green'], hoursLogged: 14, hoursProjected: 16, celebrate: 'Morten delivered full structure two days early', decision: '' },
        { name: 'ESG Project', status: 'amber', goal: 'Submit 3 page abstract', outcome: 'hit', statusTrail: ['amber', 'amber', 'amber', 'green'], hoursLogged: 9, hoursProjected: 8, celebrate: 'Abstract submitted on time!', decision: '' },
        { name: 'FERC bot', status: 'amber', goal: 'Complete two page abstract draft', outcome: 'partial', statusTrail: ['green', 'amber', 'amber', 'amber'], hoursLogged: 12, hoursProjected: 16, celebrate: '', decision: '' },
      ],
      people: [
        { name: 'Frederik Brosbøl Kjeldsen', totalH: 37, moH: 148, logged: 134, flag: 'ok' },
        { name: 'Morten Røndal Olsen', totalH: 18, moH: 72, logged: 68, flag: 'ok' },
        { name: 'Thomas Halgaard', totalH: 37, moH: 148, logged: 140, flag: 'ok' },
        { name: 'Bianka Szöllösi', totalH: 37, moH: 148, logged: 88, flag: 'under' },
        { name: 'Casper Thylkjær', totalH: 15, moH: 60, logged: 58, flag: 'ok' },
        { name: 'Alexander Velev', totalH: 15, moH: 60, logged: 62, flag: 'over' },
        { name: 'Sára Szabó', totalH: 15, moH: 60, logged: 55, flag: 'ok' },
        { name: 'Lærke Thansen', totalH: 15, moH: 60, logged: 44, flag: 'under' },
        { name: 'Mille Berg', totalH: 15, moH: 60, logged: 57, flag: 'ok' },
      ],
    },
    '2026-04': {
      label: 'April 2026',
      projects: [
        { name: 'CABKA Project', status: 'green', goal: 'Complete phase 1 technical setup', outcome: 'pending', statusTrail: ['green', 'green', 'green', null], hoursLogged: 44, hoursProjected: 48, celebrate: '', decision: '', upcomingDeadlines: [{ l: 'Handover', d: '2026-06-15', weeks: 8 }] },
        { name: 'KogniKit KU', status: 'green', goal: 'Finish data analysis, decouple game instances', outcome: 'pending', statusTrail: ['green', 'green', 'green', null], hoursLogged: 38, hoursProjected: 40, celebrate: '', decision: '', upcomingDeadlines: [{ l: 'Pipeline done', d: '2026-04-30', weeks: 1 }] },
        { name: 'CHI In-house RAG', status: 'amber', goal: '20 queries evaluated by CHI staff', outcome: 'pending', statusTrail: ['amber', 'amber', 'amber', null], hoursLogged: 20, hoursProjected: 28, celebrate: '', decision: '', upcomingDeadlines: [{ l: 'Eval complete', d: '2026-05-07', weeks: 2 }] },
        { name: 'CHI Chatbot Standardization', status: 'amber', goal: 'Present dev roadmap to Jacob for approval', outcome: 'pending', statusTrail: ['green', 'amber', 'amber', null], hoursLogged: 6, hoursProjected: 12, celebrate: '', decision: 'Need Jacob to block time to review roadmap', upcomingDeadlines: [{ l: 'Roadmap presented', d: '2026-04-30', weeks: 1 }] },
        { name: 'ESG Project', status: 'amber', goal: '3 page abstract 17/4', outcome: 'hit', statusTrail: ['amber', 'amber', 'green', null], hoursLogged: 7, hoursProjected: 8, celebrate: 'Abstract submitted on time!', decision: '', upcomingDeadlines: [] },
        { name: 'FERC bot', status: 'amber', goal: 'Two page abstract — conference in May', outcome: 'pending', statusTrail: ['amber', 'amber', 'amber', null], hoursLogged: 16, hoursProjected: 20, celebrate: '', decision: '', upcomingDeadlines: [{ l: 'Abstract', d: '2026-04-20', weeks: 0 }, { l: 'Conference', d: '2026-05-20', weeks: 4 }] },
        { name: 'Tech Circle Innovation', status: 'green', goal: 'Prepare interview guide, run first interviews', outcome: 'pending', statusTrail: ['green', 'green', 'green', null], hoursLogged: 24, hoursProjected: 28, celebrate: '', decision: '', upcomingDeadlines: [{ l: 'Report draft', d: '2026-06-01', weeks: 6 }] },
        { name: 'Operations Task Force', status: 'green', goal: 'Employee handbook with SOPs before summer', outcome: 'pending', statusTrail: ['green', 'green', 'green', null], hoursLogged: 14, hoursProjected: 16, celebrate: '', decision: 'Need Jacob to approve onboarding SOP', upcomingDeadlines: [{ l: 'Handbook done', d: '2026-06-30', weeks: 10 }] },
      ],
      people: [
        { name: 'Frederik Brosbøl Kjeldsen', totalH: 37, moH: 148, logged: 68, projected: 148, flag: 'ok' },
        { name: 'Morten Røndal Olsen', totalH: 18, moH: 72, logged: 28, projected: 72, flag: 'ok' },
        { name: 'Thomas Halgaard', totalH: 37, moH: 148, logged: 56, projected: 140, flag: 'ok' },
        { name: 'Bianka Szöllösi', totalH: 37, moH: 148, logged: 40, projected: 56, flag: 'under' },
        { name: 'Casper Thylkjær', totalH: 15, moH: 60, logged: 28, projected: 56, flag: 'ok' },
        { name: 'Eleni Karydi', totalH: 15, moH: 60, logged: 22, projected: 60, flag: 'ok' },
        { name: 'Alexander Velev', totalH: 15, moH: 60, logged: 28, projected: 56, flag: 'ok' },
        { name: 'Alexis Vrielynck', totalH: 37, moH: 148, logged: 36, projected: 148, flag: 'ok' },
        { name: 'Sára Szabó', totalH: 15, moH: 60, logged: 24, projected: 60, flag: 'ok' },
        { name: 'Lærke Thansen', totalH: 15, moH: 60, logged: 20, projected: 44, flag: 'under' },
        { name: 'Mille Berg', totalH: 15, moH: 60, logged: 18, projected: 44, flag: 'ok' },
        { name: 'Chloe Lucas', totalH: 37, moH: 148, logged: 44, projected: 148, flag: 'ok' },
      ],
    },
  };

  const seedReviews = db.transaction(() => {
    insertReview.run('2026-03', 1, '1 Apr 2026', JSON.stringify(reviews['2026-03']));
    insertReview.run('2026-04', 0, null, JSON.stringify(reviews['2026-04']));
  });
  seedReviews();

  console.log('Database seeded with initial data.');
}
