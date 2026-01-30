# Deploy online (quick)

## Option A — Netlify (static + /api proxy)
1. Create a new site on Netlify
2. Drag & drop this folder **equi-scoreboard** (or connect a repo)
3. The included `netlify.toml` will:
   - publish the folder as a static site
   - proxy `/api/*` to `https://api.equiresults.com/v1/*` (same-origin, no CORS)

## Option B — Render (Python web service)
1. Create a new Web Service on Render
2. Point it to your repo, or upload it as a zip (if using repo is easier)
3. Start command: `python server.py`
4. Build command: (none)
5. Add Python version if needed; `requirements.txt` includes `certifi`

This runs the static site **and** the proxy in one process.
