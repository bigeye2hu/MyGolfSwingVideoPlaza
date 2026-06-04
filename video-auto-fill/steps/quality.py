"""
Step 2.5: 视频质量筛选
在下载和上传 VOD 前判断是否值得发布，避免低质内容进入存储。
"""
import json
import re
import subprocess
from datetime import datetime

from config import CLOUDBASE_API, ADMIN_KEY
from utils.llm import call_llm

QUALITY_SCORE_THRESHOLDS = {"hiddenMax": 39, "premiumMin": 75}


def _json_from_text(text: str) -> dict | None:
    if not text:
        return None
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?", "", cleaned, flags=re.I).strip()
    cleaned = re.sub(r"```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        m = re.search(r"\{.*\}", cleaned, flags=re.S)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except Exception:
            return None


def _normalize_status(value: str) -> str:
    return value if value in {"premium", "standard", "hidden"} else "standard"


def _normalize_score(value, fallback_status: str = "standard") -> int:
    try:
        return max(0, min(100, round(float(value))))
    except Exception:
        status = _normalize_status(fallback_status)
        if status == "premium":
            return 82
        if status == "hidden":
            return 25
        return 58


def _status_from_score(score, fallback_status: str = "standard") -> str:
    normalized = _normalize_score(score, fallback_status)
    if normalized <= QUALITY_SCORE_THRESHOLDS["hiddenMax"]:
        return "hidden"
    if normalized >= QUALITY_SCORE_THRESHOLDS["premiumMin"]:
        return "premium"
    return "standard"


def _heuristic_review(video_info: dict) -> dict:
    title = f"{video_info.get('title', '')} {video_info.get('description', '')}"
    bad = bool(re.search(r"直播(预告|的视频|答疑|回放)?|烧烤|喝酒|打枪|射击|聚会|娱乐|防晒|面罩|帽子|好物|上新|橱窗|同款|购买|搭配|音乐|弹唱|配色", title))
    teaching = bool(re.search(r"挥杆|上杆|下杆|击球|切杆|推杆|铁杆|木杆|一号木|球位|坡度|重心|旋转|释放|练习|训练|纠正|分析|教学|技巧|方法|错误|问题", title))
    compact = re.sub(r"#[^\s#]+", "", title).strip()
    if bad or (len(compact) < 12 and not teaching):
        quality_score = 20 if bad else 35
        return {
            "qualityStatus": _status_from_score(quality_score, "hidden"),
            "qualityScore": quality_score,
            "thresholds": QUALITY_SCORE_THRESHOLDS,
            "confidence": 0.86 if bad else 0.68,
            "reason": "偏生活、直播、带货或描述不足",
            "suggestedCategoryId": "",
            "suggestedTitle": video_info.get("title", ""),
            "suggestedTags": [],
            "source": "heuristic",
            "reviewedAt": datetime.now().isoformat() + "Z",
        }
    quality_score = 78 if re.search(r"分析|纠正|练习|训练|方法|技巧|问题|错误|处理", title) else 62
    return {
        "qualityStatus": _status_from_score(quality_score, "standard"),
        "qualityScore": quality_score,
        "thresholds": QUALITY_SCORE_THRESHOLDS,
        "confidence": 0.76,
        "reason": "包含高尔夫教学相关信息",
        "suggestedCategoryId": "",
        "suggestedTitle": video_info.get("title", ""),
        "suggestedTags": [],
        "source": "heuristic",
        "reviewedAt": datetime.now().isoformat() + "Z",
    }


def review_video_quality(video_info: dict, coach: dict, categories_data: dict) -> dict:
    """返回结构化质量评估。LLM 失败时保守降级为规则评估。"""
    categories = categories_data.get("categories", [])
    category_lines = "\n".join(
        f"- {c.get('id')}:{c.get('name')}" for c in categories if c.get("parentId")
    )
    prompt = f"""你是高尔夫教学内容审核助手。请按“教学价值优先”评估视频质量。

质量定义：
- 75-100 premium：明确讲技术点、挥杆分析、错误纠正、练球方法、球杆/球位处理，可直接帮助用户练球。
- 40-74 standard：高尔夫相关但教学价值一般，描述可理解，能合理归类。
- 0-39 hidden：生活闲聊、直播预告/直播切片无主题、带货/防晒/配色等非训练内容、标题过短无法判断、分类只能硬凑。

教练：{coach.get('name', '')}
标题：{video_info.get('title', '')}
描述：{video_info.get('description', '')}

可选二级分类：
{category_lines}

只返回 JSON：
{{"qualityScore":0,"qualityStatus":"premium|standard|hidden","confidence":0.0,"reason":"20字内原因","suggestedCategoryId":"分类id或空","suggestedTitle":"建议标题或原标题","suggestedTags":["最多3个标签"]}}"""
    result = call_llm(prompt, temperature=0.1)
    parsed = _json_from_text(result or "")
    if not parsed:
        return _heuristic_review(video_info)
    quality_score = _normalize_score(parsed.get("qualityScore"), parsed.get("qualityStatus", "standard"))
    review = {
        "qualityStatus": _status_from_score(quality_score, parsed.get("qualityStatus", "standard")),
        "qualityScore": quality_score,
        "thresholds": QUALITY_SCORE_THRESHOLDS,
        "confidence": max(0, min(1, float(parsed.get("confidence") or 0))),
        "reason": str(parsed.get("reason") or "")[:80],
        "suggestedCategoryId": str(parsed.get("suggestedCategoryId") or ""),
        "suggestedTitle": str(parsed.get("suggestedTitle") or video_info.get("title", ""))[:140],
        "suggestedTags": [str(t) for t in (parsed.get("suggestedTags") or [])][:3],
        "source": "llm",
        "reviewedAt": datetime.now().isoformat() + "Z",
        "raw": parsed,
    }
    valid_cat_ids = {c.get("id") for c in categories if c.get("parentId")}
    if review["suggestedCategoryId"] and review["suggestedCategoryId"] not in valid_cat_ids:
        review["suggestedCategoryId"] = ""
    if not review["reason"]:
        review["reason"] = _heuristic_review(video_info)["reason"]
    return review


def record_quality_candidate(video_info: dict, coach: dict, quality_review: dict) -> None:
    """把被拦截的视频写到后台候选表，失败不影响主流程。"""
    payload = {
        "action": "addQualityCandidate",
        "adminKey": ADMIN_KEY,
        "awemeId": video_info.get("aweme_id", ""),
        "coachId": coach.get("id", ""),
        "coachName": coach.get("name", ""),
        "title": video_info.get("title", ""),
        "coverURL": video_info.get("cover_url", ""),
        "sourceURL": video_info.get("source_url", ""),
        "qualityReview": quality_review,
        "status": "rejected",
    }
    try:
        cmd = [
            "curl", "-s", "--noproxy", "*",
            "-X", "POST", CLOUDBASE_API,
            "-H", "Content-Type: application/json",
            "-d", json.dumps(payload, ensure_ascii=False),
            "--connect-timeout", "10", "--max-time", "15",
        ]
        subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception as e:
        print(f"  ⚠️ 记录低质候选失败: {e}")
