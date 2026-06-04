"""
Step 1: 从 CloudBase 拉取教练列表和分类树
"""
import json
import subprocess

from config import CLOUDBASE_API, ADMIN_KEY


def _curl_post(payload: dict, timeout: int = 20) -> dict:
    cmd = [
        "curl", "-s", "--noproxy", "*",
        "-X", "POST", CLOUDBASE_API,
        "-H", "Content-Type: application/json",
        "-d", json.dumps(payload),
        "--connect-timeout", "10", "--max-time", str(timeout),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
    if result.returncode != 0:
        raise RuntimeError(f"curl失败: {result.stderr[:200]}")
    return json.loads(result.stdout)


def fetch_coaches() -> list[dict]:
    """拉取教练列表，标准化输出（提取 douyinUrl）"""
    data = _curl_post({"action": "getCoaches"})
    if not data.get("success"):
        raise RuntimeError(f"getCoaches失败: {data.get('error')}")

    coaches = []
    for c in data.get("coaches", []):
        douyin_url = ""
        for link in c.get("externalLinks", []):
            if link.get("platform") == "douyin":
                douyin_url = link.get("url", "")
                break
        auto_fill = c.get("autoFillEnabled")
        if auto_fill is False:
            auto_fill_enabled = False
        else:
            auto_fill_enabled = True

        coaches.append({
            "id": c.get("id", ""),
            "name": c.get("name", ""),
            "tier": c.get("tier", ""),
            "douyinId": c.get("douyinId", ""),
            "douyinUrl": douyin_url,
            "avatarURL": c.get("avatarURL", ""),
            "autoFillEnabled": auto_fill_enabled,
        })
    return coaches


def fetch_auto_fill_config() -> dict:
    """从云函数拉取自动抓取配置；失败时返回 None。"""
    try:
        data = _curl_post({"action": "getAutoFillConfig"}, timeout=15)
        if not data.get("success"):
            return None
        cfg = data.get("config") or {}
        h = int(float(cfg.get("publishIntervalHours", 4)))
        v = int(float(cfg.get("videosPerRound", 1)))
        return {
            "publishIntervalHours": max(1, min(168, h)),
            "videosPerRound": max(1, min(20, v)),
        }
    except Exception as e:
        print(f"  ⚠️ fetch_auto_fill_config 失败: {e}")
        return None


def fetch_categories() -> dict:
    """拉取分类树，返回 {categories: [...], parentCategories: [...]}"""
    data = _curl_post({"action": "getCategories"})
    if not data.get("success"):
        raise RuntimeError(f"getCategories失败: {data.get('error')}")

    categories = data.get("categories", [])
    parents = [c for c in categories if c.get("parentId") == ""]
    children = [c for c in categories if c.get("parentId") != ""]

    cleaned = []
    for c in categories:
        cleaned.append({
            "id": c.get("id"),
            "name": c.get("name"),
            "parentId": c.get("parentId", ""),
            "description": c.get("description", ""),
        })

    cleaned_parents = []
    for p in parents:
        cleaned_parents.append({
            "id": p.get("id"),
            "name": p.get("name"),
            "description": p.get("description", ""),
        })

    return {"categories": cleaned, "parentCategories": cleaned_parents}


def create_coach(name: str, sec_uid: str = "") -> str | None:
    """自动创建 pending 教练，返回 coach_id"""
    try:
        from pypinyin import lazy_pinyin
        coach_id = "".join(lazy_pinyin(name))
    except Exception:
        coach_id = name.replace(" ", "")

    douyin_url = f"https://www.douyin.com/user/{sec_uid}" if sec_uid else ""
    external_links = [{"platform": "douyin", "url": douyin_url, "label": "抖音"}] if douyin_url else []

    payload = {
        "action": "addCoach",
        "adminKey": ADMIN_KEY,
        "id": coach_id,
        "name": name,
        "tier": "pending",
        "douyinId": "",
        "externalLinks": external_links,
    }
    try:
        result = _curl_post(payload)
        if result.get("success"):
            actual_id = result.get("coach", {}).get("id", coach_id)
            print(f"  ✅ 教练已创建: {name} (id={actual_id}, tier=pending)")
            return actual_id
        print(f"  ❌ 创建教练失败: {result.get('error')}")
    except Exception as e:
        print(f"  ❌ 创建教练异常: {e}")
    return None


def create_category(name: str, parent_id: str, description: str = "") -> str | None:
    """创建二级分类，返回 category_id"""
    try:
        from pypinyin import lazy_pinyin
        cat_id = "".join(lazy_pinyin(name))
    except Exception:
        cat_id = name

    payload = {
        "action": "addCategory",
        "adminKey": ADMIN_KEY,
        "id": cat_id,
        "name": name,
        "parentId": parent_id,
        "description": description,
    }
    try:
        result = _curl_post(payload)
        if result.get("success"):
            new_id = result.get("categoryId", cat_id)
            print(f"  ✅ 分类已创建: {name} (id={new_id}, parent={parent_id})")
            return new_id
        print(f"  ❌ 创建分类失败: {result.get('error')}")
    except Exception as e:
        print(f"  ❌ 创建分类异常: {e}")
    return None
