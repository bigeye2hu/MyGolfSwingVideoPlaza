"""
Step 5: LLM 自动分类 + 标签生成
两阶段分类：先匹配一级分类，再匹配/创建二级分类。
"""
from utils.llm import call_llm
from steps.fetch_whitelist import create_category

PENDING_SUBCATEGORY = "pending_subcategory"


def _build_parent_prompt(title: str, description: str, categories_data: dict) -> str:
    parents = categories_data.get("parentCategories", [])
    lines = [f"- {p['name']} (id: {p['id']})\n  描述: {p.get('description') or '无'}" for p in parents]
    return f"""视频标题: {title}
视频描述: {description}

现有一级分类：
{chr(10).join(lines)}

请根据视频内容，选择最匹配的一级分类ID（只返回ID，不要其他文字）。
如果没有任何分类匹配，返回 "none"。"""


def _build_child_prompt(title: str, description: str, parent_id: str, categories_data: dict) -> str:
    children = [c for c in categories_data.get("categories", []) if c.get("parentId") == parent_id]
    if not children:
        child_str = "（该父分类下暂无二级分类）"
    else:
        lines = [f"  - {c['name']} (id: {c['id']})\n    描述: {c.get('description') or '无'}" for c in children]
        child_str = "\n".join(lines)

    parent_desc = ""
    for p in categories_data.get("parentCategories", []):
        if p["id"] == parent_id:
            parent_desc = p.get("description", "")
            break

    return f"""视频标题: {title}
视频描述: {description}

所属父分类: {parent_id}，描述: {parent_desc}

现有二级分类：
{child_str}

请根据视频内容，从现有二级分类中选择最匹配的一个ID。
如果现有二级分类都不匹配，请返回 "create_new:新分类名称|新分类描述"（格式：用|分隔名称和描述，描述不超过20字）。
例如: create_new:手腕释放|下杆时手腕释放的时机与技巧

命名规范：
- 名称：2-6个汉字，简洁描述技术动作或问题
- 描述：不超过20字
- 不要用"其他""技巧""教学"等泛词
- 不要与现有二级分类同名"""


def match_category(title: str, description: str, categories_data: dict) -> tuple[str, str | None]:
    """
    两阶段分类匹配。
    返回 (category_id, notification_message)
    """
    # ── 阶段1：一级分类 ──
    swing_keywords = ("挥杆分析", "挥杆")
    player_keywords = ("球员", "选手", "球手")
    combined = (title + description).lower()
    is_swing = any(k in combined for k in swing_keywords) and "分析" in combined
    is_player = any(k in combined for k in player_keywords) and "分析" in combined

    if is_swing or is_player:
        parent_result = call_llm(_build_parent_prompt(title, description, categories_data))
        print(f"    LLM一级分类: {parent_result}")
    else:
        parent_result = "common_issues"
        print(f"    默认一级分类: common_issues")

    if not parent_result or parent_result.lower() == "none":
        print(f"    ⚠️ 一级分类未匹配，放入待分类")
        return PENDING_SUBCATEGORY, "一级分类未匹配，已放入「待分类」"

    # 验证 parent_id
    parent_ids = [p["id"] for p in categories_data.get("parentCategories", [])]
    parent_id = None
    if parent_result in parent_ids:
        parent_id = parent_result
    else:
        for p in categories_data.get("parentCategories", []):
            if p["name"] in parent_result or parent_result in p["name"]:
                parent_id = p["id"]
                break

    if not parent_id:
        print(f"    ⚠️ 一级分类ID无效: {parent_result}")
        return PENDING_SUBCATEGORY, "一级分类未匹配，已放入「待分类」"

    parent_name = next((p["name"] for p in categories_data["parentCategories"] if p["id"] == parent_id), parent_id)
    print(f"    ✅ 一级分类: {parent_name} ({parent_id})")

    # ── 阶段2：二级分类 ──
    child_result = call_llm(_build_child_prompt(title, description, parent_id, categories_data))
    if not child_result:
        print(f"    ⚠️ 二级分类匹配失败，放入待分类")
        return PENDING_SUBCATEGORY, "二级分类未匹配，已放入「待分类」"

    # 自动创建新分类
    if child_result.lower().startswith("create_new:"):
        parts = child_result.split(":", 1)[1].strip()
        if "|" in parts:
            new_name, new_desc = [p.strip() for p in parts.split("|", 1)]
        else:
            new_name, new_desc = parts, ""

        print(f"    🤖 LLM建议创建: {new_name}（{new_desc}）")
        new_id = create_category(new_name, parent_id, new_desc)
        if new_id:
            return new_id, f"已创建新分类: {new_name} (属于: {parent_name})"
        return PENDING_SUBCATEGORY, "创建分类失败，已放入「待分类」"

    # 精确匹配
    child_ids = [c["id"] for c in categories_data.get("categories", []) if c.get("parentId") == parent_id]
    if child_result in child_ids:
        cat_name = next((c["name"] for c in categories_data["categories"] if c["id"] == child_result), child_result)
        print(f"    ✅ 二级分类: {cat_name} ({child_result})")
        return child_result, None

    # 模糊匹配
    for cat in categories_data.get("categories", []):
        if cat.get("parentId") == parent_id and (cat["name"] in child_result or child_result in cat["name"]):
            print(f"    ✅ 二级分类(模糊): {cat['name']} ({cat['id']})")
            return cat["id"], None

    print(f"    ⚠️ 二级分类ID无效: {child_result}")
    return PENDING_SUBCATEGORY, "二级分类未匹配，已放入「待分类」"


def generate_tags(title: str, description: str = "") -> list[str]:
    """LLM 生成 0~3 个标签"""
    prompt = f"""视频标题: {title}
视频描述: {description}

请根据视频内容生成0~3个标签。标签应简洁，能概括视频核心内容。
例如：技巧讲解、实战演示、错误纠正、装备推荐

要求：
1. 最多3个标签，每个不超过4个字
2. 如果没有明显特征可打标签，返回 "none"
3. 只返回标签，不要其他文字
4. 多个标签用逗号分隔"""

    result = call_llm(prompt)
    if not result or result.lower() == "none":
        return []

    tags = [t.strip() for t in result.split(",") if t.strip()]
    meta_tags = {"搬运", "转载", "来源", "抖音", "tiktok", "youtube"}
    tags = [t for t in tags if t.lower() not in meta_tags]
    return tags[:3]
