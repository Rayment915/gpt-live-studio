# GPT-Live Studio

面向 Azure Foundry `gpt-live-1` 的全双工语音体验与协议调试工作台。React / TypeScript / Vite 前端，Node.js 可信后端；先本机使用，再迁移到 Azure Container Apps。

## 本机启动

需要 Node.js 22.12+。知识库还需要 Python 3.9+、项目 `.venv` 与 LibreOffice；完整设置及架构见 [知识库本地指南](KNOWLEDGE.md)。生产环境使用独立 Blob 存储和文档处理 Job，见 [生产发布指南](PRODUCTION.md)。

```sh
npm ci
cp .env.example .env
```

在 `.env` 中填写自己的 `AZURE_OPENAI_ENDPOINT` 和 `AZURE_OPENAI_API_KEY`。如果项目已经配置了私有 `.env`，不要覆盖它。公网部署使用 `AUTH_MODE=password`，并通过 Key Vault 注入 `STUDIO_ADMIN_PASSWORD_HASH`（格式：`scrypt:<32 位十六进制盐>:<128 位十六进制摘要>`）。不要在源码、示例文件或 GitHub 中写入明文密码或哈希值。

```sh
npm run dev
```

打开 **http://localhost:3000**。默认只监听本机；部署名称与会话默认值如下：

| 配置 | 默认值 |
| --- | --- |
| Endpoint | 从私有 `.env` 的 `AZURE_OPENAI_ENDPOINT` 读取 |
| 语音部署 | `gpt-live-1` |
| 场景委派部署 | 默认 `gpt-6-luna`，可选 `gpt-live-dev-sol`（GPT-6.1-Sol） |
| 默认场景 | 知识库问答 |
| 音色 | `marin`（默认）、`quartz`、`vesper`、`willow`、`gleam`、`meridian` |
| Responses 参数 | `service_tier=default`、`parallel_tool_calls=true`、`reasoning.effort=low` |
| 传输 | WebRTC |
| 单次最长会话 | 30 分钟 |
| 全站并发上限 | 4 个会话 |

密钥从不返回浏览器。`.env` 被 Git 和 Docker 排除；请轮换曾贴在聊天中的密钥。不要向 Session JSON、事件内容、预设或工具结果粘贴凭据。

## 如何体验

1. 选择“智能家居”“会议副驾”“边聊边搜”或“知识库问答”，按需调整初始指令与声音。会话开始后不能切换场景。
2. 点击“开始体验”，授权麦克风。建议戴耳机；双方可以同时说话。
3. 输入静音会向服务发送命令；扬声器静音只影响本机播放，**不会停止会话计费或取消委派任务**。
4. “补充上下文”提供背景，“追加指令”提供可信指令，“请模型说出”提供可朗读内容。它们不是普通聊天消息接口，且单条受服务的 500-token 限制。
5. 点击“结束会话”，等待最终 `session.closed` 和累计用量。若网络异常导致没有最终事件，界面明确标为未确认。

### WebSocket 与音频文件

WebSocket 模式由后端转发音频。选择“仅上传文件”可不申请麦克风权限；也可在麦克风会话中临时上传文件，上传期间暂停麦克风 PCM 发送。

文件限 20 MB、120 秒；浏览器可解码的音频会先转换为 24 kHz 单声道 PCM16，再按实时速度发送。不是直接上传 WAV 文件头。音频只在内存中处理，没有自动录音或磁盘历史。

### 四个委派场景

- **智能家居**：查看模拟的客厅灯、空调和净化器；后端验证参数后自动执行模拟变更，**不会控制真实家电**。参数错误会反馈委派模型修正。
- **会议副驾**：查询模拟日程、自动保存模拟会议摘要、决定和待办；仅保留在当前会话内，不发邮件或创建会议。
- **边聊边搜**：在 Azure 的 Sol 委派中使用托管 `web_search`；搜索可能产生额外费用，面板只展示服务实际返回的来源。
- **知识库问答**：上传最多三份文档，每份不超过 20 MiB；选择自动、全文或 Foundry IQ。可查看处理状态、重试、读取原文和删除。新增文档在下一次会话使用，删除立即使相关会话失效。

四个场景默认使用 `gpt-live-1` 实时语音与 `gpt-6-luna` Responses 委派。`RESPONSES_DEPLOYMENT` 配置默认部署，`RESPONSES_DEPLOYMENTS` 配置可选部署白名单（逗号分隔；使用 Azure 实际部署名）。前端可选 Luna 或 Sol，切换场景保留所选模型；服务端在创建会话和更新参数时验证白名单。旧预设中的可用模型保留，不可用模型迁移到默认部署；缺失的 service tier 和并行参数补充默认值，显式关闭并行的预设仍保留。模型调用失败时不自动切换模型。

页面默认进入知识库问答，使用企业实时知识库语音助手提示词；其他场景保留专属指令。音色选项按用户要求保留 `marin`（默认）、`quartz`、`vesper`、`willow`、`gleam`、`meridian`，这六项均已通过 Azure 启动测试。载入旧预设时，列表外的音色回退到 `marin`；切换音色需重新开始会话。使用 `node --import tsx scripts/voice-smoke.ts` 验证可选列表，追加 `--catalog` 检查完整文档列表；会产生短时会话费用，不采集麦克风，也不验证实际听感。

### 参数、事件与导出

点击会话设置右上角 `{}` 打开 JSON 编辑器，和表单双向同步。启动字段修改只影响下次会话；仅 Responses 委派设置允许通过专门按钮更新。

事件控制台支持模板、原始 JSON、过滤、未知事件查看和显式实验性发送。实验模式不绕过权限、密钥保护、场景工具限制或传输限制。

仅保留最近 800 个调试事件、3000 个原始转写片段；转写视图将同一说话者的片段实时合并为句子，展示最近 200 条。导出会话仍包含原始片段，不含原始音频或密钥。刷新页面会清除记录。预设仅在点击“保存预设”后写入本机浏览器，其中包括你明确保存的初始指令。

## 验证

```sh
npm run check
npm test
npm run build
```

浏览器测试默认使用 Playwright Chromium；本机已有 Chrome 时可指定它：

```sh
npx playwright install chromium
npm run test:e2e
# 或使用现有 Chrome
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
```

测试目录中的浏览器测试使用合成事件和合成音频，不调用真实模型。下列命令**会创建付费 Azure 语音会话**，仅在需要时运行：

```sh
npm run test:live
npm run test:scene:live
npx tsx scripts/browser-smoke.ts
```

`test:scene:live` 默认验证 Luna + 托管搜索；追加 `-- home` 或 `-- meeting` 验证对应工具。浏览器 smoke 要求本机 Studio 已启动（可设置 `STUDIO_URL`），使用隔离无头 Chrome 与模拟麦克风，不采集真实麦克风。报告写入 `output/`，不等同于人工听感或真实多人插话验收。知识库验证命令见 [本地指南](KNOWLEDGE.md)。

## 项目结构

| 目录 | 职责 |
| --- | --- |
| `src/` | 录音控制台、配置、委派任务、事件控制台、双传输客户端 |
| `src/audio/`、`public/pcm-worklet.js` | AudioWorklet 采集、PCM 编解码、上传、服务时间轴播放 |
| `shared/` | 会话验证、事件限制、默认配置、日志脱敏 |
| `server/` | 凭据与 Origin/CSRF 边界、拥有者会话、WebRTC 信令、WS/sideband、工具审批 |
| `tests/` | 协议、音频、任务状态、安全和浏览器回归 |
| `infra/` | Container Apps + 应用密码认证的 Bicep 模板 |

## 生产构建与云迁移

```sh
npm run build
npm start
```

本机生产构建仍从 `.env` 读取后端密钥。容器通过 HTTPS 的应用内登录保护工作台、API 与 WebSocket，不开放匿名云端体验；登录令牌仅由服务器内存维护，重启后须重新登录。云端部署时须通过私有配置提供环境、镜像仓库、身份和密钥引用，不能提交这些值。

仓库仅包含通用部署模板和占位符，不包含任何账户的资源 ID、真实 endpoint 或凭据。部署时需在本地提供已忽略的私有参数文件，并确认托管区域、访问人员、预算、容器环境和镜像拉取权限。
