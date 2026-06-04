"""
管理后台 HTTP 服务器
- 静态文件服务（admin.html）
- 代理 /api/daemon/* 请求到本地 Daemon API (localhost:9090)
"""
import http.server
import json
import urllib.request
import urllib.error
import os
import sys

ADMIN_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("ADMIN_PORT", 9527))
DAEMON_API = "http://localhost:9090"


class AdminHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ADMIN_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        if self.path.startswith("/api/daemon/"):
            self.send_response(200)
            self._cors()
            self.end_headers()
        else:
            super().do_OPTIONS()

    def do_GET(self):
        if self.path.startswith("/api/daemon/"):
            self._proxy_to_daemon("GET")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/daemon/"):
            self._proxy_to_daemon("POST")
        else:
            self.send_response(405)
            self.end_headers()

    def _proxy_to_daemon(self, method):
        url = DAEMON_API + self.path
        try:
            req = urllib.request.Request(url, method=method)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.URLError:
            self.send_response(502)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Daemon API 未运行"}).encode())
        except Exception as e:
            self.send_response(500)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), AdminHandler)
    print(f"管理后台已启动: http://0.0.0.0:{PORT}/index.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        sys.exit(0)
