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
import re
import subprocess
import sys
from pathlib import Path

ADMIN_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("ADMIN_PORT", 9527))
DAEMON_API = "http://localhost:9090"
AUTO_FILL_DIR = Path(os.environ.get("AUTO_FILL_DIR", "/opt/video-auto-fill"))
if not AUTO_FILL_DIR.exists():
    AUTO_FILL_DIR = Path(ADMIN_DIR).parent / "video-auto-fill"
AUTO_FILL_PYTHON = os.environ.get("AUTO_FILL_PYTHON", str(AUTO_FILL_DIR / "venv" / "bin" / "python"))
if not Path(AUTO_FILL_PYTHON).exists():
    AUTO_FILL_PYTHON = sys.executable


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
        if self.path.startswith("/api/daemon/") or self.path == "/api/manual-fetch-coach":
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
        elif self.path == "/api/manual-fetch-coach":
            self._manual_fetch_coach()
        else:
            self.send_response(405)
            self.end_headers()

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _send_json(self, status, payload):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def _manual_fetch_coach(self):
        body = self._read_json_body()
        coach_id = str(body.get("coachId", "")).strip()
        if not re.match(r"^[A-Za-z0-9_\\-]{1,80}$", coach_id):
            self._send_json(400, {"success": False, "error": "coachId 格式无效"})
            return

        script = AUTO_FILL_DIR / "manual_fetch_coach.py"
        if not script.exists():
            self._send_json(500, {"success": False, "error": f"脚本不存在: {script}"})
            return

        try:
            result = subprocess.run(
                [AUTO_FILL_PYTHON, str(script), "--coach-id", coach_id],
                cwd=str(AUTO_FILL_DIR),
                capture_output=True,
                text=True,
                timeout=900,
            )
        except subprocess.TimeoutExpired:
            self._send_json(504, {"success": False, "error": "抓取任务超时"})
            return
        except Exception as e:
            self._send_json(500, {"success": False, "error": str(e)})
            return

        output = (result.stdout or "") + "\n" + (result.stderr or "")
        parsed = None
        for line in output.splitlines():
            if line.startswith("MANUAL_FETCH_RESULT="):
                try:
                    parsed = json.loads(line.split("=", 1)[1])
                except Exception:
                    parsed = None
        if not parsed:
            parsed = {"success": result.returncode == 0, "error": "未解析到任务结果" if result.returncode else "", "outputTail": output[-2000:]}
        parsed["exitCode"] = result.returncode
        parsed["outputTail"] = output[-4000:]
        self._send_json(200 if parsed.get("success") else 500, parsed)

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
