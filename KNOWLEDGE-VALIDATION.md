# 本地知识库联调记录

日期：2026-10-14。范围：本地代码、开发云资源、非敏感样本。**本地实现已落地；完整云端语音验收仍有未通过项，不能标为全部完成。**

## 运行状态

- 工作台：`http://localhost:3000`。
- Blob：本机 Azurite，`127.0.0.1:10000`，数据持久保存在 `.knowledge-tmp/azurite`。
- worker：独立 Node 进程；格式校验使用本项目 `.venv/bin/python`，Office 转換使用本机 LibreOffice。
- OCR、Embedding、Foundry IQ：真实 Azure 开发服务。
- 本地委派：`gpt-live-dev-sol` → `gpt-6.1-sol` / `2026-09-29` / GlobalStandard。
- 线上只读核验：`gpt-live-studio--0000002`，`RESPONSES_DEPLOYMENT=gpt-6-luna`。本轮未部署生产、未修改线上 Container App 配置或镜像。

## 已创建的开发资源

| 资源 | 名称 | 区域 / 用途 |
|---|---|---|
| 开发资源组 | `rg-gpt-live-rag-dev` | Southeast Asia / Singapore |
| Storage | `glragdev678b10` | Singapore；已创建，本机真实 Blob 访问未通过 |
| Azure AI Search | `gptlive-rag-dev-678b10` | Singapore；Basic，专属 IQ index/source/base |
| Document Intelligence | `gptlive-ocr-dev-678b10` | Singapore；Layout，Entra 认证 |
| Embedding 部署 | `foundry-asia2026 / gpt-live-dev-embedding` | 现有 Singapore Foundry 内独立开发部署，text-embedding-3-small |
| Sol 部署 | `zhenw-mlzzscyb-eastus2 / gpt-live-dev-sol` | 现有 East US 2 Foundry 内独立开发部署 |

开发 Search 使用系统托管身份调用开发 Embedding 部署。仅针对开发对象增加所需权限，未扩大生产 Container App 权限。临时冒烟 KB/source/index、隔离生命周期测试库在成功结束后清理。交互工作台保留一份非敏感 `sample.md`，大正文临时文档已发起清理。

## 验证结果

| 项目 | 结果 | 证据与范围 |
|---|---|---|
| TypeScript | 通过 | `npm run check` |
| 单元/API测试 | 50 项通过 | `output/knowledge-unit-tests.log`；并发CAS、三份限制、预算、超限、multipart边界、版本、删除、超时、临时文件清理、日志脱敏和来源URL边界 |
| 浏览器测试 | 14通过，1跳过 | 两个知识库UI测试及原场景回归；密码登录专项因当前为local认证跳过 |
| 构建 | 通过 | `output/knowledge-build.log`；仅构建本地文件，未发布 |
| Python依赖 | venv内安装 | `requirements-knowledge.txt` 与 `requirements-knowledge-test.txt`；无新增全局Python包 |
| 格式矩阵 | 15项通过 | `output/knowledge-parser-smoke.json`；TXT、MD、Markdown、DOC、DOCX、PPT、PPTX、PDF、扫描PDF、加密及损坏样本 |
| 中文和表格 | 通过 | 中文实体、预算、借用期限校验；Word单独检查Layout表格标记，见 `output/knowledge-table-smoke.json` |
| 真实OCR | 通过 | 中文双页PDF与Office转换PDF；另有纯图片英文扫描PDF，无真实用户敏感文档 |
| 持久生命周期 | 11项通过 | `output/knowledge-lifecycle-smoke.json`；真实IQ + Azurite，详情如下 |
| 真实IQ检索 | 通过 | 正式API `2026-04-01`，真实Knowledge Source、Knowledge Base、Embedding与retrieve；文档版本元数据已验证 |
| IQ托管语音问答 | 有成功验证 | `output/knowledge-live-iq.json`：预算7300元、借用14天、真实[S1]引用、音频输出、session.closed，errors为空 |
| 较大全文 | 独立Responses通过 | `output/knowledge-model-smoke.json`：149,067字节工具结果，模型实际输入29,428 tokens，约23.4秒，正确引用[S1]及[S32]；**不是Live托管链路验收** |
| WebRTC媒体与关闭 | 通过 | `output/browser-smoke-knowledge-webrtc-transport.json`：connected，入站459包/49,433字节，出站596包/35,481字节，最终用量确认 |
| 家居Sol工具 | 已观察到成功 | `output/scene-smoke-home.json`；空调工具成功，该次最终用量事件未确认 |
| 会议/网页搜索真实回归 | 尚未通过 | 复测出现Azure Responses 408；不以模拟测试代替真实验收 |
| 生产依赖审计 | 0项漏洞 | `output/knowledge-audit-production.json`；Azurite开发依赖仍有6项moderate间接依赖提示，未强制降级到不兼容版本 |

生命周期测试使用随机专属容器与端口3001，覆盖：

1. 八个并发上传最多预留三份。
2. 新浏览器身份可读取共享持久状态。
3. 排队任务进入正文解析完成和真实IQ就绪状态。
4. worker重启后文档ID及状态保留。
5. 删除绑定文档时，真实Live会话收到失效并关闭。
6. 删除立即阻止读取，实际清理后释放名额。
7. 排队文档删除后重启，不会被重新索引。
8. PDF处理阶段删除，不恢复已删除资料。测试以worker的processing状态为准，未单独断言云端OCR已开始执行。
9. 损坏PDF自动重试三次，失败项仍占名额。
10. 手动重试可重新排队。
11. 删除整库清理原文及专属IQ对象，生成新的库版本。

额外修复包括：中文字体显式加载、上传multipart边界、文件音频输入持续静音帧、会话删除时清空缓存和丢弃迟到回答、worker取消检查、全文序列化大小预算，以及旧预设不能切回Luna。

## 两项云端阻塞

**真实Azure Blob网络。** 开发Storage的 `publicNetworkAccess` 持续为 `Disabled`，从本机访问返回403。尝试通过CLI和ARM更新并限定本机出口IP后，响应仍为Disabled；本轮未确认具体平台策略原因。没有绕过网络限制，也没有把Azurite结果写成真实Azure Blob验证成功。后续需要获准且可达的网络路径或由资源管理员明确解决开发访问配置。

**Sol托管委派408。** 同一开发Sol部署有成功的托管工具与IQ问答记录，也有多次Live内调用 `/openai/v1/responses` 返回408。独立Responses小请求和较大全文工具调用成功，证明部署可调用，但不足以证明Live托管链路稳定。降低默认reasoning effort为low后仍有超时；界面明确报错，没有替换模型或切回Luna。

## 尚未完成的验收

- 真实Azure Blob与本地worker的完整持久化链路；当前生命周期测试使用Azurite。
- Sol四场景持续稳定回归，尤其会议、托管网页搜索与Live全文多次成功复测。
- WebRTC知识库托管问答的完整成功闭环；媒体/侧带/关闭已通过，委派轮次曾遇408。
- 连续追问、真实语音插话、听感与长时间音频连续性。自动化使用假设备、合成PCM和测试文本，没有采集真实麦克风。
- 接近128K应用全文上限、1MiB工具结果上限以及1M模型上下文的真实压力测试。已有预算单元测试和149KB独立Responses测试，不把它们等同于上限验收。
- “无答案”“多文档冲突”的完整真实语音评估；已有证据约束与未覆盖内容提示，尚未进行系统评测。
- 真实云端清理故障注入及恢复；清理失败重试状态机有单元覆盖，实际云端清理成功路径已通过。

启动步骤和架构图见 [KNOWLEDGE.md](KNOWLEDGE.md)。生产worker容器化、Singapore Container Apps Job、生产配置切换和正式发布均留待后续。

## 2026-10-14 默认设置与音色优化

- 最终音色选项：`marin`（默认）、`quartz`、`vesper`、`willow`、`gleam`、`meridian`。旧预设中的其他音色载入后回退到 marin。
- 四场景默认 Responses 部署改为 `gpt-6-luna`，可选 `gpt-live-dev-sol`；默认 `service_tier=default`、`parallel_tool_calls=true`、`reasoning.effort=low`。创建和更新会话均验证部署白名单。
- 初始场景为知识库问答，使用用户指定的企业实时知识库语音助手提示词；其他场景保留专属指令。
- `npm run check`、`npm run build` 通过；51 项单元/API测试通过，15 项浏览器测试通过，1 项密码登录测试因本地认证模式跳过。浏览器实际页面核对了六项音色、marin、Luna、default tier、并行开关及完整提示词。
- 对官方文档 31 项音色执行真实 Azure Session 启动/关闭测试，22 项成功，9 项返回 Invalid voice；最终保留的六项全部在成功列表中。记录在 `output/voice-smoke-catalog.json` 和 `output/voice-smoke.json`。这验证了会话接受情况，未进行逐音色听感评估。
- `npm run test:scene:live -- home` 使用真实 Luna 托管委派，工具成功设置模拟空调，收到语音输出和最终用量（4.2 秒），errors 为空。未把这次冒烟等同于全部知识库语音场景验收。
- 本地服务器地址 `http://localhost:3000`。只更新本地代码和私有开发配置，没有发布或更改生产应用。
