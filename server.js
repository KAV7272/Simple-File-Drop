const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h', redirect: false }));

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

app.get('/api/files', async (_req, res) => {
  try {
    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
    const tree = await collectFiles(UPLOAD_DIR, '');
    res.json({ tree });
  } catch (err) {
    console.error('Could not list files', err);
    res.status(500).json({ error: 'Could not list files' });
  }
});

app.post('/api/upload', upload.array('files'), (req, res) => {
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

app.delete('/api/files', async (req, res) => {
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
