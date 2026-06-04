"""
Step 3: 下载视频文件到本地
"""
import time

import requests

from config import DOWNLOAD_MAX_SECONDS, DOWNLOAD_READ_TIMEOUT_SECONDS, VIDEOS_DIR


_session = requests.Session()
_session.proxies = {"http": None, "https": None}


def download_video(video_info: dict, max_retries: int = 3) -> str | None:
    """
    下载视频到 data/videos/{aweme_id}/{aweme_id}.mp4
    返回本地文件路径，失败返回 None。
    """
    aweme_id = video_info["aweme_id"]
    url = video_info.get("download_url")
    if not url:
        print(f"  ❌ 没有下载链接")
        return None

    save_dir = VIDEOS_DIR / aweme_id
    save_dir.mkdir(parents=True, exist_ok=True)
    save_path = save_dir / f"{aweme_id}.mp4"

    if save_path.exists() and save_path.stat().st_size > 10000:
        print(f"  ⏭️ 文件已存在: {save_path.name}")
        return str(save_path)

    delay = 5
    for attempt in range(1, max_retries + 1):
        try:
            print(f"  ⬇️ 下载中 (第{attempt}次)...")
            started_at = time.monotonic()
            resp = _session.get(url, stream=True, timeout=(15, DOWNLOAD_READ_TIMEOUT_SECONDS))
            resp.raise_for_status()
            downloaded = 0
            with open(save_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    if time.monotonic() - started_at > DOWNLOAD_MAX_SECONDS:
                        raise TimeoutError(f"下载超过{DOWNLOAD_MAX_SECONDS}秒，跳过该视频")
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
            if downloaded < 10000:
                raise RuntimeError(f"文件过小({downloaded}字节)，可能下载不完整")

            size_mb = save_path.stat().st_size / 1024 / 1024
            print(f"  ✅ 下载完成: {save_path.name} ({size_mb:.1f}MB)")
            return str(save_path)
        except Exception as e:
            print(f"  ⚠️ 第{attempt}次下载失败: {e}")
            if save_path.exists():
                try:
                    save_path.unlink()
                except OSError:
                    pass
            if attempt < max_retries:
                wait = delay * (2 ** (attempt - 1))
                print(f"  ⏳ {wait}秒后重试...")
                time.sleep(wait)

    print(f"  ❌ 下载失败（重试{max_retries}次）")
    return None
