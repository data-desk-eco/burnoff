# the page, and /p/<url>: a ranged GET of url, from this origin, since the
# archive's buckets send no cors headers. uv run web/serve.py [port]
import http.server, os, sys, urllib.request

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if not self.path.startswith('/p/'): return super().do_GET()
        q = urllib.request.Request(self.path[3:], headers={
            k: v for k, v in self.headers.items() if k == 'Range'})
        try: r = urllib.request.urlopen(q)
        except urllib.error.HTTPError as e: r = e
        b = r.read()
        self.send_response(r.status)
        for k in ('Content-Range', 'Content-Type'):
            if r.headers[k]: self.send_header(k, r.headers[k])
        self.send_header('Content-Length', len(b))
        self.end_headers()
        self.wfile.write(b)

os.chdir(os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(
    ('', int(sys.argv[1]) if sys.argv[1:] else 8000), H).serve_forever()
