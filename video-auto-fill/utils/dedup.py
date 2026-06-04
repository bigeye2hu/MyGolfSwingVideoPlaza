"""
三层去重逻辑 + 操作日志
"""
import json
import subprocess
from datetime import datetime

from config import (
    OPERATIONS_FILE, CLOUDBASE_API, ADMIN_KEY,
    VOD_SECRET_ID, VOD_SECRET_KEY, VOD_REGION,
)


# ── 操作日志 ──

def load_operations():
    if not OPERATIONS_FILE.exists():
        return []
    with open(OPERATIONS_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("operations", [])


def append_operation(op: dict):
    ops = load_operations()
    op.setdefault("timestamp", datetime.now().isoformat() + "Z")
    ops.append(op)
    OPERATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OPERATIONS_FILE, "w", encoding="utf-8") as f:
        json.dump({"operations": ops}, f, ensure_ascii=False, indent=2)


def log_upload(aweme_id, file_id, vod_url, coach_id, title):
    append_operation({
        "operation": "upload",
        "aweme_id": aweme_id,
        "file_id": file_id,
        "vod_url": vod_url,
        "coach_id": coach_id,
        "title": title,
    })


def log_publish(aweme_id, file_id, coach_id, title):
    append_operation({
        "operation": "publish",
        "aweme_id": aweme_id,
        "file_id": file_id,
        "coach_id": coach_id,
        "title": title,
    })


# ── 第一层：本地 operations.json ──

def check_local(aweme_id) -> tuple[bool, str | None, str | None]:
    """返回 (已存在, file_id, vod_url)"""
    for op in reversed(load_operations()):
        if op.get("aweme_id") == aweme_id and op.get("operation") == "upload":
            return True, op.get("file_id"), op.get("vod_url")
    return False, None, None


def is_published_locally(aweme_id) -> bool:
    for op in load_operations():
        if op.get("aweme_id") == aweme_id and op.get("operation") == "publish":
            return True
    return False


# ── 第二层：CloudBase sourceAwemeId 查询 ──

def check_cloudbase(aweme_id) -> tuple[bool, str | None]:
    """查 plaza_videos 里有没有这个 sourceAwemeId，返回 (已存在, videoId)"""
    try:
        cmd = [
            "curl", "-s", "--noproxy", "*",
            "-X", "POST", CLOUDBASE_API,
            "-H", "Content-Type: application/json",
            "-d", json.dumps({
                "action": "adminListVideos",
                "adminKey": ADMIN_KEY,
                "sourceAwemeId": aweme_id,
            }),
            "--connect-timeout", "10", "--max-time", "15",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if result.returncode != 0:
            return False, None
        data = json.loads(result.stdout)
        videos = data.get("videos", [])
        for v in videos:
            if v.get("sourceAwemeId") == aweme_id:
                return True, v.get("videoId")
        return False, None
    except Exception as e:
        print(f"  ⚠️ CloudBase去重查询失败: {e}")
        return False, None


# ── 第三层：VOD SearchMedia ──

def check_vod(aweme_id) -> tuple[bool, str | None, str | None]:
    """直接查 VOD API，按文件名搜 aweme_id。返回 (已存在, file_id, vod_url)"""
    try:
        from tencentcloud.common import credential
        from tencentcloud.common.profile.client_profile import ClientProfile
        from tencentcloud.common.profile.http_profile import HttpProfile
        from tencentcloud.vod.v20180717 import vod_client, models

        cred = credential.Credential(VOD_SECRET_ID, VOD_SECRET_KEY)
        http_prof = HttpProfile(endpoint="vod.tencentcloudapi.com")
        client_prof = ClientProfile(httpProfile=http_prof)
        client = vod_client.VodClient(cred, VOD_REGION, client_prof)

        req = models.SearchMediaRequest()
        req.Text = aweme_id
        req.Limit = 10
        resp = client.SearchMedia(req)
        data = json.loads(resp.to_json_string())

        for m in data.get("MediaInfoSet", []):
            name = m.get("BasicInfo", {}).get("Name", "")
            if aweme_id in name:
                fid = m.get("FileId", "")
                url = m.get("BasicInfo", {}).get("MediaUrl", "")
                return True, fid, url
        return False, None, None
    except Exception as e:
        print(f"  ⚠️ VOD去重查询失败: {e}")
        return False, None, None


# ── 组合：三层去重 ──

def is_duplicate(aweme_id) -> tuple[bool, str | None, str | None]:
    """
    三层去重检查。
    返回 (是否重复, file_id, vod_url)。
    找到即停，不继续查下一层。
    """
    found, fid, vod_url = check_local(aweme_id)
    if found:
        print(f"  🔒 本地日志已有 {aweme_id}")
        return True, fid, vod_url

    cb_found, _ = check_cloudbase(aweme_id)
    if cb_found:
        print(f"  🔒 CloudBase已有 sourceAwemeId={aweme_id}")
        return True, None, None

    vod_found, fid, vod_url = check_vod(aweme_id)
    if vod_found:
        print(f"  🔒 VOD已有 {aweme_id} (file_id={fid})")
        return True, fid, vod_url

    return False, None, None
