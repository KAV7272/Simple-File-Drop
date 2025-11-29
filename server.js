const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeOriginal = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const unique = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    cb(null, `${unique}-${safeOriginal}`);
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

app.get('/api/files', async (_req, res) => {
  try {
    const entries = await fs.promises.readdir(UPLOAD_DIR);
    const files = (
      await Promise.all(
        entries
          .filter((name) => !name.startsWith('.'))
          .map(async (name) => {
            const fullPath = path.join(UPLOAD_DIR, name);
            const stats = await fs.promises.stat(fullPath);
            if (!stats.isFile()) return null;
            return {
              name,
              size: stats.size,
              uploadedAt: stats.birthtime || stats.mtime,
              url: `/uploads/${encodeURIComponent(name)}`,
            };
          }),
      )
    ).filter(Boolean);
    files.sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json({ files });
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

app.delete('/api/files/:name', async (req, res) => {
  const fileName = path.basename(req.params.name);
  const target = path.join(UPLOAD_DIR, fileName);
  try {
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
