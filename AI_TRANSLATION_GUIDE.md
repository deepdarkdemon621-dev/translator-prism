# AI 小说翻译接手指南

本文件供 Codex、Claude Code 或其他接手本项目的 AI 使用。目标是继续翻译
现有队列，并让结果出现在已部署的网站和线上 Turso 数据库中。

最后核对日期：2026-07-24。

## 先说结论

- 已部署网站与本地 Worker 连接同一个 Turso 数据库。
- 网站没有单独的“上传译文”接口。Worker 把 `translations` 行写成
  `done` 后，网站下一次读取章节时就能看到译文，不需要重新部署 Vercel。
- AI 应通过现有 `prism-worker` 接手翻译。不要在交互式会话里手写 SQL
  批量覆盖译文。
- 不使用本地 LLM。`TRANSLATION_PROVIDER_CHAIN` 只能包含本次明确批准的
  `codex` 或 `claude-code`，除非用户另有指示。
- 任何启动 Worker 的操作都会写线上数据库。必须先得到用户对运行时间、
  模型、停止条件的明确确认。

## 每次接手的读取顺序

1. `AGENTS.md`
2. `AI_SESSION_ENTRY.md`
3. `AI_HANDOFF_SUMMARY.md`
4. 本文件
5. `AI_TASK_BOARD.md`
6. `worker/README.md`
7. `worker/index.ts`
8. `src/lib/llm/executor.ts`
9. `src/lib/llm/cli-providers.ts`
10. `src/lib/db/schema.ts`

先运行 `git status --short --branch`。当前项目可能有未提交的 Worker/LLM
批处理改动；不得还原、覆盖或混入无关修改。

## 数据流与写入契约

```text
网站/管理操作
  -> translations.status = pending
  -> 唯一的 prism-worker 原子认领为 processing
  -> Codex CLI 或 Claude Code 只生成译文
  -> executor.ts 写入 text/model/provider 并标记 done 或 failed
  -> checkChapterDone() 更新 chapters.status
  -> 已部署网站从 Turso 读取最新结果
```

权威表结构在 `src/lib/db/schema.ts`：

- `paragraphs.source_text`：原文，禁止修改。
- `translations.paragraph_id + lang`：待翻译目标。
- `translations.text`：纯译文。
- `translations.status`：`pending | processing | done | failed`。
- `translations.model`：实际模型标识。
- `translations.last_provider`：`codex` 或 `claude-code`。
- `translations.error_message` / `last_error_code`：失败诊断。
- `chapters.status`：由 `checkChapterDone()` 派生维护。

硬性规则：

- 只认领 `pending`，不要覆盖 `done`。
- 不新增重复的 `(paragraph_id, lang)` 行。当前数据库没有依赖唯一索引来替你
  阻止重复。
- 不修改原文、段落顺序、章节 HTML、书籍归属或阅读进度。
- 不绕过 `executor.ts` 的成功/失败写回和 `checkChapterDone()`。
- 不打印、提交或复制 `.env.worker`、Turso token、API key。
- 同一 Turso 数据库只能运行一个 Worker。Worker 启动时会把全部
  `processing` 重置为 `pending`，多 Worker 会互相抢任务。

## 存储与写入优化（ARCH-002）当前状态

详细设计与实施计划：

- `docs/superpowers/specs/2026-07-24-ai-translation-storage-optimization-design.md`
- `docs/superpowers/plans/2026-07-24-ai-translation-storage-optimization.md`

2026-07-24 由 Claude 完成本地实现（代码已在本 checkout，生产尚未应用）：

- 迁移 `0013_translation_execution.sql`：`translation_runs`、
  `translation_attempts`、`translations.claimed_by/lease_expires_at`，
  以及"每个 translation 至多一个 active attempt"的部分唯一索引。
- 租约认领（`worker/claim.ts`）：Worker 启动不再全表重置 `processing`；
  只有租约过期的行才可被重新认领，写回全部带 `claimed_by` 守卫。
  心跳按 `WORKER_LEASE_HEARTBEAT_MS` 续租。
- 章节感知批次：一次模型调用 = 同书 + 同章 + 同目标语言，按段落顺序，
  受 `WORKER_BATCH_SIZE` 与可选 `WORKER_BATCH_MAX_CHARS` 双重约束；
  CLI 超时 = 基础值 + 每条 `*_BATCH_ITEM_TIMEOUT_MS` 增量。
- Claude 与 Codex 使用同一 JSON 批次契约；`CodexCliProvider.translateBatch()`
  已实现（仍是 `read-only` sandbox、不开 bypass）。
- 逐条校验（`src/lib/llm/translation-validation.ts`）：空文本、源文复读
  （仅当原文含假名才硬拒，纯汉字专名/标点降级为警告）、Markdown 围栏、
  解释前缀、拒答硬拒；长度比、残留假名只警告。坏条目不拖垮整批；
  整批 JSON 解析失败走最多 4 层二分重试。
- 批量持久化（`src/lib/translate/persist-batch.ts`）：一个结果批次一次
  `client.batch(..., "write")`；attempt 与 canonical 更新同事务、同守卫
  （租约所有权 + 原文未变），章节状态按受影响章节集合一次刷新。
- 运行历史：每个 Worker 进程一行 `translation_runs`，attempt 关联 run。
- 工具命令：
  - `npm run translations:audit` — 只读重复审计，输出
    `data/translation-integrity-report.json` 与冲突决策骨架。
  - `npm run translations:dedupe -- --dry-run` / `-- --apply --decisions ...`
    — 受控去重；apply 前拒绝存在 processing/未过期租约，归档后删除，
    结束后重审计。

生产门执行记录（2026-07-24，均已获用户批准）：

1. ✅ 迁移 `0013`：随推送由 Vercel 构建自动应用（`npm run build` 内含
   migration），已只读验证表/列/索引存在。
2. ✅ 生产去重 `--apply`：105 个冲突组由 Claude 逐组评审并写入决策文件后
   执行。归档 9330 行进 `translation_attempts`、删除 9330 行，重审计
   `duplicateGroups=0`。
3. ✅ 迁移 `0014` 唯一索引：`7c588c5` 已推送，随 Vercel 构建应用到生产。
4. ⬜ 真实 Worker canary/长跑：仍需每次向用户确认 provider/model/运行窗口/
   停止条件后才能启动。

开发/测试仍只能使用临时 `file:` 数据库；注意任何推送都会经 Vercel 构建
自动执行未应用的 migration，新迁移必须在推送前充分验证。

## 翻译质量合同

当前线上待翻译内容主要是日文小说，目标语言为中文 `zh` 和英文 `en`。
每条输出必须满足：

- 完整翻译，不删句、不总结、不补写剧情。
- 保持叙事视角、语气、敬语层级、角色口吻和情绪强度。
- 人名、地名、学校名、组织名、称谓和固定术语前后一致。
- 保留引号、换行、括号、强调和句子边界；不要输出 Markdown。
- 输出只能是目标语言译文，不附解释、标签、JSON 围栏或前后缀。
- 不确定专名时优先参考同书最近的已完成译文，不要擅自创造多个译名。
- 中文应自然、克制，避免逐词日式语序；英文应像小说正文，不像词典释义。

现有 Worker 的单条提示只包含一个段落；Claude 批处理也不保证提供完整章节
上下文。因此首次接手一本书时，应抽查最近的 `done` 译文来建立专名和语气
基线。若需要增加章节上下文或术语表，应先提出独立代码改动，不要在一次线上
运行中临时改变数据格式。

## 只读预检

在请求启动许可前完成：

```powershell
git status --short --branch
npx pm2 jlist
node scripts/check-progress.mjs
codex --version
claude --version
```

预期：

- `npx pm2 jlist` 为 `[]`，或明确只有一个属于本项目的 `prism-worker`。
- `.env.worker` 存在 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN`，但不要输出值。
- `scripts/check-progress.mjs` 能读取线上统计。
- 明确记录开始前的 `done/pending/processing/failed` 数量。

如已有 Worker 在线，不要再启动第二个。先检查它的配置、PID、日志和最近写入，
再向用户报告。

## 模型与思考程度

### Codex，首选

截至 2026-07-24，本项目推荐：

- 模型：`gpt-5.6-sol`
- 思考程度：`high`
- 批量稳定、样本验收通过后：可测试 `medium` 以换取速度
- 不建议默认使用 `max`：段落翻译的收益通常不足以抵消延迟和消耗

本机当前 Codex 配置已观察到 `model = "gpt-5.6-sol"` 和
`model_reasoning_effort = "high"`。未来会变化，每次运行前重新核对，不要把
本段当成永久事实。

`CodexCliProvider.translateBatch()` 已实现，一个 Worker 槽位始终只有一个
Codex 进程。首次接手仍建议从小批量开始：

```env
TRANSLATION_PROVIDER_CHAIN=codex
CODEX_CLI_ENABLED=true
CODEX_CLI_MODEL=gpt-5.6-sol
CODEX_CLI_ALLOW_BYPASS=false
WORKER_CLAUDE_WINDOW_ONLY=false
WORKER_CONCURRENCY=1
WORKER_BATCH_SIZE=1
WORKER_BATCH_MAX_CHARS=4000
WORKER_REQUEUE_FAILED_WHEN_IDLE=false
```

canary 样本验收后可逐步提高 `WORKER_BATCH_SIZE`（如 10-20）。

Codex 子进程使用 `read-only` sandbox；数据库写入由父 Worker 完成。不要开启
`CODEX_CLI_ALLOW_BYPASS`。

### Claude，备选

大量段落吞吐可使用 Claude Code。优先选择账号实际可用的当前 Sonnet；
截至 2026-07-24，官方模型建议对应 `claude-sonnet-5`，使用 adaptive/high
档。最高质量抽查可用 Claude Fable 5，但速度和成本更高。

项目现有 CLI 配置使用 `CLAUDE_CODE_MODEL=sonnet`。先做小探针确认该别名在
当前账号解析到可用模型，不要根据文档盲改生产配置。

```env
TRANSLATION_PROVIDER_CHAIN=claude-code
CLAUDE_CODE_ENABLED=true
CLAUDE_CODE_MODEL=sonnet
CLAUDE_CODE_BARE=false
WORKER_CONCURRENCY=1
WORKER_REQUEUE_FAILED_WHEN_IDLE=false
```

只有在当前 checkout 确实包含并通过
`ClaudeCodeCliProvider.translateBatch()` 相关测试时，才把
`WORKER_BATCH_SIZE` 提高到 `20`；否则保持 `1`。

## 启动前必须向用户确认

报告以下信息并等待明确批准：

- 使用 Codex 还是 Claude。
- 模型与思考程度。
- 是否只跑 canary，还是持续运行。
- 停止时间、完成条件或配额边界。
- 是否处理现有 `failed` 行；默认不处理。
- 开始前队列统计和 PM2 状态。

“继续看看”“检查一下”不等于允许启动翻译。

## 执行与监控

先做小规模 canary，人工检查中英文各若干条，再决定长时间运行。前台测试：

```powershell
npm run worker
```

批准长期运行后才使用：

```powershell
npm run worker:pm2
npx pm2 logs prism-worker --lines 50 --nostream
```

修改 `.env.worker` 后必须用：

```powershell
npx pm2 restart prism-worker --update-env
```

运行期间定期检查：

```powershell
node scripts/check-progress.mjs
node scripts/check-recent.mjs
npx pm2 jlist
```

健康信号：

- `done` 持续增加，`pending` 持续减少。
- `processing` 不长期卡住。
- 最近行的 `model` 和 `last_provider` 与批准配置一致。
- `failed` 不快速增长。
- 抽样译文不是空串、原文复读、解释文字或格式污染。

发现模型错误、认证错误、输出解析错误、失败激增或译文质量异常时，立即停止，
不要自动切换到本地 LLM 或另一家模型。

## 停止与收尾

```powershell
npx pm2 delete prism-worker
npx pm2 jlist
node scripts/check-progress.mjs
```

停止后确认：

- PM2 列表中没有 `prism-worker`。
- 没有长期遗留的 `processing`。
- 记录结束时统计、模型、运行时段、失败类型和抽样结果。
- 更新 `AI_TASK_BOARD.md`、`AI_HANDOFF_SUMMARY.md` 和
  `AI_SESSION_ENTRY.md`。

若进程异常退出，确认不存在另一个 Worker 后再启动一次，让单 Worker 的启动
恢复逻辑把遗留 `processing` 安全重置。不要直接执行全表状态更新。

## 线上显示与验收

翻译写入 Turso 后不需要部署。验收顺序：

1. 用只读 SQL 或现有脚本确认目标行是 `done`，且 `text/model/provider` 正确。
2. 抽查同一段的中文和英文，检查完整性、专名和语气。
3. 登录已部署网站，打开对应书籍和章节并刷新。
4. 确认章节状态、三语显示和段落对齐正常。
5. 只有修改了网站代码、Worker 代码或数据库 migration 时，才进入常规测试、
   commit、push、部署流程。

## 当前线上基线

2026-07-24 去重完成后的只读检查结果：

- PM2：无 `prism-worker`。
- `done=117399`
- `pending=19083`（去重清掉了 9172 行重复排队）
- `failed=1124`
- `processing=0`
- `(paragraph_id, lang)` 重复组 = 0，唯一索引 0014 已上线。
- 已完成模型历史主要为 `qwen2.5:7b` 和 `claude-code:sonnet`。
- 当前待翻译为日文原文到中文/英文。

这是历史快照，不是启动依据。每次任务必须重新运行
`node scripts/check-progress.mjs`。

## 官方模型资料

- OpenAI：https://developers.openai.com/api/docs/guides/latest-model
- Anthropic：https://platform.claude.com/docs/en/about-claude/models/overview
