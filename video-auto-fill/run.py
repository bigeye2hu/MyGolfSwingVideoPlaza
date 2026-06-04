#!/usr/bin/env python3
"""
视频广场自动内容填充系统 - 入口

用法:
    python run.py                    # 自动选1个视频，走完全流程
    python run.py --count 2          # 一次处理2个
    python run.py --url <抖音链接>    # 指定视频链接
    python run.py --daemon           # 常态化模式，每4小时自动处理
"""
import argparse
import json
import logging
import logging.handlers
import os
import signal
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

# 确保能 import 同级模块
sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (
    DEFAULT_DOWNLOAD_COUNT, DATA_DIR, VIDEOS_DIR, OPERATIONS_FILE,
    DAEMON_INTERVAL, CONSECUTIVE_FAIL_THRESHOLD, FAIL_BACKOFF,
    LOCAL_FILE_KEEP_HOURS, OPS_KEEP_DAYS, DAEMON_API_PORT,
    AUTO_FILL_FALLBACK_INTERVAL_HOURS,
    AUTO_FILL_FALLBACK_VIDEOS_PER_ROUND,
    AUTO_FILL_MAX_VIDEOS_PER_ROUND,
    AUTO_FILL_MAX_INTERVAL_HOURS,
)

# 同时输出到终端和日志文件（带轮转）
_log_file = DATA_DIR / "run.log"
_log_file.parent.mkdir(parents=True, exist_ok=True)

_rotating = logging.handlers.RotatingFileHandler(
    _log_file, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8",
)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        _rotating,
    ],
)
log = logging.getLogger("autofill")

# 把 print 重定向到 log，这样所有模块的 print 也会写入日志
class _LogWriter:
    def __init__(self, logger, level, original):
        self.logger = logger
        self.level = level
        self.original = original
    def write(self, msg):
        if msg.strip():
            self.logger.log(self.level, msg.rstrip())
        self.original.write(msg)
    def flush(self):
        self.original.flush()

sys.stdout = _LogWriter(log, logging.INFO, sys.__stdout__)
sys.stderr = _LogWriter(log, logging.ERROR, sys.__stderr__)
from steps.fetch_whitelist import fetch_coaches, fetch_categories, create_coach, fetch_auto_fill_config
from steps.select_videos import select_videos_round_robin, fetch_single_video, select_video_for_daemon
from steps.download import download_video
from steps.upload_vod import upload_to_vod
from steps.classify import match_category, generate_tags
from steps.quality import review_video_quality, record_quality_candidate
from steps.publish import publish_to_plaza
from utils.dedup import is_duplicate, log_upload, log_publish

# ── 全局 shutdown 标志 ──
_shutdown = False
_trigger_now = False

# ── 运行时配置（云端可覆盖，见 refresh_runtime_config）──
_runtime_interval_sec = DAEMON_INTERVAL
_runtime_videos_per_round = AUTO_FILL_FALLBACK_VIDEOS_PER_ROUND


def refresh_runtime_config() -> None:
    """从云端拉取自动填充间隔与每轮条数，失败则用 config 兜底。"""
    global _runtime_interval_sec, _runtime_videos_per_round
    cfg = fetch_auto_fill_config()
    if cfg:
        h = int(cfg.get("publishIntervalHours", AUTO_FILL_FALLBACK_INTERVAL_HOURS))
        v = int(cfg.get("videosPerRound", AUTO_FILL_FALLBACK_VIDEOS_PER_ROUND))
    else:
        h = AUTO_FILL_FALLBACK_INTERVAL_HOURS
        v = AUTO_FILL_FALLBACK_VIDEOS_PER_ROUND
    h = max(1, min(AUTO_FILL_MAX_INTERVAL_HOURS, h))
    v = max(1, min(AUTO_FILL_MAX_VIDEOS_PER_ROUND, v))
    _runtime_interval_sec = h * 3600
    _runtime_videos_per_round = v

def _signal_handler(signum, frame):
    global _shutdown
    sig_name = signal.Signals(signum).name
    print(f"\n⚠️ 收到信号 {sig_name}，将在当前视频处理完后退出...")
    _shutdown = True

signal.signal(signal.SIGINT, _signal_handler)
signal.signal(signal.SIGTERM, _signal_handler)

# ── Daemon 共享状态（供 API server 读取）──
_daemon_state = {
    "running": False,
    "start_time": None,
    "round": 0,
    "total_processed": 0,
    "total_success": 0,
    "total_fail": 0,
    "status": "idle",
    "current_video": None,
    "last_round_time": None,
    "next_round_time": None,
}


def _start_daemon_api():
    """启动 HTTP API server（后台线程），供管理后台查询状态和控制"""
    from http.server import HTTPServer, BaseHTTPRequestHandler
    import threading

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self):
            self.send_response(200)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if self.path == "/api/daemon/status":
                state = dict(_daemon_state)
                state["publishIntervalHours"] = _runtime_interval_sec // 3600
                state["videosPerRound"] = _runtime_videos_per_round
                if state["start_time"]:
                    state["uptime_seconds"] = (datetime.now() - state["start_time"]).total_seconds()
                    state["start_time"] = state["start_time"].isoformat()
                if state["last_round_time"]:
                    state["last_round_time"] = state["last_round_time"].isoformat()
                if state["next_round_time"]:
                    state["next_round_time"] = state["next_round_time"].isoformat()
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(state, ensure_ascii=False).encode())
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self):
            global _shutdown, _trigger_now
            if self.path == "/api/daemon/stop":
                _shutdown = True
                resp = {"success": True, "message": "停止信号已发送，等待当前任务完成..."}
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(resp, ensure_ascii=False).encode())
            elif self.path == "/api/daemon/trigger":
                _trigger_now = True
                resp = {"success": True, "message": "已触发立即执行，将在几秒内开始下一轮"}
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(resp, ensure_ascii=False).encode())
            elif self.path == "/api/daemon/reload-config":
                refresh_runtime_config()
                _trigger_now = True
                resp = {
                    "success": True,
                    "message": "已从云端刷新配置并唤醒等待",
                    "publishIntervalHours": _runtime_interval_sec // 3600,
                    "videosPerRound": _runtime_videos_per_round,
                }
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(resp, ensure_ascii=False).encode())
            else:
                self.send_response(404)
                self.end_headers()

    server = HTTPServer(("0.0.0.0", DAEMON_API_PORT), Handler)
    server.daemon_threads = True
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print(f"  🌐 Daemon API 已启动: http://0.0.0.0:{DAEMON_API_PORT}/api/daemon/status")


def process_one(video_info: dict, coach: dict, categories_data: dict, added_by: str = "manual") -> bool:
    """处理单个视频的完整流程：下载 → 上传VOD → 分类 → 发布"""
    aweme_id = video_info["aweme_id"]
    title = video_info["title"]
    coach_id = coach["id"]

    print(f"\n{'─'*50}")
    print(f"📥 处理: [{coach['name']}] {title[:50]}")
    print(f"   aweme_id={aweme_id}")
    print(f"{'─'*50}")

    # ── 去重 ──
    dup, existing_fid, existing_url = is_duplicate(aweme_id)
    if dup and existing_fid:
        print(f"  ⏭️ VOD已有此视频，跳过下载/上传，直接发布")
        vod_url = existing_url or ""
        file_id = existing_fid
        cover_url = video_info.get("cover_url", "")
        quality_review = review_video_quality(video_info, coach, categories_data)
    elif dup:
        print(f"  ⏭️ 视频已处理过，跳过")
        return True
    else:
        # ── 质量筛选：低质内容不下载、不上传 VOD ──
        print(f"  🔎 正在评估视频质量...")
        quality_review = review_video_quality(video_info, coach, categories_data)
        q = quality_review.get("qualityStatus", "standard")
        print(f"  🔎 质量: {q} ({quality_review.get('reason', '')})")
        if q == "hidden":
            record_quality_candidate(video_info, coach, quality_review)
            print(f"  ⏭️ 已拦截为低质候选，不下载/上传")
            return True

        # ── 下载 ──
        local_path = download_video(video_info)
        if not local_path:
            return False

        # ── 上传 VOD ──
        vod_url, file_id, cover_url = upload_to_vod(local_path)
        if not file_id:
            return False

        log_upload(aweme_id, file_id, vod_url, coach_id, title)

    # 封面：优先用抖音原始封面
    douyin_cover = video_info.get("cover_url", "")
    if douyin_cover:
        cover_url = douyin_cover

    # ── 分类 ──
    print(f"  🏷️ 正在分类...")
    category_id, cat_msg = match_category(title, "", categories_data)
    if cat_msg:
        print(f"  🔔 {cat_msg}")

    if cat_msg is None:
        classification_hit = "hit"
    elif "已创建新分类" in (cat_msg or ""):
        classification_hit = "created"
    else:
        classification_hit = "missed"

    # ── 标签 ──
    print(f"  🏷️ 正在生成标签...")
    tags = generate_tags(title)
    if tags:
        print(f"  🏷️ 标签: {', '.join(tags)}")

    # ── 发布 ──
    ok = publish_to_plaza(
        video_info=video_info,
        vod_url=vod_url or "",
        file_id=file_id,
        cover_url=cover_url or "",
        coach_id=coach_id,
        category_id=category_id,
        tags=tags,
        added_by=added_by,
        classification_hit=classification_hit,
        quality_status=quality_review.get("qualityStatus", "standard"),
        quality_review=quality_review,
    )
    if ok:
        log_publish(aweme_id, file_id, coach_id, title)
    return ok


def run_auto(count: int):
    """自动模式：轮询选视频"""
    print(f"\n{'='*60}")
    print(f"🤖 视频广场自动填充")
    print(f"⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"📦 目标: {count} 个视频")
    print(f"{'='*60}")

    # Step 1: 拉白名单
    print(f"\n📋 Step 1: 拉取教练和分类...")
    try:
        coaches = fetch_coaches()
        categories_data = fetch_categories()
        print(f"  ✅ {len(coaches)} 个教练, {len(categories_data['categories'])} 个分类")
    except Exception as e:
        print(f"  ❌ 拉取白名单失败: {e}")
        return

    # Step 2: 选视频
    print(f"\n🔍 Step 2: 轮询选视频...")
    selected = select_videos_round_robin(coaches, count=count)
    if not selected:
        print("  ❌ 没有找到可处理的新视频")
        return

    print(f"\n📦 选中 {len(selected)} 个视频:")
    for info, coach in selected:
        print(f"  [{coach['name']}] {info['title'][:40]}")

    # Step 3~6: 逐个处理
    results = []
    for info, coach in selected:
        # 教练不在白名单时自动创建
        coach_ids = [c["id"] for c in coaches]
        if coach["id"] not in coach_ids:
            new_id = create_coach(info["author"], info.get("sec_uid", ""))
            if new_id:
                coach = {**coach, "id": new_id}

        ok = process_one(info, coach, categories_data, added_by="script-轮询")
        results.append({"title": info["title"][:40], "success": ok, "coach": coach["name"]})

    # 摘要
    success_count = sum(1 for r in results if r["success"])
    print(f"\n{'='*60}")
    print(f"📊 结果: {success_count}/{len(results)} 成功")
    for r in results:
        icon = "✅" if r["success"] else "❌"
        print(f"  {icon} [{r['coach']}] {r['title']}")
    print(f"{'='*60}")


def run_url(url: str):
    """指定链接模式"""
    print(f"\n{'='*60}")
    print(f"🎬 处理指定视频")
    print(f"⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"🔗 {url}")
    print(f"{'='*60}")

    # 拉白名单
    print(f"\n📋 拉取教练和分类...")
    try:
        coaches = fetch_coaches()
        categories_data = fetch_categories()
    except Exception as e:
        print(f"  ❌ 拉取白名单失败: {e}")
        return

    # 获取视频信息
    print(f"\n🔍 获取视频信息...")
    video_info = fetch_single_video(url)
    if not video_info:
        print(f"  ❌ 无法获取视频信息")
        return

    print(f"  标题: {video_info['title']}")
    print(f"  作者: {video_info['author']}")
    print(f"  时长: {video_info['duration']:.0f}s")

    # 匹配教练
    author = video_info["author"]
    sec_uid = video_info.get("sec_uid", "")
    coach = None

    # 先用 sec_uid 匹配
    if sec_uid:
        for c in coaches:
            if sec_uid in c.get("douyinUrl", ""):
                coach = c
                break

    # 再用名字匹配
    if not coach:
        for c in coaches:
            if c["name"] == author:
                coach = c
                break

    # 自动创建教练
    if not coach:
        print(f"  ⚠️ 教练未匹配，自动创建: {author}")
        new_id = create_coach(author, sec_uid)
        if not new_id:
            print(f"  ❌ 创建教练失败")
            return
        coach = {"id": new_id, "name": author}

    print(f"  教练: {coach['name']} (id={coach['id']})")

    ok = process_one(video_info, coach, categories_data, added_by="script-单链接")
    print(f"\n{'✅ 完成' if ok else '❌ 失败'}")


def _cleanup_local_videos():
    """删除超过 LOCAL_FILE_KEEP_HOURS 的本地视频文件"""
    if not VIDEOS_DIR.exists():
        return
    cutoff = time.time() - LOCAL_FILE_KEEP_HOURS * 3600
    cleaned = 0
    for child in VIDEOS_DIR.iterdir():
        if not child.is_dir():
            continue
        mp4s = list(child.glob("*.mp4"))
        if not mp4s:
            continue
        for mp4 in mp4s:
            if mp4.stat().st_mtime < cutoff:
                mp4.unlink()
                cleaned += 1
        # 如果文件夹空了，也删掉
        remaining = list(child.iterdir())
        if not remaining:
            child.rmdir()
    if cleaned:
        print(f"  🗑️ 清理了 {cleaned} 个过期视频文件")


def _cleanup_old_operations():
    """清理 operations.json 中超过 OPS_KEEP_DAYS 天的记录"""
    if not OPERATIONS_FILE.exists():
        return
    try:
        with open(OPERATIONS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        ops = data.get("operations", [])
        cutoff = (datetime.now() - timedelta(days=OPS_KEEP_DAYS)).isoformat()
        before = len(ops)
        ops = [op for op in ops if op.get("timestamp", "") >= cutoff]
        if len(ops) < before:
            with open(OPERATIONS_FILE, "w", encoding="utf-8") as f:
                json.dump({"operations": ops}, f, ensure_ascii=False, indent=2)
            print(f"  🗑️ 清理了 {before - len(ops)} 条过期操作记录（保留{OPS_KEEP_DAYS}天内）")
    except Exception as e:
        print(f"  ⚠️ 清理操作记录失败: {e}")


def run_daemon():
    """常态化模式：无限循环；间隔与每轮条数由云端配置（见 getAutoFillConfig）。"""
    global _shutdown
    start_time = datetime.now()
    round_num = 0
    consecutive_fails = 0

    _daemon_state.update({
        "running": True,
        "start_time": start_time,
        "status": "starting",
    })

    _start_daemon_api()
    refresh_runtime_config()

    print(f"\n{'='*60}")
    print(f"🔄 视频广场自动填充 — Daemon 模式启动")
    print(f"⏰ {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"⏱️ 每轮间隔: {_runtime_interval_sec // 3600} 小时（云端可改）")
    print(f"📦 每轮条数: 至多 {_runtime_videos_per_round} 条（云端可改）")
    print(f"🌐 控制面板: http://localhost:{DAEMON_API_PORT}/api/daemon/status")
    print(f"{'='*60}")

    while not _shutdown:
        round_num += 1
        refresh_runtime_config()
        now = datetime.now()
        _daemon_state.update({"round": round_num, "status": "working", "last_round_time": now, "current_video": None})

        print(f"\n{'='*60}")
        print(f"🔄 第 {round_num} 轮 — {now.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"  ⚙️ 策略: 间隔 {_runtime_interval_sec // 3600}h / 每轮至多 {_runtime_videos_per_round} 条")
        print(f"{'='*60}")

        _cleanup_local_videos()
        _cleanup_old_operations()

        print(f"\n📋 拉取教练和分类...")
        try:
            coaches = fetch_coaches()
            categories_data = fetch_categories()
            print(f"  ✅ {len(coaches)} 个教练, {len(categories_data['categories'])} 个分类")
        except Exception as e:
            print(f"  ❌ 拉取白名单失败: {e}")
            consecutive_fails += 1
            if consecutive_fails >= CONSECUTIVE_FAIL_THRESHOLD:
                print(f"  ⚠️ 连续失败 {consecutive_fails} 次，休息 {FAIL_BACKOFF // 60} 分钟...")
                _daemon_state["status"] = "backoff"
                _interruptible_sleep(FAIL_BACKOFF)
                consecutive_fails = 0
            else:
                next_t = datetime.now() + timedelta(seconds=_runtime_interval_sec)
                _daemon_state.update({"status": "sleeping", "next_round_time": next_t})
                _interruptible_sleep(_runtime_interval_sec)
            continue

        print(f"\n🔍 双向选视频（本轮至多 {_runtime_videos_per_round} 条）...")
        _daemon_state["status"] = "selecting"

        skip_interval_sleep = False
        empty_first_slot = False

        for slot in range(_runtime_videos_per_round):
            if _shutdown:
                break

            result = select_video_for_daemon(coaches)
            if not result:
                if slot == 0:
                    empty_first_slot = True
                break

            video_info, coach = result
            _daemon_state.update({
                "status": "processing",
                "current_video": f"[{coach['name']}] {video_info['title'][:40]}",
                "total_processed": _daemon_state["total_processed"] + 1,
            })

            try:
                ok = process_one(video_info, coach, categories_data, added_by="script-自动化")
            except Exception as e:
                print(f"  ❌ 处理异常: {e}")
                ok = False

            if ok:
                _daemon_state["total_success"] += 1
                consecutive_fails = 0
            else:
                _daemon_state["total_fail"] += 1
                consecutive_fails += 1

            if consecutive_fails >= CONSECUTIVE_FAIL_THRESHOLD:
                print(f"\n⚠️ 连续失败 {consecutive_fails} 次，可能存在系统性问题")
                print(f"   休息 {FAIL_BACKOFF // 60} 分钟后重试...")
                _daemon_state["status"] = "backoff"
                _interruptible_sleep(FAIL_BACKOFF)
                consecutive_fails = 0
                skip_interval_sleep = True
                break

        if empty_first_slot:
            print(f"\n{'!'*60}")
            print(f"📭 所有可抓取教练的视频均已处理完毕！")
            print(f"   等待教练发布新视频，或在后台开启更多教练的自动抓取…")
            print(f"{'!'*60}")
            consecutive_fails = 0
            next_t = datetime.now() + timedelta(seconds=_runtime_interval_sec)
            _daemon_state.update({"status": "idle", "current_video": None, "next_round_time": next_t})
            print(f"\n💤 休息 {_runtime_interval_sec // 3600} 小时，下一轮预计 {next_t.strftime('%H:%M:%S')}...")
            _interruptible_sleep(_runtime_interval_sec)
            continue

        if _shutdown:
            break

        if skip_interval_sleep:
            continue

        uptime = datetime.now() - start_time
        print(f"\n📊 累计统计: 处理 {_daemon_state['total_processed']} 个, 成功 {_daemon_state['total_success']}, 失败 {_daemon_state['total_fail']}")
        print(f"⏱️ 已运行: {uptime}")

        next_t = datetime.now() + timedelta(seconds=_runtime_interval_sec)
        _daemon_state.update({"status": "sleeping", "current_video": None, "next_round_time": next_t})
        print(f"\n💤 休息 {_runtime_interval_sec // 3600} 小时，下一轮预计 {next_t.strftime('%H:%M:%S')}...")
        _interruptible_sleep(_runtime_interval_sec)

    # ── 退出摘要 ──
    _daemon_state.update({"running": False, "status": "stopped"})
    uptime = datetime.now() - start_time
    print(f"\n{'='*60}")
    print(f"🛑 Daemon 已停止")
    print(f"⏱️ 总运行时间: {uptime}")
    print(f"📊 总计: 处理 {_daemon_state['total_processed']} 个, 成功 {_daemon_state['total_success']}, 失败 {_daemon_state['total_fail']}")
    print(f"{'='*60}")


def _interruptible_sleep(seconds: int):
    """可被 shutdown 或 trigger 信号中断的 sleep"""
    global _trigger_now
    interval = 5
    elapsed = 0
    while elapsed < seconds and not _shutdown:
        if _trigger_now:
            _trigger_now = False
            print("  ⚡ 收到立即执行信号，跳过等待")
            return
        time.sleep(min(interval, seconds - elapsed))
        elapsed += interval


def main():
    parser = argparse.ArgumentParser(description="视频广场自动内容填充")
    parser.add_argument("--url", type=str, help="指定抖音视频链接")
    parser.add_argument("--count", type=int, default=DEFAULT_DOWNLOAD_COUNT, help="自动模式处理数量")
    parser.add_argument("--daemon", action="store_true", help="常态化模式，每4小时自动处理")
    args = parser.parse_args()

    if args.url:
        run_url(args.url)
    elif args.daemon:
        run_daemon()
    else:
        run_auto(args.count)


if __name__ == "__main__":
    main()
