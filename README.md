# dsh-weekly-report

在 DSH 侧边栏的「周报」面板里，把「这一周在 DSH 里干的事 + 手工记下的其他事」整理成四段式周报，审完稿后通过企业微信邮
件发给领导。

- **不做自动外发**：生成 → 你自己改 → 预览邮件 → 点「确认发送」，四步缺一不可。
- **不发群、不发机器人消息**：`message aibot send` 只能发给「当前授权人」或机器人最近 20 个会话，给不了领导；
  邮件是唯一能稳定发给指定收件人的通道，所以本插件只做邮件。

## 一、安装

先克隆到任意目录（下面以 `E:\weekly` 为例），然后跑仓库里的 `install.ps1`：

```powershell
git clone git@github.com:Yishui010/dsh-weekly-report.git E:\weekly
pwsh -ExecutionPolicy Bypass -File E:\weekly\install.ps1
```

脚本做两件事（幂等，可重复跑）：在 `~/.dsh/profiles/tauri/node_modules` 下建一个指回源码目录的 junction，
再把 `dsh-plugin-weekly` 写进该 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`）。
DSH 只从这两个地方加载客户端插件，缺一不可。

然后**重启 DSH 应用**（客户端插件在启动时打包，热更新不会重新扫描 bundle 列表）。

重启后在**左侧边栏的图标列**点「周报」图标（文档样式的小图标），面板直接在主列打开 —— 用的是
`sidebar.panellist`（图标行）+ `main`（keyed 面板），两边用同一个 id `weekly` 配对。不再占用
「设置 → 插件」的位置。

## 二、第一次用

1. **填设置**（面板底部「设置 → 展开」）：
   - 收件人：`leader@example.com`
   - 抄送：`you@example.com`（一般填自己）
   - 主题模板：`周报｜{name}｜{week}（{range}）`
   - 署名：`张三`
   - 模型：留空 = 用 DSH 当前默认模型（`agent-default-model`）
2. **企业微信授权**：插件自己定位 `@wecom/cli` 的 `bin/wecom.js` 并调用（不依赖 `wecom-cli.cmd`，因为
   PowerShell 执行策略是 Restricted）。授权成功后 `auth show --status` 会显示 `authorized`（机器人代
   你本人执行）。凭证过期时在终端重跑一次：
   ```powershell
   wecom-cli.cmd auth init
   ```
   没授权时面板顶部会显示「企业微信未授权」，「预览邮件」「试运行」仍可用，真发送会拿到 `893201` 授权错误。
3. 平时随手记：面板「手工记录」框里写一行点「添加记录」，落盘到本周的 notes.jsonl。
   本周已记的内容就列在下面，每条带「编辑」「删除」：点编辑原地变成输入框，`Ctrl+Enter` 保存、`Esc` 取消。
4. 想让周报**只从某几个目录**收集 DSH 会话：设置里勾选工作区（默认不勾 = 全部工作区）。
   勾选后只汇总这些目录（含子目录）下的会话，面板顶部的「工作区」小标签会显示当前范围。

## 三、每周流程

1. 周五点「生成草稿」：插件读取本周（周一 00:00 ~ 下周一 00:00，本地时区）的 DSH 主会话
   （排除 subagent 会话），取每轮的 prompt / response 摘要 + 涉及的项目，连同手工记录一起交给模型，
   按四段式写出草稿：**本周完成 / 当前推进中 / 风险与需要支持 / 下周计划**。
2. 在文本框里改（纯文本编辑器，没有 markdown 预览——按你的要求不搞实时渲染）。
3. 点「预览邮件」：显示收件人、抄送、主题和最终正文（含署名），这一步不发送。
4. 确认无误点「确认发送」。想先验证参数合不合规，点「试运行（不发送）」，它只跑 `mail send --dry-run`。

## 四、数据落在哪

| 内容 | 路径 |
| --- | --- |
| 配置（收件人/抄送/主题/署名/模型/额外要求/工作区过滤） | `~/.dsh/storages/weekly/config.json`（面板可视化编辑；`workspaces: []` = 全部工作区） |
| 手工记录 | `~/.dsh/storages/weekly/notes.jsonl`（每行一条，追加写） |
| 草稿 | `~/.dsh/storages/weekly/drafts/<ISO 周>.md` |
| 实际发给 `mail send` 的正文 | `~/.dsh/storages/weekly/outbox/<ISO 周>.md`（含署名段，`mail send` 要求本地 .md 文件） |

## 五、HTTP 接口

宿主侧注册在 `/weekly/api`，只监听本机：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/weekly/api/state?week=YYYY-Www` | 某周的全部状态（配置、记录列表 `notes`、会话列表 `sessions`、可用工作区 `workspaces`、草稿、统计、可选周列表、企业微信授权状态） |
| POST | `/weekly/api/generate` | 收集 + 调模型 + 存草稿 |
| POST | `/weekly/api/draft` | 保存手改后的草稿 |
| POST | `/weekly/api/notes` | 追加一条手工记录 |
| POST | `/weekly/api/notes/update` | 修改一条手工记录（按时间戳定位，`{at, text}`） |
| POST | `/weekly/api/notes/delete` | 删除一条手工记录（按时间戳） |
| POST | `/weekly/api/activity` | 只看本周收集到什么（不调模型，调试用） |
| POST | `/weekly/api/preview` | 生成邮件预览（收件人/抄送/主题/正文） |
| POST | `/weekly/api/send` | 发送；`dryRun: true` 时走 `--dry-run` |
| POST | `/weekly/api/config` | 保存设置 |

## 六、会话是怎么被选中和裁剪的

- 只读 `~/.dsh/storages/session_projcache/sessions/*.json` 的元数据（`lastPromptAt` 过滤、`turnOutline`
  取每轮 prompt/response 摘要、`workingDirectory` 当项目名），**不解析会话原文**，所以很快也不占内存。
- 排除 `subagent` 会话；同一周会话太多时按轮数/token 从多到少取前 N 个（默认 40），并在提示词里注明
  「另有 X 个会话未纳入」。
- 会话里出现过的**文件路径和项目名**会随摘要一起进提示词——「当前推进中」这一节就是靠这些线索判断的。
- **工作区过滤**：配置里的 `workspaces` 非空时，只保留 `workingDirectory` 等于其中之一或在其子目录下的会话
  （Windows 路径大小写/斜杠不敏感，`D:\work\demo2` 不会被 `D:\work\demo` 误收）。空数组 = 不过滤。

## 七、可选的定时任务

插件本身不排程。想要「周五 16:30 自动生成草稿等你审」：

```text
每周五 16:30 调用 POST http://127.0.0.1:3080/weekly/api/generate
```

用 DSH 自带的定时任务（或 Windows 计划任务跑一行 `Invoke-RestMethod`）都行。**定时只生成，不发送**，
发送永远保留人工确认。

## 八、卸载

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\tauri"
Remove-Item (Join-Path $profile "node_modules\dsh-plugin-weekly") -Force
# 再从 package.json 的 dsh.profile.bundles 和 dependencies 里删掉 "dsh-plugin-weekly"
```

## 九、改动后怎么验证

```powershell
# 1) 纯逻辑冒烟（周区间/周序列/邮件封装/工作区筛选）；必须走 junction 路径，让 bare import 解析到 profile 依赖
& 'D:\deve_env\nodejs_24_21\node.exe' --preserve-symlinks `
  "$env:USERPROFILE\.dsh\profiles\tauri\node_modules\dsh-plugin-weekly\smoke.mjs"

# 2) 真实数据上的工作区筛选（只读，不启动服务）
& 'D:\deve_env\nodejs_24_21\node.exe' --preserve-symlinks `
  "$env:USERPROFILE\.dsh\profiles\tauri\node_modules\dsh-plugin-weekly\_check-workspaces.mjs"

# 3) 端到端跑真实路由（临时端口；会临时写 notes/config，跑完自动还原）
& 'D:\deve_env\nodejs_24_21\node.exe' --preserve-symlinks `
  "$env:USERPROFILE\.dsh\profiles\tauri\node_modules\dsh-plugin-weekly\_check-api.mjs"
```

**生效方式**：
- 改 `lib/client.js`（面板）：**刷新页面**即可。宿主是按内容哈希下发 `/plugins/??dsh-plugin-weekly/client.js&rev=<hash>`，
  刷新会拿到新 hash 和新代码，不用重启。
- 改 `lib/index.js`（宿主）：**必须重启 DSH**。宿主代码在启动时整包 import，进程里是旧副本（旧宿主没有的接口会回
  `未知接口 POST /notes/update`）。

## 十、已知限制

- 只发邮件，不发企业微信聊天消息（原因见开头）。
- 正文按纯文本编辑，不支持 markdown 渲染预览；模型仍按 markdown 写（邮件 `content_type` 是 markdown，
  企微邮箱能正确渲染标题和列表）。
- 依赖 `wecom-cli` 的授权态；凭证过期就得重新 `wecom-cli auth init`。
- 会话摘要来自 `turnOutline`，本身是截断过的短摘要；要更细的细节需要改 `lib/index.js` 里的
  `collectWeek` 去解析 `session.v4.jsonl.zstd`（多帧 zstd，需逐个 magic `28 B5 2F FD` 解帧）。
