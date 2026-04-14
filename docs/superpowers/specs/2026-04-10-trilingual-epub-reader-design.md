# 三语 EPUB 小说翻译阅读器 — 设计文档

> 日期：2026-04-10
> 状态：已确认

---

## 1. 产品定位

个人自用的三语对照小说阅读器。上传 EPUB 电子书后，系统保留原书章节结构，按阅读进度逐章生成中文、日文、英文三个版本，在 Web 阅读器中段落级左右对照阅读。

核心定位：**首先是阅读器，其次才是翻译器。**

## 2. 用户画像与使用场景

- 个人自用，无需账号系统
- 源语言优先级：日文 > 中文 > 英文
- 典型场景：上传日文轻小说 EPUB → 逐章翻译成中文+英文 → 三语对照阅读学习

## 3. 架构方案

**方案 C：Next.js 全栈 + 轻量内存队列**

单进程 Next.js 应用，前端 + API + 后台翻译队列共存，Docker 单容器部署。

```
┌─────────────────────────────────────────────┐
│              Docker Container               │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │         Next.js App (Node.js)       │    │
│  │                                     │    │
│  │  ┌──────────┐    ┌──────────────┐   │    │
│  │  │ React    │    │ Route        │   │    │
│  │  │ Frontend │◄──►│ Handlers     │   │    │
│  │  │          │    │ (API)        │   │    │
│  │  └──────────┘    └──────┬───────┘   │    │
│  │                         │           │    │
│  │                  ┌──────▼───────┐   │    │
│  │                  │ Translation  │   │    │
│  │                  │ Queue        │   │    │
│  │                  │ (p-queue)    │   │    │
│  │                  └──────┬───────┘   │    │
│  │                         │           │    │
│  │           ┌─────────────┼────────┐  │    │
│  │           │             │        │  │    │
│  │     ┌─────▼──┐   ┌─────▼──┐  ┌──▼┐ │    │
│  │     │SQLite  │   │LLM API │  │FS │ │    │
│  │     │(Drizzle)│  │(Claude) │  │   │ │    │
│  │     └────────┘   └────────┘  └───┘ │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  data/                                      │
│  ├── db.sqlite        (数据库)              │
│  ├── uploads/          (原始 EPUB)          │
│  └── exports/          (导出文件)           │
└─────────────────────────────────────────────┘
```

**选择理由：**
- 个人自用不需要 Redis，p-queue 进程内队列足够
- 一个 Docker 容器搞定一切，运维最简
- 全 TypeScript，一种语言一套工具链
- 未来可升级：加 Redis + BullMQ 只替换队列层

## 4. 技术栈

| 层面 | 选择 |
|------|------|
| 框架 | Next.js 15 (App Router) |
| 语言 | TypeScript |
| 前端 | React 19 + Tailwind CSS + shadcn/ui |
| 数据库 | SQLite + Drizzle ORM |
| EPUB 解析 | JSZip + cheerio |
| 语言检测 | franc |
| 翻译队列 | p-queue (进程内) |
| LLM 接入 | Provider 抽象层，默认 Anthropic SDK |
| 部署 | Docker (单容器) |
| 数据持久化 | Docker volume 挂载 data/ 目录 |

## 5. 数据模型

### Book (书籍)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| title | TEXT | 书名 |
| author | TEXT | 作者 |
| source_lang | TEXT | 源语言 (ja / zh / en) |
| cover_path | TEXT | 封面文件路径 (可选) |
| file_path | TEXT | 原始 EPUB 存储路径 |
| total_chapters | INTEGER | 总章节数 |
| status | TEXT | pending / parsed / error |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

### Chapter (章节)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| book_id | TEXT | FK → Book |
| index | INTEGER | 章节序号 |
| title | TEXT | 章节标题 |
| source_html | TEXT | 原始 XHTML 内容 |
| status | TEXT | pending / translating / done / error |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

### Paragraph (段落)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| chapter_id | TEXT | FK → Chapter |
| seq | INTEGER | 段落序号 |
| source_text | TEXT | 原始纯文本 |
| source_markup | TEXT | 原始 HTML 标记 |
| created_at | TEXT | 创建时间 |

### Translation (翻译)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| paragraph_id | TEXT | FK → Paragraph |
| lang | TEXT | 目标语言 (zh / en / ja) |
| text | TEXT | 翻译结果 |
| status | TEXT | pending / processing / done / failed |
| model | TEXT | 使用的模型 |
| tokens_used | INTEGER | 消耗 token 数 |
| error_message | TEXT | 失败原因 (可选) |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

### ReadingProgress (阅读进度)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (UUID) | 主键 |
| book_id | TEXT | FK → Book |
| chapter_index | INTEGER | 当前章节序号 |
| scroll_position | REAL | 页面滚动位置 |
| updated_at | TEXT | 更新时间 |

**要点：**
- Translation 与 Paragraph 多对一，每段最多 2 条翻译记录（两种目标语言）
- 翻译失败只重试 failed 的段落，不重跑整章
- 无 user_id — 个人自用

## 6. API 路由

```
POST   /api/books/upload              上传 EPUB，触发解析
GET    /api/books                     书库列表
GET    /api/books/[id]                书籍详情 + 章节列表
DELETE /api/books/[id]                删除书籍及所有关联数据

GET    /api/chapters/[id]             章节内容（段落 + 已有翻译）
GET    /api/chapters/[id]/status      章节翻译状态（轮询用）
POST   /api/chapters/[id]/translate   触发该章翻译

POST   /api/paragraphs/[id]/retry    重试失败的段落翻译

GET    /api/progress/[bookId]         获取阅读进度
PUT    /api/progress/[bookId]         保存阅读进度

POST   /api/export/[bookId]           触发导出 (JSON / HTML ZIP)
GET    /api/export/[bookId]/download  下载导出文件

GET    /api/settings                  获取用户设置
PUT    /api/settings                  保存用户设置
```

- 个人自用无鉴权
- 上传限制文件大小（默认 50MB）
- chapters/[id] 返回段落数组，每段含原文 + 已完成翻译，未完成的标记 status

## 7. 翻译管线

### 7.1 上传到首章可读

1. 用户上传 EPUB → 创建 Book 记录 (status: pending)
2. 后台解析：JSZip 解包 → 解析 container.xml / OPF / spine → 创建 Chapter 记录
3. 第1章：cheerio 解析 XHTML → 拆分成 Paragraph 记录
4. 自动触发第1章翻译：检测源语言 → 为每段创建 2 条 Translation (pending)
5. 阅读器先展示目录和原文，译文完成后实时补齐

### 7.2 懒翻译与预取

- 用户翻到第 N 章 → 若未解析则解析该章段落 → 若未翻译则触发翻译（高优先级）
- 后台预取第 N+1 章（低优先级）
- 失败段落仅重试失败项，最多 3 次，间隔递增

### 7.3 翻译执行

- p-queue 并发数默认 2，可在设置中调节
- 每段独立翻译，不带上下文窗口
- 前端每 3 秒轮询章节状态，翻译完成的段落即时渲染

### 7.4 Provider 抽象

统一接口：`translate(text, fromLang, toLang, model) → string`

默认实现 Claude (Anthropic SDK)，预留 OpenAI / Gemini 适配层。API Key 和 model 在设置页配置。

## 8. 前端页面

### 8.1 首页 — 书库 `/`

- 上传区域（拖拽/点击上传 EPUB）
- 书籍卡片列表：封面/书名/作者/源语言标签/翻译进度条
- 操作：阅读 / 导出 / 删除

### 8.2 阅读器 `/read/[bookId]`

核心页面，三语段落对照阅读。

**布局：**
- 顶栏：书名、章节名、语言模式切换（单语/双语/三语）、设置按钮
- 左侧栏：章节目录 + 翻译状态指示（已完成/翻译中/待翻译），可折叠
- 主区域：左右分栏段落对照（三语三栏 / 双语两栏 / 单语全屏）
- 底栏：前后章导航 + 阅读进度百分比

**核心交互：**
- 段落联动高亮：点击任意语言段落，三栏对应段落同时高亮
- 语言模式快捷切换
- 翻译中的段落显示加载状态，完成后无刷新补齐

**阅读设置（抽屉面板）：**
- 字体选择：每种语言可独立选择字体（日文 Noto Serif JP / 中文 思源宋体 / 英文 Georgia 等）
- 字号滑块
- 行距选择：1.5x / 1.8x / 2.0x
- 段间距：紧凑 / 标准 / 宽松
- 主题切换：深色 / 浅色
- 所有设置自动保存

### 8.3 设置页 `/settings`

- LLM 配置：Provider 选择 / API Key / Model / 并发数
- 导出设置

### 8.4 组件结构

```
components/
├── BookCard.tsx           书籍卡片
├── UploadZone.tsx         上传区域
├── Reader/
│   ├── ReaderLayout.tsx   阅读器主布局
│   ├── ColumnView.tsx     单栏内容（一种语言）
│   ├── ParagraphBlock.tsx 段落块（含高亮逻辑）
│   ├── ChapterSidebar.tsx 目录侧边栏
│   ├── TopBar.tsx         顶栏
│   ├── BottomBar.tsx      底栏
│   └── SettingsDrawer.tsx 设置抽屉
└── ui/                    shadcn/ui 基础组件
```

## 9. 导出

### JSON 导出

完整结构化数据，含书籍元数据、章节、段落、三语翻译。

### HTML ZIP 导出

```
export-书名.zip
├── index.html          (目录页，链接到各章)
├── chapter-01.html     (三语段落对照排版)
├── chapter-02.html
├── ...
└── style.css           (基础阅读样式)
```

## 10. MVP 边界

### 包含

- 文件格式：EPUB
- 语言：中 / 日 / 英 三语
- 阅读模式：单语 / 双语 / 三语
- 翻译策略：首章预翻译 + 当前章即时翻译 + 下一章预取
- 每段独立翻译，无上下文窗口
- 导出：JSON / HTML ZIP
- Docker 单容器部署

### 不包含

- TXT 格式支持
- 多用户 / 鉴权
- 整本一次性翻译
- 三语 EPUB 导出
- 句级对齐 / 全文术语库
- 复杂 EPUB 排版还原（竖排、ruby 注音等）
- 生词本 / 朗读 / 批注

## 11. 风险与应对

| 风险 | 应对 |
|------|------|
| EPUB 排版过于复杂 | 只保留章节结构和基础样式，不承诺出版级还原 |
| 长篇小说 token 成本高 | 按章节懒翻译，缓存已完成章节 |
| 多章翻译人名术语不一致 | MVP 接受此局限，后续增加书级 glossary |
| LLM 调用失败 | 段落级状态管理，失败重试最多 3 次 |
| 进程重启丢失队列 | SQLite 记录任务状态，重启后自动恢复 pending 任务 |
