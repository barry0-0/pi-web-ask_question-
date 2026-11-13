> 历史验收记录。文中 `pi-web-patch` 是 2026-11-13 之前的目录名，
> 现已改名为 `ask_question`，并作为 GitHub 插件仓库发布。

# Pi Web 问答卡片补丁

把 `ask_user_question` 的问卷弹窗改成消息列内的富卡片，并给多题问卷加前后切换与控件化选项。
依据 `/Users/barry/Desktop/Obsidian/问答弹窗改造规范.md` v1.0 路线 B：改宿主前端。

## 适用范围

| 项 | 值 |
|---|---|
| 宿主 | Pi Web 0.15.0（`node /Users/barry/.local/bin/pi-web --no-open --port 30141`） |
| 前端 | Next.js 生产构建 chunk |
| 目标文件 | `~/.local/lib/node_modules/@agegr/pi-web/.next/static/chunks/app/page-*.js` |
| 扩展 | `~/.pi/agent/extensions/rpiv-ask-user-question/`（本地 fork，2.15.0） |

两层配合：扩展的 `rpc-fallback.ts` 是问卷状态机（题号步进、回退、必答校验、答案解析）；
前端 chunk 是渲染层（卡片、步进 chip、「← 上一题」、草稿缓存）。
`rich_dialog_web.js` 与 `apply.py` 只负责把渲染层写进 chunk。

本补丁**不改** `app.asar`、`AGENTS.md`、`settings.json`、数据库。
Pi Desktop 的 Electron 补丁在 `../pi-desktop-patch/`，与本补丁互不依赖。

## 文件

| 文件 | 用途 |
|---|---|
| `rich_dialog_web.js` | 可读补丁源码。`__PwRichQuestion` 组件 + 纯函数。 |
| `apply.py` | 幂等注入器。按内容锚点定位 bundle，剥离旧补丁后再追加。 |
| `apply.sh` | `apply.py` 的入口。 |
| `rollback.sh` | 恢复最近备份，或就地剥离补丁。 |
| `verify.js` | 前端静态验证。复用 pi-web 自带的 react，不装依赖。 |
| `verify-rpc.js` | 扩展步进器行为验证。直接 import 本地 TS 源码，模拟点击序列。 |
| `snapshot/rpiv-ask-user-question/` | ask 工具本地 fork 源码金标准。67 个文件，排除 `node_modules` 软链。 |
| `deploy.sh` | 同步开发目录真源到运行时副本，回读 sha256 校验；`--capture` 刷新快照。 |
| `bootstrap.sh` | 启动自愈入口：版本解析、扩展恢复、旧版清理、补丁重注入、结果校验。 |
| `ACCEPTANCE.md` | 规范 §5 的 16 项验收记录 + 多题导航与启动器自愈验收。 |
| `backups/` | 最近 3 份 `page-*.js.bak-<时间戳>`。 |

## 用法

```bash
cd /Users/barry/Desktop/工作/pi-web-patch

node verify.js        # 前端纯函数 + 信封 + SSR 渲染，不写文件
node --experimental-strip-types verify-rpc.js  # 扩展步进器行为，不写文件
./apply.sh --check    # 干跑：校验 5 个唯一锚点 + node --check，不写文件
./apply.sh            # 备份 + 注入（默认 0.15.x 安装路径）
./apply.sh --check --app-dir /opt/homebrew/lib/node_modules/@agegr/pi-web/.next/static/chunks/app  # 0.16.x
./deploy.sh           # 同步开发目录到运行时副本，回读校验
./deploy.sh --capture # 从扩展目录刷新 ask 工具快照，再同步
./apply.sh --check    # 再跑一次，验证幂等
./rollback.sh --list  # 列备份
./rollback.sh         # 恢复最近备份
./rollback.sh --strip # 就地剥离补丁（不依赖备份）
```

`./apply.sh --bundle <path>` 可显式指定 chunk。默认按内容锚点自动定位，
不硬编码 Next.js 构建哈希。

## 注入点

补丁代码块插在模块 `61789` 内、紧靠 `function d_(e){` 之前。原因：
`i`（React）、`r`（jsx runtime）、`ty`（react-dom）都是模块作用域变量，
文件顶层追加的代码看不到它们。

三处替换，每处都必须在剥离后的原文中恰好命中 1 次；0 次或 >1 次直接中止：

1. `confirm` 与非问卷请求继续用宿主原始 `d_` 弹窗。
2. 放宽 `!nE&&` 条件，空会话下卡片仍可见。
3. 在消息列 `div[ref:t9]` 的 `children` 数组末尾追加卡片。

只有图片预览 `createPortal` 到 `document.body`。卡片本身是消息列的普通子节点，
随消息滚动，不遮挡最后一条消息。

## 行为

- 选项渲染成两行：主行 `label`，次行 `description`。
- 扩展追加的哨兵选项（`Type something.` / `输入内容`）不渲染成按钮，改为常驻「其他」输入框。
- 点击选项只选中并高亮；输入「其他」会高亮输入框并取消选项高亮。
- `提交` 或 `⌘↵` / `Ctrl+↵` 发出答案。`Enter` 在输入框内换行。
- `⌘V` 粘贴图片在 `document` 捕获阶段拦截，聊天输入框文字不变。
- `选择图片` 调原生文件选择器。单张上限 2MB，最多 4 张。
- 点击附件 chip 打开全屏预览。背景点击、`×`、`Esc` 三种关闭方式。
  `Esc` 用捕获阶段 + `stopImmediatePropagation`，不连带取消提问。
- 多题问卷答完一题后，下一张卡片挂载时自动把消息列置底。
  只在 `request.id` 变化时执行一次，不打断中途上滚看历史。
  原因：旧卡片卸载使 `scrollHeight` 变小、浏览器收敛 `scrollTop`，
  下一题挂载后 `scrollHeight` 变大但 `scrollTop` 不回补，卡片会落在视口外。
- 无附件时回答是纯字符串。有附件时是 `{"__piRich":1,...}` 信封，
  `attachmentsData[].data` 是裸 base64（已去掉 `data:image/...;base64,` 前缀）。

### 多题导航与控件（v4）

扩展在每个对话标题末尾加一行纯文本进度标记 `[Q i/n #session M?]`。
`M` 表示多选。未打补丁的宿主看到的是可读提示；富卡片解析后把该行从可见标题剥离。

- 第 `i/n` 题显示步进 chip。第 2 题起在底栏显示「← 上一题」；
  非末题显示「下一题 →」，末题显示「提交」。末题提交即结束，无复核卡。
- 点「← 上一题」只回传 `{"__piRich":1,"nav":"back"}`，不当成答案。
  扩展题号减 1 并重发该题；后续题已收的答案不清空。
  点「下一题 →」/「提交」回传当前答案，扩展题号加 1。
- 提交前与回退前都把当前选项高亮、勾选项、「其他」文本、附件写入内存缓存。
  key 是去掉进度标记后的标题；`session` 变化表示新一次问卷，缓存清空。
  同一题重发时自动回填，用户可前后切题查看并改写已填内容。
- 单选选项前是圆圈，多选选项前是方框。多选点击切换勾选，不立即提交。
- 多选请求改走 `ui.select` 带业务选项，不再有纯输入框题目。
  提交回传 `{"__piRich":1,"selected":[0,2],"other":"..."}`；无附件也发信封。
- 必答：未选且未输入时禁用「下一题 →」与「提交」，`⌘↵` 同样受控。
  扩展侧空答案重问当前题，不取消整份问卷。
- `⌘/Ctrl+↵` 由卡片级监听处理。选中选项后按 `⌘↵` 提交并进入下一题。
  `Enter` 在输入框内只换行。
- 「取消」或 `Esc` 放弃整份问卷，返回已答部分并标记 `cancelled: true`。
- 单题问卷行为不变：无步进 chip、无上一题、无下一题。
- 未打补丁的 RPC 宿主输入 `/back` 回退；首题输入 `/back` 退化为普通自定义答案。
  多选在这些宿主退化为一次选一项，或在「其他」行输入 `1,3; 自定义`。
  这是唯一兼容退化。

## 启动器自愈（v5）

桌面 `Pi 开关.app` 是唯一入口。`start_service()` 在启动服务前调用
`~/.pi/agent/pi-web-bootstrap/bootstrap.sh`。

**为什么有运行时副本**

`.app` 进程访问 `~/Desktop/...` 会被 macOS TCC 拒绝，日志表现为
`apply.sh: Operation not permitted`。运行时副本放在 `~/.pi/agent/`，
不在保护目录。开发目录仍是唯一真源，`deploy.sh` 负责同步并回读 sha256 校验。

**启动流程**

| # | 动作 |
|---|---|
| 1 | `npm root -g` 解析全局 pi-web 路径与版本，不依赖 `~/.local/bin` 软链 |
| 2 | 对比扩展快照与运行目录；不一致则从快照恢复，恢复后回读校验 |
| 3 | 服务已停时把旧版安装目录移到 `~/.Trash/`，软链改指向新版 |
| 4 | `apply.py --check` → `apply.py --app-dir <当前版本>` 重注入补丁 |
| 5 | 校验 `data-pw-version="4"`、补丁标记与 `node --check` |
| 6 | 补跑 npm 未执行的 `prepare-terminal.js` |

任一步失败：写 `~/Library/Logs/pi-web-switch.log` 并发 macOS 通知，返回非 0。
launcher 仍启动服务，不静默。

**更新后的行为**

| 场景 | 结果 |
|---|---|
| `npm install -g @agegr/pi-web@latest` 后点启动器 | 启动最新版；ask 工具从快照恢复；补丁重注入 |
| 手动覆盖 `rpiv-ask-user-question` 目录 | 下次启动自动恢复成本地 fork 状态 |
| 旧版 `~/.local/lib/node_modules/@agegr/pi-web` 仍在 | 服务已停时移到废纸篓，可恢复 |
| `Pi 开关` 是开关 | 服务运行中点一次是关闭，再点一次才启动并自愈 |

**维护规则**

- 快照是 ask 工具唯一真源。以后改了扩展文件，必须跑
  `./deploy.sh --capture` 再 `./deploy.sh`。否则启动器会把扩展恢复成快照里的旧版。
- 只覆盖 sha 不一致的文件。不删除额外文件，不碰 `node_modules` 软链。
- `apply.py` 按内容探测 profile。现有 `0.15.x` 与 `0.16.x` 两套锚点。
  未来 pi-web 大版本改了 minified 变量名，需新增一套 profile；脚本会明确告警。

**残留限制**

- 未来 chunk 结构变化时需人工新增 profile。脚本不猜测锚点。
- 0.16.x 补丁只做静态与 SSR 验证。真实浏览器需重启后走查。

## 兼容保护

`__PwIsQuestionRequest` 识别本扩展的问卷请求：

- `select`：优先按哨兵形状（末项无换行、其余有换行）识别。宿主把
  `description` 压平、只传 label 时，形状会失效；此时按固定哨兵文案
  （`Type something.` / `输入内容`）识别。两者都不匹配但选项数 >= 2 时
  兜底启用富卡片。
- `input` / `editor`：placeholder 含 `custom answer`，或标题含
  `Enter the numbers of all that apply` / `Type your answer:`。
- `confirm` 与单选项 `select` 仍走宿主原始弹窗。

兜底不破坏答案格式：单选无附件时富卡片返回选项原字符串，与原弹窗一致。
多选必须用 `{"__piRich":1,"selected":[...]}` 信封表达多项结果。

`nav` 与 `selected` 是信封新字段。旧前端不认识时不会发出，
纯文本 `/back` 仍由扩展识别。`input` / `editor` 识别规则保留给其它扩展与
未补丁宿主的「其他」追问。工具 schema、`buildQuestionnaireResponse` 信封、
TUI 路径、`chatMode` 路径都不变。

## 缓存与生效

chunk 的响应头是 `Cache-Control: public, max-age=31536000, immutable`，
且 HTML 没有 SRI。文件改完即从磁盘生效，**不需要重启服务**，但普通刷新可能复用缓存。

扩展的 `rpc-fallback.ts` 由 Pi 进程启动时静态加载。改动扩展后必须**重启 pi-web**
才生效。重启会结束当前会话。只改 `rich_dialog_web.js` 时不需要重启服务。

必须硬刷新：`⌘⇧R`，或 DevTools → Network → 勾选 Disable cache 后刷新，
或 DevTools 右键刷新按钮 → Empty Cache and Hard Reload。

若硬刷新后仍看到居中的旧弹窗，在 DevTools Console 执行：

```js
document.querySelector('[data-pw-card]')  // 新卡片存在时返回节点
performance.getEntriesByType('resource').filter(e => e.name.includes('page-'))
```

并在 Network 中确认该 chunk 的响应不是 `(disk cache)`。

验证服务端已经吐出新 chunk：

```bash
curl -s http://127.0.0.1:30141/_next/static/chunks/app/page-06478a07fffa59ef.js \
  | grep -c __PI_WEB_RICH_QUESTION_START__
# 期望 1
```

## 升级与幂等

- **开发目录是唯一真源。** `apply.sh` → `apply.py` 每次从 `rich_dialog_web.js`
  重新构建目标字节。启动器调用运行时副本的 `bootstrap.sh`，不直接读本目录。
  修改本目录源码后必须跑 `./deploy.sh` 同步，否则启动器仍用旧副本。
  已注入磁盘的版本若与新版一致，`apply.py` 打印「已是目标版本，无需写入」。
  改 launcher 后必须 `codesign -fs - "/Users/barry/Desktop/Pi 开关.app"` 重签名。
- `apply.sh` 先按起止标记剥离旧补丁，再撤销三处替换，最后重新注入。
  重复执行结果字节一致，不会叠加。
- **`pi` 与 `pi-web` 是两个独立全局包。** `pi` 是 `@earendil-works/pi-coding-agent`；
  `pi-web` 是 `@agegr/pi-web`。npm prefix 是 `/opt/homebrew`，全局包在
  `/opt/homebrew/lib/node_modules/@agegr/pi-web`（0.16.0，nested 核心 1.5.2）。
  旧 0.15.0 副本在 `~/.local/lib/node_modules/@agegr/pi-web`，由启动自愈清理。
- **升级或重装 `pi-web` 会覆盖** `.next/static/chunks/app/page-*.js`。
  `bootstrap.sh` 启动时按 `npm root -g` 找到新版目录并自动重注入。
  `apply.py` 按内容探测 profile；现有 `0.15.x` 与 `0.16.x` 两套锚点。
  结构变化时不匹配任何 profile，脚本中止并发通知，需按新 bundle 新增一套。
- 共享扩展目录 `~/.pi/agent/extensions/` 被两个 CLI 共用。若手动替换
  `rpiv-ask-user-question` 扩展，问卷数据契约可能变化，导致路由失配退回原弹窗；
  补丁文件本身不受影响。
- **扩展侧由快照自愈。** `rpc-fallback.ts` 不在 `apply.sh` 管理范围内，
  改由 `snapshot/rpiv-ask-user-question/` 与 `bootstrap.sh` 恢复。
  手动覆盖扩展目录或升级 `pi` 后，下次启动自动恢复成本地 fork 状态。
  改了扩展文件必须跑 `./deploy.sh --capture` 刷新快照。
- 每次写入前备份到 `backups/`，只留最近 3 份。
- 写入前对临时副本做 `node --check`，通过后原子替换；写后再校验一次。

## 已知限制

- 浏览器拿不到真实文件路径。附件只能以 base64 走 RPC，扩展再落临时文件。
  所以限制单张 2MB、最多 4 张。
- 锚点按 profile 绑定 0.15.x / 0.16.x 的 minified 字符串，不是公开 API。
  未来版本变化需新增 profile；脚本会告警，不猜测。
- 交互项（粘贴、文件选择、预览、快捷键、回退、下一题、多选勾选）需要浏览器人工走查，
  `verify.js` 只做结构断言与 SSR 渲染验证；`verify-rpc.js` 只做扩展状态机模拟。
- 进度标记写在 `title` 末尾，不是公开 API。pi 核心若改 `ui.select` 请求字段，
  需同步改 `buildNavLine` 与 `__PwNavMeta`。
- 草稿缓存只在页面内存。硬刷新会丢未提交的输入；已提交答案保存在扩展状态机中。
- 会话中未覆盖：真实点击流、多显示器缩放、无图片剪贴板场景、
  0.16.0 启动后的真实问卷走查、启动器双击后的完整自愈链路。
