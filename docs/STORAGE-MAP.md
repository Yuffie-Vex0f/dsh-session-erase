# 存储位置与删除策略（已在本机核实）

核实方式：读取 DSH 0.2.1-rc.3 源码（`dsh-base/cordis.patch.yml`、`dsh-session-persistence-jsonl`、`dsh-storage-domain`、`dsh-session-projection-cache`、`dsh-workspace`、`dsh-spill-local`、`dsh-schedule`）并对照真实磁盘布局。

| 数据 | 位置 | 写入者 | 删除策略 |
|---|---|---|---|
| 会话日志（消息主体） | `~/.dsh/sessions/<projectKey(cwd)>/<encode(id)>/session.v4.jsonl.zstd` | session-persistence-jsonl | 仅当会话不再 live 时删除整个会话目录 |
| 工作区记账 / 归档 / 置顶 | `~/.dsh/storages/workspace.json` | dsh-workspace 注册表 | **仅删除验证通过后**：`detachSession`（每个 workspace 无条件幂等）→ `unarchiveSession` / `unpinSession`；删除前绝不调用 `archiveSession` |
| 投影缓存（列表摘要） | `~/.dsh/storages/session_projcache/sessions/<id>.json` | session-projection-cache | `storageDomain.get('session_projcache').table('sessions').delete(id)` |
| 计划任务 | `~/.dsh/storages/schedule/tasks/*.json`（记录含 `sessionId`） | dsh-schedule | 删除 `sessionId` 匹配的记录（`workspace/session-stop` 已先停止其定时器） |
| 附件（共享） | `~/.dsh/attachments/v1`（`objects/`、`files/`、`file-objects/`，内容寻址） | attachment-local | **不删除**：内容可被其他会话引用，无法证明独占 |
| 附件派生缓存 | `~/.dsh/cache/attachments/request-images` | attachment-local | **不删除**（共享派生） |
| 会话 spill 临时文件 | `%TEMP%/dsh-spill-XXXXXX/session-<sha256(id)[:12]>` | dsh-spill-local | 删除该 hash 命名的叶子目录 |
| 消息反馈 | 存在会话日志事件内 | message-feedback | 随日志一起删除 |
| 会话全文索引 | SQLite `:memory:`（本部署 `openAt: never`） | session-query-sqlite | 无磁盘文件；进程结束即消失；`listSessions` 每次重读持久化 |
| 浏览器草稿 | `localStorage: dsh.conversation.<sessionId>` | ui-conversation | 客户端 `localStorage.removeItem` |
| 当前选中会话 | `localStorage: dsh.sessions.current` | ui-workspace | 删除前先导航离开（同官方归档行为） |
| Electron 缓存 / Local Storage | `%APPDATA%/@deepseek-ai/dsh-desktop/*` | Chromium | 不含会话记录，不触碰 |

## 活动会话的官方生命周期

- **停止**：`workspace/session-stop` 事件（providers：Agent turn、jobs、subagents、schedule）。删除前调用；失败即中止，不删除文件。
- **flush**：会话 dispose 时由 checkpoint 策略落盘；本插件不删除 live 会话，因此没有待写数据需要 flush。
- **释放**：宿主 live 注册表 `ctx.get("sessions").get(id)` 是权威状态；客户端离开会话后该条目消失。插件在删除时检查此状态，仍在 live 即返回 `409 session-live`，不做超时推断。

## 为什么不需要 SQLite 清理

本部署的 `session-query-sqlite` 配置为 `path: ':memory:'`、`openAt: never`（`dsh-base/cordis.patch.yml` 与 `dsh-web-app/cordis.patch.yml` 均如此）。因此不存在磁盘索引；列表数据由 workspace 注册表 + 每次重读持久化的 `listSessions` 组成，删除会话目录后即不再出现。

## 无法保证物理擦除

SSD 磨损均衡、NTFS USN/日志、卷影副本、系统备份、云同步，以及已发送给模型提供方的请求内容。插件只保证“应用管理的逻辑数据与本地文件已删除”。

## 验证方法

- `tools/verify-session-gone.mjs <id>`：独立只读验证器，逐位置检查会话目录、投影缓存、`workspace.json` 的三个集合（归档、置顶、workspace 记账）、schedule 任务与 spill 目录；全部不存在时 exit 0，发现残留时 exit 1，参数错误时 exit 2。支持 `--home <dshHome>` 指定 Harness home、`--json` 输出结构化报告。
