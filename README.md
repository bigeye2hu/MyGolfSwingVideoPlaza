# MyGolfSwingVideoPlaza

挥呗高尔夫视频广场后台项目，从云服务器 `47.117.120.63` 反向同步回本地。

## 项目结构

- `admin-server/`: 当前服务器 `http://47.117.120.63:9527/index.html` 使用的静态管理后台与 Python 静态服务。
- `video-auto-fill/`: 抖音/TikHub 自动抓取、下载、腾讯云 VOD 上传、LLM 分类、发布到视频广场的脚本。
- `cloud-functions/videoPlaza/`: CloudBase `videoPlaza` 云函数源码，包含 App 接口、后台管理接口、VOD 查询、费用监控和教练来源解析。
- `legacy/admin-panel/`: 服务器 `/opt/admin-panel` 中保留的旧版管理页备份。

## 服务器对应路径

- 管理后台: `/opt/admin-server`
- 自动抓取脚本: `/opt/video-auto-fill`
- 云函数: CloudBase `videoPlaza`
- 旧版管理页: `/opt/admin-panel`
- 管理后台端口: `9527`
- Daemon API 端口: `9090`

## 本地运行管理后台

```bash
cd /Users/huxiaoran/Documents/xiaoranProjects/MyGolfSwingVideoPlaza/admin-server
python3 server.py
```

然后打开:

```text
http://localhost:9527/index.html
```

## 本地运行自动抓取脚本

```bash
cd /Users/huxiaoran/Documents/xiaoranProjects/MyGolfSwingVideoPlaza/video-auto-fill
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 按需 export .env 中的密钥，例如:
# set -a && source .env && set +a
python run.py --daemon
```

## CloudBase 云函数

`cloud-functions/videoPlaza/` 从 iOS 仓库 `CloudFunctions/videoPlaza` 迁入，后续由本仓库统一管理。部署前需要在 CloudBase 云函数环境变量中配置：

- `VOD_SECRET_ID` / `VOD_SECRET_KEY` / `VOD_REGION`: VOD 上传、查询、用量统计。
- `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`: 费用中心只读；未配置时会回退使用 VOD 密钥。
- `TIKHUB_TOKEN` / `TIKHUB_BASE`: 后台“从链接解析教练”。
- `MAIL_USER` / `MAIL_PASS`: 邮件提醒。

建议使用最小权限 CAM 子账号：Billing 只读、VOD 只读，以及现有上传所需权限。

## 第一阶段能力

- 后台新增“费用监控”页，调用 CloudBase `getBillingDashboard`，展示账户余额、本月总花费、VOD 花费、VOD 存储/CDN 用量，并在无密钥、无权限、账单未就绪或接口异常时显示 warning。
- 添加教练弹窗新增“从抖音链接解析”，调用 CloudBase `resolveCoachSource`，解析昵称、头像、主页链接、`secUid`、候选 `coachId`，只填表不自动保存。

## 备注

- 这次同步保留了服务器当前源码状态，排除了 `venv/`、`__pycache__/`、下载视频和运行日志。
- `video-auto-fill/config.py` 已改为从环境变量读取敏感值，真实密钥不要提交 GitHub。
- 服务器当前 `admin-server/index.html` 和 iOS 仓库里的 `scripts/admin-server/index.html` 存在一个小差异：本项目保留的是服务器当前版本。
