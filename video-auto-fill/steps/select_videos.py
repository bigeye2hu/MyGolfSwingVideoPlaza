"""
Step 2: 轮询选视频 — TikHub API
按教练"最后处理时间"排序，从最久没处理的教练的抖音主页拉最新视频列表，
过滤掉已处理的 aweme_id，选出待下载视频。
"""
import json
import re
import subprocess

from config import TIKHUB_TOKEN, TIKHUB_BASE, COACH_CURSORS_FILE


def _coaches_eligible_for_autofill(coaches: list[dict]) -> list[dict]:
    """有抖音主页且未关闭自动抓取的教练。"""
    out = []
    for c in coaches:
        if not c.get("douyinUrl"):
            continue
        if c.get("autoFillEnabled") is False:
            continue
        out.append(c)
    return out
from utils.dedup import is_duplicate, load_operations


def _curl_get(url: str, params: dict | None = None, timeout: int = 20) -> dict:
    cmd = [
        "curl", "-s", "--noproxy", "*",
        url,
        "-H", f"Authorization: Bearer {TIKHUB_TOKEN}",
        "--connect-timeout", "15", "--max-time", str(timeout),
    ]
    if params:
        for k, v in params.items():
            cmd += ["-G", "--data-urlencode", f"{k}={v}"]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
    if result.returncode != 0:
        raise RuntimeError(f"curl失败: {result.stderr[:200]}")
    return json.loads(result.stdout)


def get_sec_uid(douyin_url: str) -> str | None:
    """从抖音主页 URL 提取 sec_uid"""
    # 先试从 URL 直接提取
    match = re.search(r"/user/([A-Za-z0-9_-]+)", douyin_url)
    if match:
        candidate = match.group(1)
        if candidate.startswith("MS4wLj"):
            return candidate.split("?")[0]

    # 走 TikHub 解析
    try:
        data = _curl_get(
            f"{TIKHUB_BASE}/api/v1/douyin/web/get_sec_user_id",
            params={"url": douyin_url},
        )
        inner = data.get("data")
        if isinstance(inner, str):
            return inner
        if isinstance(inner, dict):
            return inner.get("user", {}).get("sec_uid") or inner.get("sec_uid")
    except Exception as e:
        print(f"    ⚠️ get_sec_uid 失败: {e}")
    return None


def get_user_videos(sec_uid: str, count: int = 10, max_cursor: int = 0) -> tuple[list[dict], int, bool]:
    """
    拉取用户主页视频列表。
    返回 (aweme_list, next_cursor, has_more)。
    max_cursor=0 表示从最新开始。
    """
    try:
        params = {"sec_user_id": sec_uid, "count": str(count)}
        if max_cursor:
            params["max_cursor"] = str(max_cursor)
        data = _curl_get(
            f"{TIKHUB_BASE}/api/v1/douyin/web/fetch_user_post_videos",
            params=params,
        )
        inner = data.get("data")
        if isinstance(inner, dict):
            videos = inner.get("aweme_list", [])
            next_cursor = inner.get("max_cursor", 0)
            has_more = inner.get("has_more", False)
            if isinstance(has_more, int):
                has_more = has_more == 1
            return videos, int(next_cursor) if next_cursor else 0, bool(has_more)
    except Exception as e:
        print(f"    ⚠️ get_user_videos 失败: {e}")
    return [], 0, False


def _extract_url(text: str) -> str:
    """从抖音分享文本中提取真实 URL"""
    m = re.search(r'https?://[^\s<>"\']+', text)
    return m.group(0).rstrip("/") if m else text.strip()


def _resolve_aweme_id(url: str) -> str | None:
    """从各种格式的抖音链接中提取 aweme_id"""
    # 1. 长链直接提取
    m = re.search(r"/video/(\d+)", url)
    if m:
        return m.group(1)
    m = re.search(r"aweme_id=(\d+)", url)
    if m:
        return m.group(1)

    # 2. 短链先 HTTP 跟踪重定向
    try:
        import requests as _req
        s = _req.Session()
        s.proxies = {"http": None, "https": None}
        resp = s.head(url, allow_redirects=True, timeout=10)
        m = re.search(r"/video/(\d+)", resp.url)
        if m:
            return m.group(1)
    except Exception:
        pass

    # 3. 短链走 TikHub 解析
    try:
        data = _curl_get(
            f"{TIKHUB_BASE}/api/v1/douyin/web/get_sec_user_id",
            params={"url": url},
        )
        # TikHub 有时能直接返回 aweme_id
        inner = data.get("data", {})
        if isinstance(inner, dict):
            aid = inner.get("aweme_id", "")
            if aid:
                return aid
    except Exception:
        pass

    return None


def fetch_single_video(url_or_text: str) -> dict | None:
    """通过抖音链接/分享文本获取单个视频详情（供 --url 模式使用）"""
    url = _extract_url(url_or_text)
    print(f"  🔗 解析URL: {url}")

    aweme_id = _resolve_aweme_id(url)
    if not aweme_id:
        print(f"  ❌ 无法从链接提取 aweme_id")
        return None
    print(f"  🆔 aweme_id: {aweme_id}")

    try:
        data = _curl_get(
            f"{TIKHUB_BASE}/api/v1/douyin/web/fetch_one_video",
            params={"aweme_id": aweme_id},
        )
        aweme = data.get("data", {}).get("aweme_detail", {})
        if not aweme:
            return None

        author = aweme.get("author", {})
        video = aweme.get("video", {})
        play_addr = video.get("play_addr", {})
        download_urls = play_addr.get("url_list", []) if isinstance(play_addr, dict) else []

        cover_url = ""
        for key in ("cover", "dynamic_cover", "origin_cover"):
            urls = video.get(key, {}).get("url_list", [])
            if urls:
                cover_url = urls[0] if isinstance(urls[0], str) else urls[0].get("url", "")
                if cover_url:
                    break

        return {
            "aweme_id": aweme_id,
            "title": aweme.get("desc", "无标题")[:100],
            "author": author.get("nickname", "未知"),
            "sec_uid": author.get("sec_uid", ""),
            "duration": video.get("duration", 0) / 1000,
            "resolution": f"{video.get('height', 720)}p",
            "download_url": download_urls[0] if download_urls else None,
            "cover_url": cover_url,
        }
    except Exception as e:
        print(f"  ❌ fetch_single_video 失败: {e}")
        return None


def _coach_last_time(coach_id: str) -> str:
    """从操作日志获取教练最后处理时间"""
    last = "1970-01-01"
    for op in load_operations():
        if op.get("coach_id") == coach_id:
            ts = op.get("timestamp", "")
            if ts > last:
                last = ts
    return last


def select_videos_round_robin(coaches: list[dict], count: int = 1) -> list[tuple[dict, dict]]:
    """
    轮询算法选视频。
    返回 [(video_info, coach), ...]
    """
    eligible = _coaches_eligible_for_autofill(coaches)
    if not eligible:
        print("  ⚠️ 没有可参与自动抓取的教练（需抖音主页且未关闭自动抓取）")
        return []

    sorted_coaches = sorted(eligible, key=lambda c: _coach_last_time(c["id"]))

    selected: list[tuple[dict, dict]] = []
    used_coaches: set[str] = set()

    for _round in range(min(10, len(sorted_coaches))):
        if len(selected) >= count:
            break
        for coach in sorted_coaches:
            if len(selected) >= count:
                break
            if coach["id"] in used_coaches:
                continue

            print(f"  🔍 [{coach['name']}] 获取视频列表...")
            sec_uid = get_sec_uid(coach["douyinUrl"])
            if not sec_uid:
                print(f"    ⚠️ 无法获取 sec_uid，跳过")
                continue

            videos, _, _ = get_user_videos(sec_uid, count=10)
            for v in videos:
                aid = v.get("aweme_id", "")
                if not aid:
                    continue
                dup, _, _ = is_duplicate(aid)
                if dup:
                    continue
                if any(s[0].get("aweme_id") == aid for s in selected):
                    continue

                # 构造标准 video_info
                video_obj = v.get("video", {})
                play_addr = video_obj.get("play_addr", {})
                dl_urls = play_addr.get("url_list", []) if isinstance(play_addr, dict) else []

                cover_url = ""
                for key in ("cover", "dynamic_cover", "origin_cover"):
                    urls = video_obj.get(key, {}).get("url_list", [])
                    if urls:
                        cover_url = urls[0] if isinstance(urls[0], str) else ""
                        if cover_url:
                            break

                info = {
                    "aweme_id": aid,
                    "title": v.get("desc", "无标题")[:100],
                    "author": v.get("author", {}).get("nickname", "未知"),
                    "sec_uid": v.get("author", {}).get("sec_uid", ""),
                    "duration": video_obj.get("duration", 0) / 1000,
                    "resolution": f"{video_obj.get('height', 720)}p",
                    "download_url": dl_urls[0] if dl_urls else None,
                    "cover_url": cover_url,
                }
                selected.append((info, coach))
                used_coaches.add(coach["id"])
                print(f"    ✅ 选中: {info['title'][:40]}")
                break

    return selected


# ── Daemon 模式：双向翻页 + cursor 状态 ──

def _load_cursors() -> dict:
    if not COACH_CURSORS_FILE.exists():
        return {}
    with open(COACH_CURSORS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_cursors(cursors: dict):
    COACH_CURSORS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(COACH_CURSORS_FILE, "w", encoding="utf-8") as f:
        json.dump(cursors, f, ensure_ascii=False, indent=2)


def _aweme_to_video_info(v: dict) -> dict | None:
    """从 TikHub aweme 对象提取标准 video_info"""
    aid = v.get("aweme_id", "")
    if not aid:
        return None
    video_obj = v.get("video", {})
    play_addr = video_obj.get("play_addr", {})
    dl_urls = play_addr.get("url_list", []) if isinstance(play_addr, dict) else []

    cover_url = ""
    for key in ("cover", "dynamic_cover", "origin_cover"):
        urls = video_obj.get(key, {}).get("url_list", [])
        if urls:
            cover_url = urls[0] if isinstance(urls[0], str) else ""
            if cover_url:
                break

    return {
        "aweme_id": aid,
        "title": v.get("desc", "无标题")[:100],
        "author": v.get("author", {}).get("nickname", "未知"),
        "sec_uid": v.get("author", {}).get("sec_uid", ""),
        "duration": video_obj.get("duration", 0) / 1000,
        "resolution": f"{video_obj.get('height', 720)}p",
        "download_url": dl_urls[0] if dl_urls else None,
        "cover_url": cover_url,
    }


def select_video_for_daemon(coaches: list[dict]) -> tuple[dict, dict] | None:
    """
    Daemon 模式专用：双向策略选1个视频。
    Pass 1: 拉最新一页，找新视频（追新）
    Pass 2: 从 cursor 继续往更早翻1页（深挖）
    返回 (video_info, coach) 或 None。
    """
    eligible = _coaches_eligible_for_autofill(coaches)
    if not eligible:
        print("  ⚠️ 没有可参与自动抓取的教练（需抖音主页且未关闭自动抓取）")
        return None

    sorted_coaches = sorted(eligible, key=lambda c: _coach_last_time(c["id"]))
    cursors = _load_cursors()

    # ── Pass 1: 拉最新页，追新视频 ──
    for coach in sorted_coaches:
        cid = coach["id"]
        print(f"  🔍 [{coach['name']}] 检查最新视频...")
        sec_uid = get_sec_uid(coach["douyinUrl"])
        if not sec_uid:
            print(f"    ⚠️ 无法获取 sec_uid，跳过")
            continue

        videos, _, _ = get_user_videos(sec_uid, count=10, max_cursor=0)
        for v in videos:
            info = _aweme_to_video_info(v)
            if not info:
                continue
            dup, _, _ = is_duplicate(info["aweme_id"])
            if not dup:
                print(f"    ✅ [新] 选中: {info['title'][:40]}")
                return info, coach

    # ── Pass 2: 从 cursor 深挖历史视频 ──
    for coach in sorted_coaches:
        cid = coach["id"]
        state = cursors.get(cid, {})
        if state.get("exhausted"):
            continue

        saved_cursor = state.get("max_cursor", 0)
        if not saved_cursor:
            # 还没开始深挖，需要先拉第1页拿到 cursor
            sec_uid = get_sec_uid(coach["douyinUrl"])
            if not sec_uid:
                continue
            _, next_cursor, has_more = get_user_videos(sec_uid, count=10, max_cursor=0)
            if not has_more or not next_cursor:
                cursors[cid] = {"max_cursor": 0, "exhausted": True}
                _save_cursors(cursors)
                continue
            saved_cursor = next_cursor

        print(f"  🔍 [{coach['name']}] 深挖历史视频 (cursor={saved_cursor})...")
        sec_uid = get_sec_uid(coach["douyinUrl"])
        if not sec_uid:
            continue

        videos, next_cursor, has_more = get_user_videos(sec_uid, count=10, max_cursor=saved_cursor)

        # 更新 cursor 状态
        if not has_more or not next_cursor:
            cursors[cid] = {"max_cursor": 0, "exhausted": True}
            print(f"    📭 [{coach['name']}] 历史视频已全部挖完")
        else:
            cursors[cid] = {"max_cursor": next_cursor, "exhausted": False}
        _save_cursors(cursors)

        for v in videos:
            info = _aweme_to_video_info(v)
            if not info:
                continue
            dup, _, _ = is_duplicate(info["aweme_id"])
            if not dup:
                print(f"    ✅ [历史] 选中: {info['title'][:40]}")
                return info, coach

    return None
