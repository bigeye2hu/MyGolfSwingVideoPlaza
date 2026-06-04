"""
Step 6: 发布到视频广场 (addVideo API)
"""
import json
import subprocess
import time
from datetime import datetime

from config import CLOUDBASE_API, ADMIN_KEY


def publish_to_plaza(
    video_info: dict,
    vod_url: str,
    file_id: str,
    cover_url: str,
    coach_id: str,
    category_id: str,
    tags: list[str],
    added_by: str = "manual",
    classification_hit: str = "manual",
    max_retries: int = 3,
) -> bool:
    """
    调用 addVideo 发布到视频广场。
    videoId 由服务端自动生成，sourceAwemeId 用于去重追溯。
    """
    payload = {
        "action": "addVideo",
        "adminKey": ADMIN_KEY,
        "title": video_info["title"],
        "vodFileId": file_id,
        "vodURL": vod_url,
        "coverURL": cover_url or "",
        "duration": int(video_info.get("duration", 0)),
        "resolution": video_info.get("resolution", "720p"),
        "coachId": coach_id,
        "categoryId": category_id,
        "sourceType": "curated",
        "sourceAwemeId": video_info["aweme_id"],
        "tags": tags,
        "addedBy": added_by,
        "classificationHit": classification_hit,
    }

    delay = 5
    for attempt in range(1, max_retries + 1):
        try:
            print(f"  📢 发布中 (第{attempt}次)...")
            cmd = [
                "curl", "-s", "--noproxy", "*",
                "-X", "POST", CLOUDBASE_API,
                "-H", "Content-Type: application/json",
                "-d", json.dumps(payload),
                "--connect-timeout", "10", "--max-time", "20",
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
            if result.returncode != 0:
                raise RuntimeError(f"curl失败: {result.stderr[:200]}")

            data = json.loads(result.stdout)
            if data.get("success"):
                vid = data.get("video", {}).get("videoId", "?")
                print(f"  ✅ 发布成功 (videoId={vid})")
                return True
            else:
                err = data.get("error", "未知错误")
                print(f"  ⚠️ 发布返回失败: {err}")
                if "已存在" in err:
                    print(f"  ⏭️ 视频已存在，视为成功")
                    return True
        except Exception as e:
            print(f"  ⚠️ 第{attempt}次发布失败: {e}")

        if attempt < max_retries:
            wait = delay * (2 ** (attempt - 1))
            print(f"  ⏳ {wait}秒后重试...")
            time.sleep(wait)

    print(f"  ❌ 发布失败（重试{max_retries}次）")
    return False
