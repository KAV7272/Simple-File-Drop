const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');

const app = express();
const db = new sqlite3.Database(DB_PATH);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Prevent caching of HTML so UI updates always load fresh
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    team_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(team_id) REFERENCES teams(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    assigned_to INTEGER,
    created_by INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(assigned_to) REFERENCES users(id),
    FOREIGN KEY(created_by) REFERENCES users(id),
    FOREIGN KEY(team_id) REFERENCES teams(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER,
    message TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(task_id) REFERENCES tasks(id)
  )`);
}

function generateInviteCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateToken(user) {
  return jwt.sign({ id: user.id, team_id: user.team_id, email: user.email }, JWT_SECRET, {
    expiresIn: '7d'
  });
}

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await get('SELECT id, name, email, team_id FROM users WHERE id = ?', [decoded.id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function withTeam(req, res, next) {
  if (!req.user?.team_id) {
    return res.status(400).json({ error: 'Join or create a team first' });
  }
  next();
}

async function createNotification(userId, taskId, message) {
  return run('INSERT INTO notifications (user_id, task_id, message) VALUES (?, ?, ?)', [
    userId,
    taskId,
    message
  ]);
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, teamName } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(400).json({ error: 'Email already in use' });

    const inviteCode = generateInviteCode();
    const teamLabel = teamName && teamName.trim() ? teamName.trim() : `${name}'s Team`;
    const teamInsert = await run('INSERT INTO teams (name, invite_code) VALUES (?, ?)', [teamLabel, inviteCode]);

    const passwordHash = await bcrypt.hash(password, 10);
    const userInsert = await run(
      'INSERT INTO users (name, email, password_hash, team_id) VALUES (?, ?, ?, ?)',
      [name, email, passwordHash, teamInsert.id]
    );

    const user = { id: userInsert.id, name, email, team_id: teamInsert.id };
    const token = generateToken(user);
    res.json({ token, user: { ...user, team: { id: teamInsert.id, name: teamLabel, invite_code: inviteCode } } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

    const user = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken(user);
    const team = await get('SELECT id, name, invite_code FROM teams WHERE id = ?', [user.team_id]);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, team_id: user.team_id, team } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  const team = req.user.team_id
    ? await get('SELECT id, name, invite_code FROM teams WHERE id = ?', [req.user.team_id])
    : null;
  res.json({ user: { ...req.user, team } });
});

app.post('/api/teams', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Team name required' });
    const inviteCode = generateInviteCode();
    const teamInsert = await run('INSERT INTO teams (name, invite_code) VALUES (?, ?)', [name.trim(), inviteCode]);
    await run('UPDATE users SET team_id = ? WHERE id = ?', [teamInsert.id, req.user.id]);
    res.json({ team: { id: teamInsert.id, name: name.trim(), invite_code: inviteCode } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create team' });
  }
});

app.post('/api/teams/join', auth, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ error: 'Invite code required' });
    const team = await get('SELECT id, name, invite_code FROM teams WHERE invite_code = ?', [inviteCode.trim().toUpperCase()]);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    await run('UPDATE users SET team_id = ? WHERE id = ?', [team.id, req.user.id]);
    res.json({ team });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not join team' });
  }
});

app.get('/api/users', auth, withTeam, async (req, res) => {
  try {
    const members = await all('SELECT id, name, email FROM users WHERE team_id = ? ORDER BY name', [req.user.team_id]);
    res.json({ users: members });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load users' });
  }
});

app.get('/api/tasks', auth, withTeam, async (req, res) => {
  try {
    const tasks = await all(
      `SELECT t.*, u.name AS assigned_name
       FROM tasks t
       LEFT JOIN users u ON t.assigned_to = u.id
       WHERE t.team_id = ?
       ORDER BY t.created_at DESC`,
      [req.user.team_id]
    );
    res.json({ tasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load tasks' });
  }
});

app.post('/api/tasks', auth, withTeam, async (req, res) => {
  try {
    const { title, description, assignedTo } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });

    const assigneeId = assignedTo || null;
    if (assigneeId) {
      const assignee = await get('SELECT id FROM users WHERE id = ? AND team_id = ?', [assigneeId, req.user.team_id]);
      if (!assignee) return res.status(400).json({ error: 'Assignee must be on your team' });
    }

    const insert = await run(
      'INSERT INTO tasks (title, description, assigned_to, created_by, team_id) VALUES (?, ?, ?, ?, ?)',
      [title.trim(), description || '', assigneeId, req.user.id, req.user.team_id]
    );

    if (assigneeId) {
      await createNotification(assigneeId, insert.id, `You were assigned: ${title.trim()}`);
    }

    const task = await get('SELECT * FROM tasks WHERE id = ?', [insert.id]);
    res.status(201).json({ task });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create task' });
  }
});

app.put('/api/tasks/:id', auth, withTeam, async (req, res) => {
  try {
    const task = await get('SELECT * FROM tasks WHERE id = ? AND team_id = ?', [req.params.id, req.user.team_id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const { title, description, status, assignedTo } = req.body;
    const nextTitle = title !== undefined ? title : task.title;
    const nextDescription = description !== undefined ? description : task.description;
    const nextStatus = status || task.status;
    let nextAssignee = assignedTo !== undefined ? assignedTo : task.assigned_to;

    if (nextAssignee) {
      const assignee = await get('SELECT id FROM users WHERE id = ? AND team_id = ?', [nextAssignee, req.user.team_id]);
      if (!assignee) return res.status(400).json({ error: 'Assignee must be on your team' });
    } else {
      nextAssignee = null;
    }

    await run(
      `UPDATE tasks SET title = ?, description = ?, status = ?, assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [nextTitle, nextDescription, nextStatus, nextAssignee, task.id]
    );

    if (nextAssignee && nextAssignee !== task.assigned_to) {
      await createNotification(nextAssignee, task.id, `You were assigned: ${nextTitle}`);
    }

    const updated = await get('SELECT * FROM tasks WHERE id = ?', [task.id]);
    res.json({ task: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update task' });
  }
});

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const notifications = await all(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ notifications });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load notifications' });
  }
});

app.post('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    const note = await get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!note) return res.status(404).json({ error: 'Notification not found' });
    await run('UPDATE notifications SET read = 1 WHERE id = ?', [note.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update notification' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });
