# Simple File Drop

Tiny self-hosted file upload web app. One container runs both the API and a minimal HTML UI.

## Quick start (Docker)
```bash
# clone (if you don't already have the repo on this machine)
git clone https://github.com/KAV7272/team-todo.git
cd team-todo

# build and run
sudo mkdir -p "$(pwd)/uploads"
sudo docker build -t simple-file-drop .
sudo docker run -p 3000:3000 -e ADMIN_USERNAME="admin" -e ADMIN_PASSWORD="change-me" -v "$(pwd)/uploads:/app/uploads" simple-file-drop
```
- Open http://localhost:3000 to upload files.
- Log in with the username/password you passed via env (or create one on first visit if you skipped those env vars).
- The host volume keeps your uploaded files. Remove the `-v` flag if you want everything to be ephemeral.
- If you see `permission denied` for the Docker socket, add your user to the docker group: `sudo usermod -aG docker $USER` then log out/in (or keep using `sudo docker ...`).
- If you omit `ADMIN_USERNAME` / `ADMIN_PASSWORD`, you'll be prompted to create them on first visit.

## Local run
```bash
npm install
ADMIN_USERNAME="admin" ADMIN_PASSWORD="change-me" node server.js
```

## Configuration
- `PORT` (default: 3000)
- `UPLOAD_DIR` (default: `/app/uploads` inside the container)
- `NODE_ENV=production` to disable Express error details.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` (optional; if omitted, you'll be prompted to create them on first visit)
- `AUTH_SECRET` (optional; used to derive tokens)

## API
- `GET /api/files` — list uploads as a tree (files include `path`, `size`, `uploadedAt`, `url`).
- `POST /api/upload` — multipart upload with field name `files` (supports multiple files and folders).
- `DELETE /api/files?path=<relativePath>` — remove an uploaded file.
- `POST /api/auth/state` — returns `{ configured: boolean }`.
- `POST /api/auth/setup` — `{ username, password }` (only when not configured) → `{ token }`.
- `POST /api/login` — `{ username, password }` → `{ token }`; use token as `Authorization: Bearer <token>` for API and downloads.
- Files are served from `/uploads/<relativePath>` for downloading.

## Notes
- Max upload size is 50 MB (changeable in `server.js`).
- Filenames are sanitized and prefixed to avoid collisions.
