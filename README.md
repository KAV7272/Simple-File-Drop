# Simple File Drop

Tiny self-hosted file upload web app. One container runs both the API and a minimal HTML UI.

## Quick start (Docker)
```bash
docker build -t simple-file-drop .
docker run -p 3000:3000 -v "$(pwd)/uploads:/app/uploads" simple-file-drop
```
- Open http://localhost:3000 to upload files.
- The host volume keeps your uploaded files. Remove the `-v` flag if you want everything to be ephemeral.

## Local run
```bash
npm install
node server.js
```

## Configuration
- `PORT` (default: 3000)
- `UPLOAD_DIR` (default: `/app/uploads` inside the container)
- `NODE_ENV=production` to disable Express error details.

## API
- `GET /api/files` — list uploaded files.
- `POST /api/upload` — multipart upload with field name `file`.
- `DELETE /api/files/:name` — remove an uploaded file.
- Files are served from `/uploads/:name` for downloading.

## Notes
- Max upload size is 50 MB (changeable in `server.js`).
- Filenames are sanitized and prefixed to avoid collisions.
