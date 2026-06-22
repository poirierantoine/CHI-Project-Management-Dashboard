/**
 * server.js — CHI Dashboard API + static file server
 *
 * Architecture:
 *  - Express serves public/index.html for every non-API route
 *  - /api/* routes read/write the SQLite database
 *  - All DB operations use better-sqlite3 (synchronous) — no async/await needed
 *  - The DB handle is imported from db/init.js which runs schema + seed on first boot
 */
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const basicAuth = require('express-basic-auth');
const db        = require('./db/init');

const SNAPSHOT_DIR = path.join(__dirname, 'data', 'snapshots');
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

const app = express();

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'chi';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS;
if (!DASHBOARD_PASS) {
  console.warn('WARNING: DASHBOARD_PASS not set — authentication is disabled. Set it to enable.');
}

if (DASHBOARD_PASS) {
  app.use(basicAuth({
    users: { [DASHBOARD_USER]: DASHBOARD_PASS },
    challenge: true,
    realm: 'CHI Dashboard',
  }));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function isManager(name) {
  if (!name) return false;
  return !!db.prepare('SELECT 1 FROM managers WHERE name = ?').get(name);
}

function logChange(editor, action, subject, detail) {
  try {
    db.prepare('INSERT INTO change_log (editor, action, subject, detail) VALUES (?,?,?,?)')
      .run(editor || '', action, subject || '', detail || '');
  } catch(e) { /* non-fatal */ }
}

// Compute ISO week number for status history labels
function weekLabel() {
  const now   = new Date();
  const jan1  = new Date(now.getFullYear(), 0, 1);
  const wk    = Math.ceil(((now - jan1) / 864e5 + jan1.getDay() + 1) / 7);
  return `Wk ${wk}`;
}

// Build a full project object (matching the shape the frontend expects)
function loadProject(id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) return null;
  const team  = db.prepare('SELECT person_name AS n, role AS r FROM project_team WHERE project_id = ?').all(id);
  p.po        = team.filter(t => t.r === 'PO');
  p.pm        = team.filter(t => t.r === 'PM');
  p.contrib   = team.filter(t => t.r !== 'PO' && t.r !== 'PM');
  p.marks     = db.prepare('SELECT id, label AS l, type AS t, date AS d FROM project_milestones WHERE project_id = ?').all(id);
  p.tl        = [p.tl_start, p.tl_end];
  p.goalApproved  = !!p.goal_approved;
  p.weekStatus    = p.week_status;
  p.weekH         = p.week_h;
  p.moH           = p.mo_h;
  p.proposed      = !!p.proposed;
  p.dormant       = !!p.dormant;
  // Remove raw DB column names (frontend uses camelCase)
  delete p.goal_approved; delete p.week_status; delete p.week_h;
  delete p.mo_h; delete p.tl_start; delete p.tl_end;
  return p;
}

// Build a full person object
function loadPerson(row) {
  const sched = {};
  const schedRows = db.prepare('SELECT day, slot, available FROM people_schedule WHERE person_id = ?').all(row.id);
  ['Mon','Tue','Wed','Thu','Fri'].forEach(d => {
    sched[d] = [0,1,2].map(s => {
      const r = schedRows.find(x => x.day === d && x.slot === s);
      return r ? !!r.available : false;
    });
  });
  const projs = db.prepare(`
    SELECT pp.project_id AS pid, proj.name AS p, pp.hours_this AS h, pp.hours_next AS nextH, pp.note
    FROM people_projects pp
    JOIN projects proj ON proj.id = pp.project_id
    WHERE pp.person_id = ?
  `).all(row.id);
  return {
    id:         row.id,
    name:       row.name,
    ini:        row.ini,
    role:       row.role,
    avail:      row.avail,
    availTxt:   row.avail_txt,
    totalH:     row.total_h,
    availH:     row.avail_h,
    submitted:  !!row.submitted,
    inactive:   !!row.inactive,
    emoji:      row.emoji,
    schedule:   sched,
    projs,
    poNote:          row.po_note,
    pmNote:          row.pm_note,
    leadership:      row.leadership,
    lastCheckinWeek: row.last_checkin_week || '',
  };
}

// ─── GET /api/data  ───────────────────────────────────────────────────────────
// Single endpoint that loads everything the frontend needs on first paint.
// Minimises round-trips: one fetch, then the whole UI renders synchronously.
app.get('/api/data', (req, res) => {
  try {
    // Projects
    const projects = db.prepare('SELECT id FROM projects ORDER BY id').all()
      .map(row => loadProject(row.id));

    // Status history: top-4 most recent entries per project
    const histRows = db.prepare(`
      SELECT project_id, week_label AS wk, status AS s, note
      FROM project_status_history
      ORDER BY project_id, id DESC
    `).all();
    const statusHistory = {};
    histRows.forEach(row => {
      if (!statusHistory[row.project_id]) statusHistory[row.project_id] = [];
      if (statusHistory[row.project_id].length < 4) {
        statusHistory[row.project_id].push({ wk: row.wk, s: row.s, note: row.note });
      }
    });

    // People
    const people = db.prepare('SELECT * FROM people ORDER BY id').all()
      .map(loadPerson);

    // Monthly reviews
    const reviewRows = db.prepare('SELECT month, saved, saved_on, data FROM monthly_reviews').all();
    const reviews     = {};
    const savedReviews = {};
    reviewRows.forEach(row => {
      const data = JSON.parse(row.data);
      reviews[row.month] = { ...data, saved: !!row.saved, savedOn: row.saved_on };
      if (row.saved) savedReviews[row.month] = true;
    });

    const managers = db.prepare('SELECT name FROM managers').all().map(r => r.name);
    res.json({ projects, people, statusHistory, reviews, savedReviews, managers });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/projects/:id  ─────────────────────────────────────────────────
// Partial update: send only the fields you want to change.
// Supported fields: status, phase, goal, goalApproved, weekStatus, celebrate, decision
// Also logs a status-history row when status changes.
app.patch('/api/projects/:id', (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const fields = req.body;      // e.g. { status: 'amber', editor: 'Jacob Sherson' }
    const editor = fields.editor || 'unknown';

    const allowed = ['status','phase','goal','goal_approved','week_status','celebrate','decision','proposed','dormant'];
    const updates = [];
    const vals    = [];

    // Map camelCase frontend keys → snake_case DB columns
    const keyMap  = { goalApproved:'goal_approved', weekStatus:'week_status' };
    Object.entries(fields).forEach(([k, v]) => {
      const col = keyMap[k] || k;
      if (allowed.includes(col)) { updates.push(`${col} = ?`); vals.push(v); }
    });

    if (updates.length) {
      db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...vals, id);
    }

    // Record status history when status changes
    if (fields.status) {
      db.prepare('INSERT INTO project_status_history (project_id, week_label, status, note) VALUES (?,?,?,?)')
        .run(id, weekLabel(), fields.status, fields.weekNote || '');
      const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(id);
      logChange(editor, 'status_change', proj ? proj.name : String(id), `→ ${fields.status}`);
    }

    res.json(loadProject(id));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/projects/:id/team  ──────────────────────────────────────────────
// Replace the entire team for a project.
// Body: { team: [{n: 'Name', r: 'PO'|'PM'|'C'|...}], editor: '...' }
app.put('/api/projects/:id/team', (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const team = req.body.team || [];
    db.prepare('DELETE FROM project_team WHERE project_id = ?').run(id);
    const ins = db.prepare('INSERT INTO project_team (project_id, person_name, role) VALUES (?,?,?)');
    const insertAll = db.transaction(() => team.forEach(m => ins.run(id, m.n, m.r)));
    insertAll();
    res.json(loadProject(id));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/projects  ──────────────────────────────────────────────────────
// Create a new (proposed) project.
app.post('/api/projects', (req, res) => {
  try {
    const { name, editor } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = db.prepare(`
      INSERT INTO projects (name, status, proposed, color)
      VALUES (?, 'green', 1, '#1a5fa8')
    `).run(name);
    logChange(editor || '', 'project_added', name.trim(), 'Project proposed');
    res.status(201).json(loadProject(r.lastInsertRowid));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/projects/:id/milestones  ───────────────────────────────────────
app.post('/api/projects/:id/milestones', (req, res) => {
  try {
    const id     = parseInt(req.params.id);
    const { type, label, date } = req.body;
    const r = db.prepare('INSERT INTO project_milestones (project_id, label, type, date) VALUES (?,?,?,?)')
      .run(id, label, type || 'm', date || '');
    res.status(201).json({ id: r.lastInsertRowid, l: label, t: type, d: date });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/milestones/:id  ──────────────────────────────────────────────
app.delete('/api/milestones/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM project_milestones WHERE id = ?').run(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/people/:id  ───────────────────────────────────────────────────
// Update a person's fields. Mainly used for the inactive toggle in manage mode.
app.patch('/api/people/:id', (req, res) => {
  try {
    const id      = parseInt(req.params.id);
    const allowed = ['inactive','submitted','avail','avail_txt','avail_h','emoji','po_note','pm_note','leadership'];
    const keyMap  = { availTxt:'avail_txt', availH:'avail_h', poNote:'po_note', pmNote:'pm_note' };
    const updates = [];
    const vals    = [];
    Object.entries(req.body).forEach(([k, v]) => {
      const col = keyMap[k] || k;
      if (allowed.includes(col)) { updates.push(`${col} = ?`); vals.push(v); }
    });
    if (updates.length) {
      db.prepare(`UPDATE people SET ${updates.join(', ')} WHERE id = ?`).run(...vals, id);
    }
    res.json(loadPerson(db.prepare('SELECT * FROM people WHERE id = ?').get(id)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PATCH /api/allocation  ───────────────────────────────────────────────────
// Update hours_next or note for a specific person+project pairing.
app.patch('/api/allocation', (req, res) => {
  try {
    const { projId, personId, hours, note, editor } = req.body;
    const now = new Date().toISOString();

    // Check if a row already exists
    const existing = db.prepare('SELECT id FROM people_projects WHERE person_id = ? AND project_id = ?').get(personId, projId);

    if (existing) {
      if (hours !== undefined) {
        db.prepare('UPDATE people_projects SET hours_next = ?, updated_by = ?, updated_at = ? WHERE person_id = ? AND project_id = ?')
          .run(hours, editor, now, personId, projId);
      }
      if (note !== undefined) {
        db.prepare('UPDATE people_projects SET note = ?, updated_by = ?, updated_at = ? WHERE person_id = ? AND project_id = ?')
          .run(note, editor, now, personId, projId);
      }
    } else {
      // First-time entry for this person+project
      db.prepare('INSERT INTO people_projects (person_id, project_id, hours_this, hours_next, note, updated_by, updated_at) VALUES (?,?,0,?,?,?,?)')
        .run(personId, projId, hours || 0, note || '', editor, now);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/checkins  ──────────────────────────────────────────────────────
app.post('/api/checkins', (req, res) => {
  try {
    const { type, person, weekLabel: wk, data, updates } = req.body;
    db.prepare('INSERT INTO checkins (type, person_name, week_label, data) VALUES (?,?,?,?)')
      .run(type, person, wk || '', JSON.stringify(data || {}));

    let updatedPerson = null;

    if (person) {
      db.prepare('UPDATE people SET submitted = 1, last_checkin_week = ? WHERE name = ?')
        .run(wk || '', person);

      if (updates) {
        const pRow = db.prepare('SELECT * FROM people WHERE name = ?').get(person);
        if (pRow) {
          const pid = pRow.id;

          // Scalar fields
          const cols = [], vals = [];
          if (updates.emoji    !== undefined) { cols.push('emoji = ?');    vals.push(updates.emoji); }
          if (updates.avail    !== undefined) { cols.push('avail = ?');    vals.push(updates.avail); }
          if (updates.availTxt !== undefined) { cols.push('avail_txt = ?');vals.push(updates.availTxt); }
          if (updates.availH   !== undefined) { cols.push('avail_h = ?');  vals.push(updates.availH); }
          if (updates.pmNote   !== undefined) { cols.push('pm_note = ?');  vals.push(updates.pmNote); }
          if (updates.poNote   !== undefined) { cols.push('po_note = ?');  vals.push(updates.poNote); }
          if (cols.length) db.prepare(`UPDATE people SET ${cols.join(', ')} WHERE id = ?`).run(...vals, pid);

          // Schedule
          if (updates.schedule) {
            const upd = db.prepare('UPDATE people_schedule SET available = ? WHERE person_id = ? AND day = ? AND slot = ?');
            ['Mon','Tue','Wed','Thu','Fri'].forEach(day => {
              const blocks = updates.schedule[day];
              if (Array.isArray(blocks)) blocks.forEach((on, slot) => upd.run(on ? 1 : 0, pid, day, slot));
            });
          }

          // Project allocations (contributor)
          if (Array.isArray(updates.projs)) {
            const now = new Date().toISOString();
            updates.projs.forEach(({ project, hoursThis, hoursNext, note }) => {
              if (!project) return;
              const projRow = db.prepare('SELECT id FROM projects WHERE name = ?').get(project);
              if (!projRow) return;
              const ex = db.prepare('SELECT id FROM people_projects WHERE person_id = ? AND project_id = ?').get(pid, projRow.id);
              if (ex) {
                db.prepare('UPDATE people_projects SET hours_this = ?, hours_next = ?, note = ?, updated_by = ?, updated_at = ? WHERE person_id = ? AND project_id = ?')
                  .run(hoursThis || 0, hoursNext || 0, note || '', person, now, pid, projRow.id);
              } else {
                db.prepare('INSERT INTO people_projects (person_id, project_id, hours_this, hours_next, note, updated_by, updated_at) VALUES (?,?,?,?,?,?,?)')
                  .run(pid, projRow.id, hoursThis || 0, hoursNext || 0, note || '', person, now);
              }
            });
          }

          updatedPerson = loadPerson(db.prepare('SELECT * FROM people WHERE id = ?').get(pid));
        }
      }
    }

    res.status(201).json({ ok: true, person: updatedPerson });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/checkins  ───────────────────────────────────────────────────────
// List submitted check-ins (most recent first). Useful for future review features.
app.get('/api/checkins', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, type, person_name, week_label, submitted_at FROM checkins ORDER BY id DESC LIMIT 100').all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/reviews/:month/save  ───────────────────────────────────────────
app.post('/api/reviews/:month/save', (req, res) => {
  try {
    const { month } = req.params;
    const dateStr = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
    db.prepare('UPDATE monthly_reviews SET saved = 1, saved_on = ? WHERE month = ?').run(dateStr, month);
    res.json({ ok: true, savedOn: dateStr });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/managers  ───────────────────────────────────────────────────────
app.get('/api/managers', (req, res) => {
  res.json(db.prepare('SELECT name FROM managers').all().map(r => r.name));
});

// ─── POST /api/managers  ──────────────────────────────────────────────────────
app.post('/api/managers', (req, res) => {
  try {
    const { name, editor } = req.body;
    if (!isManager(editor)) return res.status(403).json({ error: 'not a manager' });
    if (!name) return res.status(400).json({ error: 'name required' });
    db.prepare('INSERT OR IGNORE INTO managers (name) VALUES (?)').run(name);
    logChange(editor, 'manager_added', name, 'Promoted to manager');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/managers/:name  ──────────────────────────────────────────────
app.delete('/api/managers/:name', (req, res) => {
  try {
    const { editor } = req.body;
    if (!isManager(editor)) return res.status(403).json({ error: 'not a manager' });
    const name = decodeURIComponent(req.params.name);
    const count = db.prepare('SELECT COUNT(*) AS c FROM managers').get().c;
    if (count <= 1) return res.status(400).json({ error: 'cannot remove last manager' });
    db.prepare('DELETE FROM managers WHERE name = ?').run(name);
    logChange(editor, 'manager_removed', name, 'Removed from managers');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/people  ────────────────────────────────────────────────────────
// Manager-only: create a new person with a default schedule.
app.post('/api/people', (req, res) => {
  try {
    const { name, role, totalH, editor } = req.body;
    if (!isManager(editor)) return res.status(403).json({ error: 'not a manager' });
    if (!name) return res.status(400).json({ error: 'name required' });
    const ini = name.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('').slice(0, 2);
    const r = db.prepare(`
      INSERT INTO people (name, ini, role, avail, avail_txt, total_h, avail_h, submitted, inactive)
      VALUES (?, ?, ?, 'green', '', ?, 0, 0, 0)
    `).run(name, ini, role || 'c', totalH || 37);
    const pid = r.lastInsertRowid;
    const ins = db.prepare('INSERT INTO people_schedule (person_id, day, slot, available) VALUES (?,?,?,?)');
    ['Mon','Tue','Wed','Thu','Fri'].forEach(d => [0,1,2].forEach(s => ins.run(pid, d, s, 1)));
    const newPerson = loadPerson(db.prepare('SELECT * FROM people WHERE id = ?').get(pid));
    logChange(editor, 'person_added', name, `Role: ${role || 'c'}`);
    res.status(201).json(newPerson);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/people/:id  ──────────────────────────────────────────────────
// Manager-only: soft-remove a person (sets inactive=1).
app.delete('/api/people/:id', (req, res) => {
  try {
    const { editor } = req.body;
    if (!isManager(editor)) return res.status(403).json({ error: 'not a manager' });
    const _removedId = parseInt(req.params.id);
    const _removedName = db.prepare('SELECT name FROM people WHERE id = ?').get(_removedId)?.name || String(_removedId);
    db.prepare('UPDATE people SET inactive = 1 WHERE id = ?').run(_removedId);
    logChange(editor, 'person_removed', _removedName, 'Removed by ' + editor);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/projects/:id  ────────────────────────────────────────────────
// Manager-only: permanently delete a project and all related rows (CASCADE).
app.delete('/api/projects/:id', (req, res) => {
  try {
    const { editor } = req.body;
    if (!isManager(editor)) return res.status(403).json({ error: 'not a manager' });
    const _pid = parseInt(req.params.id);
    const _pname = db.prepare('SELECT name FROM projects WHERE id = ?').get(_pid)?.name || String(_pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(_pid);
    logChange(editor, 'project_deleted', _pname, 'Deleted by ' + editor);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/admin/changelog  ───────────────────────────────────────────────
app.get('/api/admin/changelog', (req, res) => {
  if (!isManager(req.query.editor)) return res.status(403).json({ error: 'not a manager' });
  const rows = db.prepare('SELECT * FROM change_log ORDER BY id DESC LIMIT 500').all();
  res.json(rows);
});

// ─── GET /api/admin/snapshots  ───────────────────────────────────────────────
app.get('/api/admin/snapshots', (req, res) => {
  if (!isManager(req.query.editor)) return res.status(403).json({ error: 'not a manager' });
  try {
    const files = fs.readdirSync(SNAPSHOT_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(SNAPSHOT_DIR, f));
        return { id: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    res.json(files);
  } catch(e) { res.json([]); }
});

// ─── POST /api/admin/snapshots  ──────────────────────────────────────────────
app.post('/api/admin/snapshots', async (req, res) => {
  try {
    const { editor, label } = req.body;
    if (!isManager(editor)) return res.status(403).json({ error: 'not a manager' });
    const ts  = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const slug = label ? '-' + label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) : '';
    const filename = `snapshot-${ts}${slug}.db`;
    await db.backup(path.join(SNAPSHOT_DIR, filename));
    logChange(editor, 'snapshot_created', filename, label || '');
    res.json({ id: filename });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/admin/snapshots/:id/restore  ──────────────────────────────────
app.post('/api/admin/snapshots/:id/restore', (req, res) => {
  try {
    const { editor } = req.body;
    if (!isManager(editor)) return res.status(403).json({ error: 'not a manager' });
    const filename = req.params.id;
    if (/[/\\.]\./.test(filename)) return res.status(400).json({ error: 'invalid id' });
    const snapPath = path.join(SNAPSHOT_DIR, filename);
    if (!fs.existsSync(snapPath)) return res.status(404).json({ error: 'not found' });

    const tables = [
      'projects', 'project_team', 'project_milestones', 'project_status_history',
      'people', 'people_schedule', 'people_projects',
      'checkins', 'monthly_reviews', 'managers',
    ];
    const safe = snapPath.replace(/\\/g, '/').replace(/'/g, "''");
    db.exec(`ATTACH DATABASE '${safe}' AS snap`);
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        tables.forEach(t => {
          const exists = db.prepare(`SELECT 1 FROM snap.sqlite_master WHERE type='table' AND name=?`).get(t);
          if (exists) { db.exec(`DELETE FROM main.${t}`); db.exec(`INSERT INTO main.${t} SELECT * FROM snap.${t}`); }
        });
        // change_log: restore if present, else leave current
        const hasCl = db.prepare(`SELECT 1 FROM snap.sqlite_master WHERE type='table' AND name='change_log'`).get();
        if (hasCl) { db.exec('DELETE FROM main.change_log'); db.exec('INSERT INTO main.change_log SELECT * FROM snap.change_log'); }
      })();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('DETACH DATABASE snap');
    }
    logChange(editor, 'snapshot_restored', filename, `Restored by ${editor}`);
    res.json({ ok: true });
  } catch(e) {
    console.error(e);
    try { db.exec('DETACH DATABASE snap'); } catch(_) {}
    res.status(500).json({ error: e.message });
  }
});

// ─── DELETE /api/admin/snapshots/:id  ────────────────────────────────────────
app.delete('/api/admin/snapshots/:id', (req, res) => {
  try {
    const { editor } = req.body;
    if (!isManager(editor)) return res.status(403).json({ error: 'not a manager' });
    const filename = req.params.id;
    if (/[/\\.]\./.test(filename)) return res.status(400).json({ error: 'invalid id' });
    const snapPath = path.join(SNAPSHOT_DIR, filename);
    if (!fs.existsSync(snapPath)) return res.status(404).json({ error: 'not found' });
    fs.unlinkSync(snapPath);
    ['-wal', '-shm'].forEach(ext => { try { fs.unlinkSync(snapPath + ext); } catch(_) {} });
    res.json({ ok: true });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Catch-all: serve the SPA ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CHI Dashboard running on http://localhost:${PORT}`));
