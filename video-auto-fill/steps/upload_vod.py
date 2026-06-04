"""
Step 4: 上传视频到腾讯云 VOD + 首帧封面
"""
import json
import time
from pathlib import Path

from config import VOD_SECRET_ID, VOD_SECRET_KEY, VOD_REGION


def upload_to_vod(file_path: str, max_retries: int = 3) -> tuple[str | None, str | None, str | None]:
    """
    上传 mp4 到腾讯云 VOD。
    返回 (vod_url, file_id, cover_url)，失败返回 (None, None, None)。
    """
    from tencentcloud.common import credential
    from tencentcloud.common.profile.client_profile import ClientProfile
    from tencentcloud.common.profile.http_profile import HttpProfile
    from tencentcloud.vod.v20180717 import vod_client, models
    from qcloud_cos import CosConfig, CosS3Client

    fp = Path(file_path)

    cred = credential.Credential(VOD_SECRET_ID, VOD_SECRET_KEY)
    http_prof = HttpProfile(endpoint="vod.tencentcloudapi.com")
    client_prof = ClientProfile(httpProfile=http_prof)
    client = vod_client.VodClient(cred, VOD_REGION, client_prof)

    delay = 5
    for attempt in range(1, max_retries + 1):
        try:
            print(f"  ☁️ VOD上传 (第{attempt}次)...")

            # 1. ApplyUpload
            apply_req = models.ApplyUploadRequest()
            apply_req.MediaType = "mp4"
            apply_req.MediaName = fp.name
            apply_resp = client.ApplyUpload(apply_req)
            apply_data = json.loads(apply_resp.to_json_string())

            bucket = apply_data["StorageBucket"]
            storage_region = apply_data["StorageRegion"]
            storage_path = apply_data["MediaStoragePath"]
            temp_cert = apply_data["TempCertificate"]
            session_key = apply_data.get("VodSessionKey", "")

            # 2. COS upload
            cos_cfg = CosConfig(
                Region=storage_region,
                SecretId=temp_cert["SecretId"],
                SecretKey=temp_cert["SecretKey"],
                Token=temp_cert["Token"],
                Timeout=600,
            )
            cos_client = CosS3Client(cos_cfg)
            file_size_mb = fp.stat().st_size / (1024 * 1024)
            print(f"    📦 文件大小: {file_size_mb:.1f}MB")
            with open(fp, "rb") as f:
                cos_client.put_object(Bucket=bucket, Body=f.read(), Key=storage_path, EnableMD5=True)

            # 3. CommitUpload
            commit_req = models.CommitUploadRequest()
            commit_req.VodSessionKey = session_key
            commit_resp = client.CommitUpload(commit_req)
            commit_data = json.loads(commit_resp.to_json_string())
            file_id = commit_data.get("FileId", "")
            if not file_id:
                raise RuntimeError("CommitUpload 返回空 FileId")

            # 4. 触发首帧封面
            try:
                cover_task = models.CoverBySnapshotTaskInput()
                cover_task.Definition = 10
                cover_task.PositionType = "Percent"
                cover_task.PositionValue = 0
                media_task = models.MediaProcessTaskInput()
                media_task.CoverBySnapshotTaskSet = [cover_task]
                proc_req = models.ProcessMediaRequest()
                proc_req.FileId = file_id
                proc_req.MediaProcessTask = media_task
                client.ProcessMedia(proc_req)
            except Exception as e:
                print(f"    ⚠️ 封面任务提交失败（不影响上传）: {e}")

            # 5. 轮询获取播放地址和封面
            vod_url = ""
            cover_url = ""
            for _ in range(6):
                time.sleep(5)
                desc_req = models.DescribeMediaInfosRequest()
                desc_req.FileIds = [file_id]
                desc_resp = client.DescribeMediaInfos(desc_req)
                desc_data = json.loads(desc_resp.to_json_string())
                mi_set = desc_data.get("MediaInfoSet", [])
                if mi_set:
                    basic = mi_set[0].get("BasicInfo", {})
                    vod_url = basic.get("MediaUrl", "")
                    cover_url = basic.get("CoverUrl", "")
                    if vod_url:
                        break

            print(f"  ✅ VOD上传成功: file_id={file_id}")
            return vod_url, file_id, cover_url

        except Exception as e:
            print(f"  ⚠️ 第{attempt}次上传失败: {e}")
            if attempt < max_retries:
                wait = delay * (2 ** (attempt - 1))
                print(f"  ⏳ {wait}秒后重试...")
                time.sleep(wait)

    print(f"  ❌ VOD上传失败（重试{max_retries}次）")
    return None, None, None


def get_vod_cover(file_id: str) -> str:
    """查询 VOD 封面（补封面用）"""
    try:
        from tencentcloud.common import credential
        from tencentcloud.common.profile.client_profile import ClientProfile
        from tencentcloud.common.profile.http_profile import HttpProfile
        from tencentcloud.vod.v20180717 import vod_client, models

        cred = credential.Credential(VOD_SECRET_ID, VOD_SECRET_KEY)
        http_prof = HttpProfile(endpoint="vod.tencentcloudapi.com")
        client_prof = ClientProfile(httpProfile=http_prof)
        client = vod_client.VodClient(cred, VOD_REGION, client_prof)

        req = models.DescribeMediaInfosRequest()
        req.FileIds = [file_id]
        resp = client.DescribeMediaInfos(req)
        data = json.loads(resp.to_json_string())
        mi_set = data.get("MediaInfoSet", [])
        if mi_set:
            return mi_set[0].get("BasicInfo", {}).get("CoverUrl", "")
    except Exception as e:
        print(f"  ⚠️ 获取VOD封面失败: {e}")
    return ""
