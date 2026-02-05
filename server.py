#!/usr/bin/env python3
"""Static server + Equiresults proxy (avoids browser CORS issues).

- Serves the current folder (index.html, assets, etc.)
- Proxies requests from /api/<path> to https://api.equiresults.com/v1/<path>
  Example: GET /api/competitions/15450/classes.json  ->  https://api.equiresults.com/v1/competitions/15450/classes.json
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from urllib.parse import urlsplit
import json
import os
import ssl
import threading
import time
try:
    import certifi  # type: ignore
except Exception:
    certifi = None

UPSTREAM = "https://api.equiresults.com/v1"
LIVE_TOKEN = os.environ.get("LIVE_TOKEN", "secret-token-change-me")
HEARTBEAT_TTL = 60  # seconds

# Registry: (competition_id, arena_name) -> {source_id, last_heartbeat, live_state, ts}
registry_lock = threading.Lock()
registry = {}

def now_ts():
    return time.time()

def json_response(handler, status, payload):
    data = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)

def parse_json(handler):
    length = int(handler.headers.get("Content-Length") or "0")
    raw = handler.rfile.read(length) if length else b""
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        return None

def auth_ok(handler):
    auth = handler.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    token = auth.split(" ", 1)[1]
    return token == LIVE_TOKEN

def cleanup_registry():
    while True:
        time.sleep(HEARTBEAT_TTL)
        cutoff = now_ts() - HEARTBEAT_TTL
        with registry_lock:
            to_delete = []
            for k, v in registry.items():
                if v.get("last_heartbeat", 0) < cutoff:
                    to_delete.append(k)
            for k in to_delete:
                registry.pop(k, None)

cleanup_thread = threading.Thread(target=cleanup_registry, daemon=True)
cleanup_thread.start()

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # helpful even though same-origin; harmless
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/live/current"):
            return self._get_current()
        if self.path.startswith("/live/registry"):
            return self._get_registry()
        if self.path.startswith("/api/"):
            self._proxy()
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/live/"):
            return self._handle_live_post()
        self.send_response(404)
        self.end_headers()

    # ----------- LIVE endpoints -----------
    def _handle_live_post(self):
        if not auth_ok(self):
            json_response(self, 401, {"error": "unauthorized"})
            return

        payload = parse_json(self)
        if payload is None:
            json_response(self, 400, {"error": "invalid_json"})
            return

        if self.path.startswith("/live/register"):
            return self._live_register(payload)
        if self.path.startswith("/live/unregister"):
            return self._live_unregister(payload)
        if self.path.startswith("/live/heartbeat"):
            return self._live_heartbeat(payload)
        if self.path.startswith("/live/event"):
            return self._live_event(payload)

        json_response(self, 404, {"error": "not_found"})

    def _live_register(self, p):
        comp = p.get("competition_id")
        arena = p.get("arena_name")
        source = p.get("source_id")
        ts = p.get("ts") or now_ts()
        if not comp or not arena or not source:
            return json_response(self, 400, {"error": "missing_fields"})
        key = (str(comp), str(arena))
        live_state = {
            "current_bib": None,
            "state": "idle",
            "penalty": 0,
            "start_time": None,
            "finish_time": None,
            "rank": None,
            "pending_events": [],
        }
        with registry_lock:
            registry[key] = {
                "source_id": str(source),
                "competition_id": str(comp),
                "arena_name": str(arena),
                "last_heartbeat": ts,
                "ts": ts,
                "live_state": live_state,
            }
        return json_response(self, 200, {"ok": True})

    def _live_unregister(self, p):
        source = p.get("source_id")
        if not source:
            return json_response(self, 400, {"error": "missing_source"})
        removed = 0
        with registry_lock:
            for k in list(registry.keys()):
                if registry[k].get("source_id") == source:
                    registry.pop(k, None)
                    removed += 1
        return json_response(self, 200, {"ok": True, "removed": removed})

    def _live_heartbeat(self, p):
        source = p.get("source_id")
        ts = p.get("ts") or now_ts()
        if not source:
            return json_response(self, 400, {"error": "missing_source"})
        updated = False
        with registry_lock:
            for k, v in registry.items():
                if v.get("source_id") == source:
                    v["last_heartbeat"] = ts
                    updated = True
        if not updated:
            return json_response(self, 404, {"error": "not_registered"})
        return json_response(self, 200, {"ok": True})

    def _append_event(self, entry, ev):
        st = entry.setdefault("live_state", {})
        lst = st.setdefault("pending_events", [])
        lst.append(ev)
        # cap the list to avoid unbounded growth
        if len(lst) > 50:
            del lst[:-50]
        st["pending_events"] = lst
        entry["live_state"] = st

    def _live_event(self, p):
        etype = p.get("type")
        source = p.get("source_id")
        comp = p.get("competition_id")
        arena = p.get("arena_name")
        ts = p.get("ts") or now_ts()
        if not all([etype, source, comp, arena]):
            return json_response(self, 400, {"error": "missing_fields"})
        key = (str(comp), str(arena))
        with registry_lock:
            entry = registry.get(key)
            if not entry or entry.get("source_id") != str(source):
                return json_response(self, 404, {"error": "not_registered"})
            st = entry["live_state"]
            entry["last_heartbeat"] = ts
            bib = p.get("bib")

            if etype == "bib_change":
                st["current_bib"] = bib
                st["finish_time"] = None
                st["rank"] = None
                st["penalty"] = 0
                print(f"[EVENT] bib_change: bib={bib}")
                # keep state/start_time as-is (timer may keep running)
            elif etype == "start":
                st["current_bib"] = bib
                st["start_time"] = p.get("start_time") or ts
                st["state"] = "running"
                st["finish_time"] = None
                st["rank"] = None
                st["penalty"] = st.get("penalty", 0)
                chrono = p.get("chrono_time")
                mono = p.get("mono_ts")
                print(f"[EVENT] start: bib={bib} chrono_time={chrono} mono_ts={mono}")
                self._append_event(entry, {
                    "type": "start",
                    "bib": bib,
                    "chrono_time": chrono,
                    "mono_ts": mono,
                    "ts": ts,
                })
            elif etype == "time_anchor":
                # pure timing event, no state change
                chrono = p.get("chrono_time")
                mono = p.get("mono_ts")
                print(f"[EVENT] time_anchor: bib={bib} chrono_time={chrono} mono_ts={mono}")
                self._append_event(entry, {
                    "type": "time_anchor",
                    "bib": bib,
                    "chrono_time": chrono,
                    "mono_ts": mono,
                    "ts": ts,
                })
            elif etype == "phase_reset":
                raw = p.get("raw_time")
                mono = p.get("mono_ts")
                win = p.get("window_sec")
                print(f"[EVENT] phase_reset: bib={bib} raw_time={raw} mono_ts={mono} window_sec={win}")
                self._append_event(entry, {
                    "type": "phase_reset",
                    "bib": bib,
                    "raw_time": raw,
                    "mono_ts": mono,
                    "window_sec": win,
                    "ts": ts,
                })
            elif etype == "penalty":
                pen = p.get("penalty")
                st["current_bib"] = bib or st.get("current_bib")
                st["penalty"] = pen
                print(f"[EVENT] penalty: bib={bib} penalty={pen}")
            elif etype == "finish":
                ftime = p.get("time")
                pen = p.get("penalty")
                rank = p.get("rank")
                st["current_bib"] = bib or st.get("current_bib")
                st["finish_time"] = ftime
                st["penalty"] = pen
                st["rank"] = rank
                st["state"] = "finished"
                print(f"[EVENT] finish: bib={bib} time={ftime} penalty={pen} rank={rank}")
            else:
                return json_response(self, 400, {"error": "unknown_type"})

            entry["live_state"] = st
            registry[key] = entry

        return json_response(self, 200, {"ok": True})

    def _get_current(self):
        from urllib.parse import parse_qs

        qs = parse_qs(urlsplit(self.path).query or "")
        comp = qs.get("competition_id", [None])[0]
        arena = qs.get("arena_name", [None])[0]
        if not comp or not arena:
            return json_response(self, 400, {"error": "missing_params"})

        key = (str(comp), str(arena))
        cutoff = now_ts() - HEARTBEAT_TTL
        with registry_lock:
            entry = registry.get(key)
            if not entry or entry.get("last_heartbeat", 0) < cutoff:
                return json_response(self, 200, {"available": False})
            payload = {
                "available": True,
                "source_id": entry.get("source_id"),
                "last_heartbeat": entry.get("last_heartbeat"),
                "competition_id": entry.get("competition_id"),
                "arena_name": entry.get("arena_name"),
            }
            st = entry.get("live_state", {}) or {}
            # extract pending events and clear them
            pending = st.get("pending_events", []) or []
            st["pending_events"] = []
            entry["live_state"] = st
            registry[key] = entry  # save cleared state immediately to avoid race
            payload.update(st)
            if pending:
                payload["timing_events"] = pending
                print(f"[DEBUG] Sending {len(pending)} timing events to frontend: {[e.get('type') for e in pending]}")
            print(f"[DEBUG] Current state - bib:{st.get('current_bib')} state:{st.get('state')} rank:{st.get('rank')} penalty:{st.get('penalty')}")
            return json_response(self, 200, payload)

    def _get_registry(self):
        with registry_lock:
            data = {
                f"{k[0]}|{k[1]}": {
                    "source_id": v.get("source_id"),
                    "last_heartbeat": v.get("last_heartbeat"),
                    "live_state": v.get("live_state"),
                }
                for k, v in registry.items()
            }
        return json_response(self, 200, data)

    def _proxy(self):
        rel = self.path[len("/api"):]  # keep leading /
        # Preserve query string and drop fragments.
        q = urlsplit(self.path).query
        rel = urlsplit(rel).path + (("?" + q) if q else "")
        url = UPSTREAM + rel
        try:
            req = Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            })
            # Build SSL context with a known CA bundle to avoid macOS Python CA issues.
            if certifi is not None:
                ctx = ssl.create_default_context(cafile=certifi.where())
            else:
                ctx = ssl.create_default_context()

            with urlopen(req, timeout=20, context=ctx) as resp:
                data = resp.read()
                self.send_response(resp.status)
                ct = resp.headers.get("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Type", ct)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    self.wfile.write(data)
                except BrokenPipeError:
                    # client closed the connection (common with rapid polling); just drop
                    self.close_connection = True
                    return
        except HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"Upstream HTTPError {e.code}: {e.reason}\n{url}".encode("utf-8"))
        except URLError as e:
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"Upstream URLError: {e}\n{url}".encode("utf-8"))
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"Proxy error: {e}\n{url}".encode("utf-8"))

def main():
    port = int(os.environ.get("PORT", "8080"))
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Serving on http://localhost:{port} (static + /api proxy)")
    httpd.serve_forever()

if __name__ == "__main__":
    main()
