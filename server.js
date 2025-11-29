const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const AUTH_SECRET = process.env.AUTH_SECRET || 'change-me-secret';
const CREDS_PATH = process.env.CREDS_PATH || path.join(__dirname, 'credentials.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Ensure creds file dir exists
fs.mkdirSync(path.dirname(CREDS_PATH), { recursive: true });

function cleanRelPath(p) {
  return p
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '..' && segment !== '.')
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('/');
}

const storage = multer.diskStorage({
  destination: async (_req, file, cb) => {
    try {
      const rel = cleanRelPath(file.originalname);
      const dir = path.dirname(rel);
      const target = path.join(UPLOAD_DIR, dir);
      await fs.promises.mkdir(target, { recursive: true });
      cb(null, target);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const rel = cleanRelPath(file.originalname);
    const safeBase = path.basename(rel);
    cb(null, safeBase);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', authMiddleware, express.static(UPLOAD_DIR, { maxAge: '1h', redirect: false }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

async function collectFiles(baseDir, rel = '') {
  const entries = await fs.promises.readdir(path.join(baseDir, rel));
  const results = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const relPath = path.join(rel, name);
    const normalized = relPath.split(path.sep).join('/');
    const fullPath = path.join(baseDir, relPath);
    const stats = await fs.promises.stat(fullPath);
    if (stats.isDirectory()) {
      const children = await collectFiles(baseDir, relPath);
      results.push({ name, path: normalized, isDir: true, children });
    } else if (stats.isFile()) {
      results.push({
        name,
        path: normalized,
        isDir: false,
        size: stats.size,
        uploadedAt: stats.birthtime || stats.mtime,
        url: `/uploads/${encodeURIComponent(normalized).replace(/%2F/g, '/')}`,
      });
    }
  }
  return results;
}

function credsExist() {
  return fs.existsSync(CREDS_PATH);
}

function loadCreds() {
  if (!credsExist()) return null;
  const raw = fs.readFileSync(CREDS_PATH, 'utf-8');
  return JSON.parse(raw);
}

function getCreds() {
  const existing = loadCreds();
  if (existing) return existing;
  if (ADMIN_PASSWORD) {
    const username = ADMIN_USERNAME || 'admin';
    const record = { username, ...hashPassword(ADMIN_PASSWORD) };
    fs.writeFileSync(CREDS_PATH, JSON.stringify(record, null, 2));
    return record;
  }
  return null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function tokenForCreds(creds) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(`${creds.username}|${creds.hash}`).digest('hex');
}

function verifyPassword(password, creds) {
  const hash = crypto.scryptSync(password, creds.salt, 64).toString('hex');
  return hash === creds.hash;
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const creds = getCreds();
  if (!creds) return res.status(401).json({ error: 'Setup required' });
  const expected = tokenForCreds(creds);
  if (!token || token !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/auth/state', (_req, res) => {
  res.json({ configured: credsExist() || !!ADMIN_PASSWORD });
});

app.post('/api/auth/setup', (req, res) => {
  if (credsExist() || ADMIN_PASSWORD) return res.status(400).json({ error: 'Already configured' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const hashed = hashPassword(password);
  const record = { username, ...hashed };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(record, null, 2));
  res.json({ token: tokenForCreds(record) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const creds = getCreds();
  if (!creds) return res.status(401).json({ error: 'Setup required' });
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username !== creds.username || !verifyPassword(password, creds)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ token: tokenForCreds(creds) });
});

app.get('/api/files', authMiddleware, async (_req, res) => {
  try {
    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
    const tree = await collectFiles(UPLOAD_DIR, '');
    res.json({ tree });
  } catch (err) {
    console.error('Could not list files', err);
    res.status(500).json({ error: 'Could not list files' });
  }
});

app.post('/api/upload', authMiddleware, upload.array('files'), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
  res.json({
    files: files.map((f) => ({
      name: f.filename,
      originalName: f.originalname,
      size: f.size,
      url: `/uploads/${encodeURIComponent(f.filename)}`,
    })),
  });
});

app.delete('/api/files', authMiddleware, async (req, res) => {
  const rel = cleanRelPath(req.query.path || '');
  if (!rel) return res.status(400).json({ error: 'Path required' });
  const target = path.join(UPLOAD_DIR, rel);
  try {
    const stats = await fs.promises.stat(target);
    if (stats.isDirectory()) return res.status(400).json({ error: 'Deleting folders is not supported' });
    await fs.promises.unlink(target);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    console.error('Could not delete file', err);
    res.status(500).json({ error: 'Could not delete file' });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'Unexpected error' });
});

app.listen(PORT, () => {
  console.log(`File upload server listening on port ${PORT}`);
});
