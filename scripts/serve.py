"""Development server with range requests."""

import http.server
import os
import sys


DIRECTORY = sys.argv[2] if len(sys.argv) > 2 else "web"


class RangeHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        range_header = self.headers.get("Range")
        if not range_header:
            return super().do_GET()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return

        file_size = os.path.getsize(path)
        start_text, end_text = range_header.removeprefix("bytes=").split("-", 1)
        start = int(start_text) if start_text else 0
        end = min(int(end_text) if end_text else file_size - 1, file_size - 1)
        length = end - start + 1

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

        with open(path, "rb") as source:
            source.seek(start)
            self.wfile.write(source.read(length))

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    with http.server.HTTPServer(("", port), RangeHTTPRequestHandler) as server:
        print(f"http://localhost:{port}")
        server.serve_forever()
