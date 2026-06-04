# 视频广场自动填充脚本

## 运行

- 单次：`python run.py` / `python run.py --count 3`
- 常驻：`python run.py --daemon`（默认 HTTP 控制 `0.0.0.0:9090`）

## 配置来源

- **发布间隔（小时）**、**每轮条数** 由云数据库 `plaza_auto_fill` 文档 `config` 控制，管理后台「自动化」页可改；Daemon 每轮开始会从云端拉取。
- 云端不可用时使用 `config.py` 中的兜底值。
- **教练级**：在后台教练编辑里勾选「参与自动抓取」；关闭后不会删教练，仅从轮询中排除。

## 热加载

保存策略后点击「保存并应用到 Daemon」，会向 `http://<你的Daemon地址>:9090/api/daemon/reload-config` 发 POST，跳过当前等待并刷新内存中的间隔与条数。

## 部署到云服务器

仓库改动**不会自动**上到云机：需把本目录同步到服务器，**不要同步 `venv/`**（在服务器单独建虚拟环境）。

**完整步骤、rsync 命令、重启 Daemon、管理后台 Daemon API 地址填什么**，见项目文档：

[**docs/VIDEO_AUTO_FILL_CLOUD_DEPLOY.md**](../../docs/VIDEO_AUTO_FILL_CLOUD_DEPLOY.md)

请在文档顶部 **「环境与约定」** 表中填写 `SSH_TARGET`、`REMOTE_DIR`、`DAEMON_PUBLIC_BASE` 等，便于以后协作时直接查阅。
