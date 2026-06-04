"""
视频广场自动内容填充系统 - 配置
"""
import os
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()

# ── 路径 ──
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
VIDEOS_DIR = DATA_DIR / "videos"
OPERATIONS_FILE = DATA_DIR / "operations.json"

# ── 腾讯云 CloudBase ──
CLOUDBASE_API = _env(
    "CLOUDBASE_API",
    "https://mygolfswingapp-9g2izywqa8ac3f5b-1259543736.ap-shanghai.app.tcloudbase.com/videoPlaza",
)
ADMIN_KEY = _env("PLAZA_ADMIN_KEY")

# ── 腾讯云 VOD ──
VOD_SECRET_ID = _env("VOD_SECRET_ID")
VOD_SECRET_KEY = _env("VOD_SECRET_KEY")
VOD_REGION = _env("VOD_REGION", "ap-shanghai")

# ── TikHub ──
TIKHUB_TOKEN = _env("TIKHUB_TOKEN")
TIKHUB_BASE = _env("TIKHUB_BASE", "https://api.tikhub.io")

# ── LLM (MiniMax) ──
LLM_API_URL = _env("LLM_API_URL", "https://api.minimaxi.com/anthropic/v1/messages")
LLM_API_KEY = _env("LLM_API_KEY")
LLM_MODEL = _env("LLM_MODEL", "MiniMax-M2.7")

# ── 运行参数 ──
DEFAULT_DOWNLOAD_COUNT = 1

# ── 自动填充云端配置兜底（云函数不可用时）──
AUTO_FILL_FALLBACK_INTERVAL_HOURS = 4
AUTO_FILL_FALLBACK_VIDEOS_PER_ROUND = 1
AUTO_FILL_MAX_VIDEOS_PER_ROUND = 20
AUTO_FILL_MAX_INTERVAL_HOURS = 168

# ── Daemon 模式 ──
DAEMON_INTERVAL = 4 * 3600          # 每轮间隔（秒），4小时；云端可覆盖，此为兜底
CONSECUTIVE_FAIL_THRESHOLD = 3      # 连续失败多少次后进入回退休息
FAIL_BACKOFF = 30 * 60              # 连续失败回退休息时间（秒），30分钟
LOCAL_FILE_KEEP_HOURS = 24          # 本地视频文件保留时长（小时）
COACH_CURSORS_FILE = DATA_DIR / "coach_cursors.json"
OPS_KEEP_DAYS = 30                  # operations.json 保留天数
DAEMON_API_PORT = 9090              # Daemon 状态 API 端口
