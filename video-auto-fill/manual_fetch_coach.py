#!/usr/bin/env python3
"""
Run one full auto-fill task for a specific coach.

This is used by the admin backend's "抓取1条" button. It intentionally uses the
same modules as the daemon path: fetch coaches/categories, select one new video
from the target coach, download, upload to VOD, classify, tag, and publish.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from steps.fetch_whitelist import fetch_categories, fetch_coaches
from steps.select_videos import get_sec_uid, get_user_videos, _aweme_to_video_info
from utils.dedup import is_duplicate
from run import process_one


def _public_result(success: bool, **kwargs) -> dict:
    payload = {"success": success, **kwargs}
    print("MANUAL_FETCH_RESULT=" + json.dumps(payload, ensure_ascii=False))
    return payload


def run_for_coach(coach_id: str) -> dict:
    coaches = fetch_coaches()
    coach = next((c for c in coaches if c.get("id") == coach_id), None)
    if not coach:
        return _public_result(False, error=f"未找到教练: {coach_id}")
    if coach.get("autoFillEnabled") is False:
        return _public_result(False, error=f"教练已关闭自动抓取: {coach.get('name')}")
    if not coach.get("douyinUrl"):
        return _public_result(False, error=f"教练缺少抖音主页链接: {coach.get('name')}")

    print(f"TARGET id={coach['id']} name={coach['name']}")
    sec_uid = get_sec_uid(coach["douyinUrl"])
    if not sec_uid:
        return _public_result(False, error="无法解析教练抖音 sec_uid")

    videos, next_cursor, has_more = get_user_videos(sec_uid, count=10, max_cursor=0)
    print(f"VIDEOS count={len(videos)} next_cursor={next_cursor} has_more={has_more}")

    selected = None
    for v in videos:
        info = _aweme_to_video_info(v)
        if not info:
            continue
        dup, _, _ = is_duplicate(info["aweme_id"])
        print(f"CANDIDATE aweme={info['aweme_id']} dup={dup} download={bool(info.get('download_url'))} title={info['title'][:50]}")
        if not dup and info.get("download_url"):
            selected = info
            break

    if not selected:
        return _public_result(False, error="没有找到可抓取的新视频")

    categories_data = fetch_categories()
    ok = process_one(selected, coach, categories_data, added_by="script-后台手动")
    if not ok:
        return _public_result(False, error="视频处理失败", awemeId=selected["aweme_id"], coachId=coach["id"])

    return _public_result(
        True,
        video={
            "awemeId": selected["aweme_id"],
            "title": selected["title"],
            "coachId": coach["id"],
            "coachName": coach["name"],
        },
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--coach-id", required=True)
    args = parser.parse_args()
    result = run_for_coach(args.coach_id)
    raise SystemExit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
