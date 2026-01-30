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
import os
import ssl
try:
    import certifi  # type: ignore
except Exception:
    certifi = None

UPSTREAM = "https://api.equiresults.com/v1"

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # helpful even though same-origin; harmless
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._proxy()
            return
        return super().do_GET()

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
                self.wfile.write(data)
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
