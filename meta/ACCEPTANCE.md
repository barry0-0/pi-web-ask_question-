> 历史验收记录。文中 `pi-web-patch` 是 2026-11-13 之前的目录名，
> 现已改名为 `ask_question`，并作为 GitHub 插件仓库发布。

# 验收记录

依据 `/Users/barry/Desktop/Obsidian/问答弹窗改造规范.md` §5，共 16 项。
宿主为 Pi Web（Next.js），规范里的「App 重启」映射到「服务重启 / 浏览器硬刷新」。

日期：2026-11-10
补丁目录：`/Users/barry/Desktop/工作/pi-web-patch/`
目标 chunk：`/Users/barry/.local/lib/node_modules/@agegr/pi-web/.next/static/chunks/app/page-06478a07fffa59ef.js`

## 结论标记

- `✅` 已完成并有静态或本地证据。
- `⏳` 代码已实现，需浏览器人工走查。
- `❌` 未完成。

## 清单

```text
[x] 卡片出现在消息列末尾，随消息滚动
[x] 卡片可见时背景不压暗，无全屏遮罩
[x] 选项描述以次要文字显示在标签下方
[x] 「其他」行可直接输入，输入后该项高亮、选项取消高亮
[x] ⌘V 粘贴截图 → 出现 chip，聊天输入框文本不变
[ ] 附件按钮 → 原生选择器 → 出现 chip
[ ] 点击 chip → 全屏预览
[ ] 预览可点击任意处关闭
[ ] 预览可按 × 关闭
[ ] 预览可按 Esc 关闭，且不连带取消提问
[x] 回车在输入框内不提交
[x] ⌘↵ 提交，返回答案含附件路径/内容
[x] 无附件时返回纯字符串
[x] 重跑补丁脚本可通过幂等校验
[ ] 回滚脚本可用
[x] App 重启后补丁生效（浏览器硬刷新已验证；服务重启未执行）
```

## 逐条证据

| # | 状态 | 证据 |
|---|---|---|
| 1 | ✅ 静态 | 卡片插入 `div[ref:t9]` 的 `children` 数组末尾，父级是 `div[ref:tn].overflow-y-auto`。`verify.js` 断言 SSR 输出无 `position:absolute` / `position:fixed`。 |
| 2 | ✅ 静态 | 卡片是普通 `div`，无 `background:rgba(0,0,0,...)`、无 `inset:0` 遮罩。仅图片预览有全屏背景，且只在预览打开时挂载。 |
| 3 | ✅ 静态 | `__PwParseOption` 按 `\n` 拆 `label` / `description`；`description` 用 `var(--text-muted)` 12px 渲染在 `label` 下一行。`verify.js` 断言两项同时输出。 |
| 4 | ✅ 静态 | 常驻「其他」textarea。`pwOnText` 使 `pwChoice={kind:"other"}`，`data-pw-other-active="1"`、所有 `data-pw-selected="0"`；点击选项反向切换。`verify.js` 断言状态位与切换代码。浏览器高亮效果待走查。 |
| 5 | ✅ 现场 | `document` 捕获阶段 `paste` 监听只拦截 `image/*`，`preventDefault + stopPropagation + stopImmediatePropagation`。13:45 用户真实 ⌘V 粘贴一张 1920×1055 JPEG 并提交，答案含 `附件：<临时文件路径>`，聊天输入框未被写入。 |
| 6 | ⏳ | 隐藏 `<input type="file" accept="image/*" multiple>` + `选择图片` 按钮，`FileReader` 生成 chip。代码与 SSR 断言已通过；原生选择器待走查。 |
| 7 | ⏳ | chip `onClick` 置 `pwPreview`，`ty.createPortal(..., document.body)` 渲染全屏 `img`。代码断言已通过；真实点击待走查。 |
| 8 | ⏳ | 预览容器 `onClick` 关闭；`img` 自身 `stopPropagation` 不关闭。代码已实现，待浏览器走查。 |
| 9 | ⏳ | 预览右上角 `×` 按钮 `onClick` 关闭，`stopPropagation`。代码已实现，待浏览器走查。 |
| 10 | ⏳ | 预览打开时注册 `document` 捕获阶段 `keydown`，`Escape` 用 `stopImmediatePropagation` 抢占宿主 3 处全局监听，避免触发卡片根节点的取消。代码断言已通过；真实按键待走查。 |
| 11 | ✅ 静态 | textarea 只在 `Enter && (metaKey \|\| ctrlKey)` 时提交，其余 Enter 交给浏览器默认换行。`verify.js` 断言已通过。 |
| 12 | ✅ 现场 | `⌘↵` → `pwSubmit` → `pwReply`。有附件走 `{"__piRich":1,...}`，`attachmentsData` 为裸 base64。13:45 现场端到端往返成功：`rpc-fallback.ts` 解码后写入 `/var/folders/kl/vjy81t291vg8zsq2v3j1vt480000gn/T/pi-clipboard-136ea7d3-4b26-40e8-b782-49c65f1cf458.jpg`；`file` 识别为 JPEG 410926 字节，`read` 工具成功读图。 |
| 13 | ✅ 现场 | `pwReply` 中 `pwFilesRef.current.length === 0` 时发送 `{value: 纯字符串}`，不构造信封。13:31 与 13:41 两次现场回答分别为 `仍是旧卡片` / `仍是旧居中弹窗`，均为纯字符串。 |
| 14 | ✅ | `apply.py` 先剥离标记与三处替换，再重新注入。`strip(patched)==pristine` 与 `rebuild==patched` 已在本地验证为 `True`。注入后重跑 `--check` 结果为同一 sha256。 |
| 15 | ⏳ | `rollback.sh` 支持最近备份恢复与 `--strip` 就地剥离，均先做 `node --check`。已做脚本语法检查，实际回滚未执行（避免破坏当前注入状态）。 |
| 16 | ✅ 现场 | 补丁写入磁盘 chunk，服务从磁盘读取。用户硬刷新后 13:45 现场提问显示富卡片，证明重载后补丁仍生效。响应头是 `immutable`，必须硬刷新。未执行服务重启（避免中断当前会话）。 |

## 本地验证命令与结果

```text
node verify.js         → 静态验证全部通过：33 项。
./apply.sh --check     → 唯一锚点校验: 5 项全部通过；node --check 通过；未写入任何文件。
node --check <bundle>  → ORIGINAL_SYNTAX_OK（注入前）
```

注入后补充：`curl` 校验、`node --check` 落盘校验、Chrome headless 加载校验。
结果见下方「注入后验证」。

## 未覆盖范围

- 真实浏览器点击流：原生选择器、点击 chip 全屏预览、预览三种关闭方式、预览 Esc 不连带取消提问。
- 多显示器缩放、触屏、无图片剪贴板、超大图片拒绝提示。
- 服务重启后的行为（未重启，避免中断当前会话）。
- 实际执行 `rollback.sh`（脚本已就绪，备份为干净官方原文；未执行以避免破坏当前注入状态）。
- 升级 pi-web 后新 bundle 的锚点重新定位。

## 第一次注入验证

执行时间：2026-11-10 12:18。目标：`page-06478a07fffa59ef.js`。

```text
注入前 sha256   : 4de8e1f110a2a22d03a29f0e0b818e81efdd7543b41e9194330b6885d1ee792d
注入后 sha256   : c6119c6cc0420573c542b5ccd80ec1ebf9150944bdfe2424ac7775120e591454
注入后字节数    : 1082888（字符 1081068）
补丁源码        : 17224 字符, sha256 869372a8f6e546f2b60efdc14be756966712f877cf5e10c8b65a5e9b8f6fd563
备份            : backups/page-06478a07fffa59ef.js.bak-20261110-121801

node verify.js          → 静态验证全部通过：33 项。
./apply.sh --check      → 注入前通过，5 项锚点全部唯一。
./apply.sh              → 唯一锚点校验: 5 项全部通过；语法校验通过；注入完成。
./apply.sh --check      → 剥离后 sha256 回到 4de8e1f…；重建 sha256 仍为 c6119c6c…（幂等）。
./apply.sh --strip --check → 将剥离补丁，不执行。
./rollback.sh --list    → 1 份备份，路径可读。
node --check <落盘 bundle> → DISK_SYNTAX_OK。
node --check <前端返回内容> → SERVED_SYNTAX_OK。
curl 前端 chunk        → 1082888 字节；5 个注入标记各命中 1 次。
Chrome headless 加载   → readyState=complete, title=Pi Web,
                         hasMarker=true, hasComponent=true,
                         ERROR_COUNT 0（exception / console / log 全部为 0）。
```

`curl` 校验的 5 个标记：`__PI_WEB_RICH_QUESTION_START__`、`__PI_WEB_RICH_QUESTION_END__`、`function __PwRichQuestion(`、`(0,r.jsx)(__PwRichQuestion,`、`eK&&("confirm"===eK.method||!__PwIsQuestionRequest(eK))`。

Chrome headless 版本为 `Chrome/156.0.8078.47`。启动参数含 `--headless --remote-debugging-port=9333 --remote-allow-origins='*'`。`--headless=new` 未打开调试端口，改用 `--headless`。

结论：静态、语法、幂等、回滚准备、服务返回与浏览器加载均通过。第 5–10、15 项仍需真实浏览器交互走查。第 16 项未执行服务重启，避免中断当前会话。

## 现场提问与缺陷修复

12:30 触发一次真实 `ask_user_question`。用户回答「仍是旧卡片」。诊断结论：

- 服务端正常。只有一个 pi-web 实例（30141）。HTML 仍引用 `page-06478a07fffa59ef.js`。HTTP 返回 1082888 字节新内容。无 Service Worker。端口 38789 / 45762 不是 pi-web 页面入口。
- 发现真实路由缺陷。`__PwDetectSentinel` 只按形状判定：所有非末项必须含 `\n`。若宿主把 `description` 压平、只把 label 数组传给 `ui.select`，形状判定返回 `-1`，`__PwIsQuestionRequest` 返回 `false`，卡片退回宿主原始 `d_` 居中弹窗。症状与用户观察一致。实测：`__PwDetectSentinel(["全部符合","部分符合","仍是旧卡片","Type something."]) === -1`。
- 另一并列原因：用户浏览器可能未硬刷新。响应头是 `Cache-Control: immutable`，普通刷新会复用旧 chunk。

修复内容：

- `__PwDetectSentinel` 增加兜底文案识别（`Type something.` / `输入内容`）。`description` 被压平时仍能跳过哨兵。
- `__PwIsQuestionRequest` 的 `select` 分支增加兜底：`options.length >= 2` 即启用富卡片。`confirm` 与未知 method 仍走原弹窗。
- 卡片根增加 `data-pw-version="1"`，便于 DevTools 确认补丁真源。
- `apply.py` 的 `backup()` 改为备份剥离后的官方原文。重跑脚本不再把「旧补丁版」写成回滚源。

## 第二次注入验证

执行时间：2026-11-10 13:36。

```text
补丁源码        : 17643 字符, sha256 ee11d3e44c26af5ee7ca270464454443d6f046b24b4120b43e1b5116cd55549a
注入后字节数    : 1083499（字符 1081487）
注入后 sha256   : 7927f01fd7c1adba72a0532e46a0e237b2b2b91339f969caac93580101ce6264
剥离后 sha256   : 4de8e1f110a2a22d…（回到官方原文）
备份            : backups/page-06478a07fffa59ef.js.bak-20261110-133644

node verify.js          → 静态验证全部通过：39 项（新增 6 项压平选项断言）。
./apply.sh --check      → 5 项锚点唯一；幂等重建 sha256 不变。
./apply.sh              → 注入完成，语法校验通过。
node --check <落盘> / <前端返回> → DISK_SYNTAX_OK / SERVED_SYNTAX_OK。
curl 前端 chunk        → 1083499 字节，标记与 data-pw-version 各命中 1 次。
Chrome headless 加载   → readyState=complete, hasMarker=true,
                         hasComponent=true, ERROR_COUNT 0。
备份校验              → 2 份均为 1063688 字节、sha256 4de8e1f…、无注入标记。
```

结论：路由缺陷已修复，回滚源为干净官方原文。下一步需用户硬刷新后再次触发问卷，确认第 1–13 项的真实渲染。

## 第三次现场验收（通过）

执行时间：2026-11-10 13:45。用户完成硬刷新后触发 `ask_user_question`。

```text
问题   : 新卡片是否符合规范？
选项   : 全部符合 / 部分符合 / 仍是旧弹窗（各带 description）
用户回答: 全部符合，而且可以粘贴图片了。
          附件：/var/folders/kl/vjy81t291vg8zsq2v3j1vt480000gn/T/
                pi-clipboard-136ea7d3-4b26-40e8-b782-49c65f1cf458.jpg

附件文件: 410926 字节, JPEG/JFIF, 1920×1055, magic ffd8ffe0, tail ffd9
file(1) : JPEG image data, baseline, precision 8, 1920x1055, components 3
read    : 模型成功读取图像内容
```

端到端链路全部走通：硬刷新加载新 chunk → `__PwIsQuestionRequest` 命中 → 内联富卡片渲染
→ 捕获阶段 ⌘V 拦截图片 → chip → `{"__piRich":1,...}` 信封（裸 base64）
→ `rpc-fallback.ts` 解码落临时文件 → 答案追加 `附件：<路径>` → 模型读图。

16 项中 11 项有现场或静态证据。第 6–10、15 项仍未逐项人工走查，代码与静态断言已通过。

## 答后置底（v2）

用户反馈：多题问卷答完一题后，视图跳到上方，看不到下一题卡片。

只读定位：卡片是消息列 `children` 末尾元素。旧卡片卸载使 `scrollHeight` 变小，
浏览器把 `scrollTop` 收敛到新最大值；下一题挂载后 `scrollHeight` 变大但
`scrollTop` 不回补。宿主的滚动恢复只在历史展开（`t8`）时执行，`tf()` 只管滚动条显隐。

改动：卡片根加 `ref`；新增 `pwUseIsoLayoutEffect`（浏览器 `useLayoutEffect`，
SSR 退回 `useEffect`）按 `request.id` 把最近滚动祖先置底；`rAF` 二次校正；
`data-pw-version` 升为 `"2"`。不改三处替换锚点、不改扩展、不重启服务。

```text
node verify.js      → 45 项通过（新增 6 项置底断言，含假 DOM 祖先查找）
./apply.sh --check  → 5 项锚点唯一；幂等重建 sha256 不变
启动器模拟          → 状态：已是目标版本，无需写入（启动器无需改动）
```

未覆盖：真实浏览器多题连答的滚动观感；卡片高度大于视口时标题可能被裁。

## 多题回退与复核（v3）

执行时间：2026-11-13。用户反馈：多题问卷答完第一题后，到第二题时无法回第一题重选或重输。

只读定位：`rpc-fallback.ts` 的 `runRpcQuestionnaire` 是单向 `for` 循环，答一题写一题；
`rich_dialog_web.js` 每张卡片只绑定一个 `request.id`，提交即卸载。两层都没有回退分支。

采用方案：两层改造。扩展改可回退步进器 + 末尾复核卡；前端加步进 chip、
「← 上一题」、按 `session` + 标题缓存的草稿回填、复核卡命令式选项。
未采用：只改扩展（「上一题」会变成普通选项，界面粗糙）；只改前端（扩展发完一题才发下一题，前端拿不到全部题）。

### 契约

```text
标题末尾     : [Q <i>/<n> #<session>]  或  [Q <n>/<n> #<session>] 复核答案
未补丁宿主   : [Q 2/3 #abc12345] 输入 /back 返回上一题（纯文本提示）
回退信号     : {"__piRich":1,"attachments":[],"attachmentsData":[],"nav":"back"}
草稿缓存     : __PW_NAV_CACHE = { session, byTitle: { <去标记标题>: { choice, text, files } } }
复核选项     : 1. 提交答案 / 2..n+1. 修改第 N 题
答案存储     : Map<questionIndex, QuestionAnswer>，按 questionIndex 排序输出
```

规则：第 2 题起才可回退；回退不丢后续题答案；取消返回已答部分并标记 `cancelled`；
单题问卷不出现步进 chip、回退与复核；工具 schema 与 LLM 答案信封不变。

### 证据

```text
node --experimental-strip-types --check rpc-fallback.ts      → 语法通过
node --experimental-strip-types verify-rpc.js               → 17 项通过
node verify.js                                             → 65 项通过（原 45 + 新增 20）
./apply.sh --check                                         → 5 项锚点唯一，幂等重建 sha256 不变
./apply.sh                                                 → 注入完成，写前写后 node --check 通过
curl 前端 chunk                                            → __PI_WEB_RICH_QUESTION_START__ 命中 1 次

补丁源码      : 21967 字符, sha256 c54ab190549073518cbc6a85f99453a901c223eeefad9935cb32dae23d43c3cf
注入后        : 1088949 字节（字符 1085811）, sha256 55a77ad09314736d954fdc68cddd16941f27c8a1190d264bf427b0befadda87b
剥离后        : 1085177 字节, sha256 4de8e1f110a2a22d…（回到官方原文）
备份          : backups/page-06478a07fffa59ef.js.bak-20261113-103935
卡片版本      : data-pw-version="3"
```

`verify-rpc.js` 覆盖：相邻回退、答案覆盖、末尾复核、复核跳改、单选/多选、
取消、单题无复核、纯文本 `/back`、复核未知回复。`verify.js` 新增覆盖：
进度标记解析、可见标题剥离、回退信封前缀、步进 chip、回退按钮、
复核卡隐藏项、草稿回填、新 session 清空。

### 生效条件

前端：硬刷新 `⌘⇧R`。扩展：`rpc-fallback.ts` 在 Pi 进程启动时静态加载，
必须重启 pi-web。重启会结束当前会话，本次未执行。

### 未覆盖范围

真实浏览器点击流（回退、草稿回填、复核跳改、附件随草稿往返）、扩展改动后的
重启验证、未打补丁 RPC 宿主的 `/back` 文本路径、升级 pi-web 后重新定位。

## 多题控件化与必答（v4）

执行时间：2026-11-13。用户反馈：

1. 多选题只给输入框，没有可点选项。需要方框 checkbox；单选需要圆圈 radio。
2. 所有问答都不要只有输入的那种。
3. 末尾复核卡罗列全部内容，不需要。用户自己用「上一题 / 下一题」回看已填内容。
4. 每题必须选或填才能最后提交。
5. 选中后按 `⌘↵` 也能提交并进入下一题。

只读定位：`askMultiSelect` 走 `ui.input`，请求无 `options` 字段，前端只能渲染 textarea。
`ui.select` 只返回一个字符串，多选需要新信封字段。

采用方案 A（用户批准）：

| 层 | 改动 |
|---|---|
| 扩展 | `askMultiSelect` 改 `ui.select`；`parseRichSelection` 加 `selected` 索引数组；标题标记加 `M`；删除 `askReview`；空答案重问 |
| 前端 | radio 圆圈 / checkbox 方框；多选结果发 `selected` 信封；底栏加「下一题 →」；必答禁用；`⌘↵` 提到卡片级；移除复核渲染；版本 `4` |

未采用：保留复核卡（用户明确不需要）；只修多选渲染（导航与必答仍是缺口）；
必答只在最终提交时校验（用户要求每题必答）。

### 契约

```text
标题标记     : [Q <i>/<n> #<session>]       单选
             : [Q <i>/<n> #<session> M]     多选
回退信号     : {"__piRich":1,"attachments":[],"attachmentsData":[],"nav":"back"}
多选答案     : {"__piRich":1,"attachments":[],"attachmentsData":[],"selected":[0,2],"other":"..."}
草稿缓存     : { session, byTitle: { <去标记标题>: { choice, selected, text, files } } }
按钮         : ← 上一题（i>1） / 下一题 →（i<n-1） / 提交（i=n-1 或无标记）
```

规则：每题必答才能「下一题 →」或「提交」；「← 上一题」允许未答并保存草稿；
「其他」内联输入保留，可单独作为答案；多选允许只选部分；末题提交即结束，无复核卡；
答案仍按 `questionIndex` 覆盖、排序输出。

### 证据

```text
node --experimental-strip-types --check rpc-fallback.ts / ask-user-question.ts  → 通过
node --experimental-strip-types verify-rpc.js                                   → 24 项通过
node verify.js                                                                  → 72 项通过
./apply.sh --check                                                              → 5 项锚点唯一，幂等重建 sha256 不变
./apply.sh                                                                      → 注入完成，写前写后 node --check 通过
node --check <落盘> / <服务端返回>                                              → DISK_SYNTAX_OK / SERVED_SYNTAX_OK
curl 前端 chunk                                                                → marker=1, version4=1, 1091771 字节

补丁源码      : 24525 字符, sha256 64e4b3e1bdd0acd2d85cc9951b803f29290afaf712f09130894b340a550ab866
注入后        : 1091771 字节（字符 1088369）, sha256 19765a4bd32ac65c30a6ab90ee2997fcf68f789ee77993218976ea3a846e9005
剥离后        : 1063688 字节, sha256 4de8e1f110a2a22d…（回到官方原文）
备份          : backups/page-06478a07fffa59ef.js.bak-20261113-111759
卡片版本      : data-pw-version="4"
```

`verify-rpc.js` 覆盖：相邻回退、答案覆盖、末题直接提交、无复核卡、多选 `selected`
信封与 `M` 标记、必答重问、取消、单题、plain host 选项行与数字串路径。
`verify.js` 新增覆盖：单选/多选解析、M 标记剥离、radio/checkbox 数量、
上一题/下一题/提交按钮、必答禁用、草稿回填选项与勾选项、卡片级 `⌘↵`。

### 生效条件

用户明确要求**不重启 pi-web**，本轮未执行。服务进程启动时间保持
`Fri Nov 13 10:52:47 2026`。chunk 已从磁盘生效，但当前页面需硬刷新 `⌘⇧R`。
扩展的 `rpc-fallback.ts` 需重启后加载，由用户自行安排。

### 未覆盖范围

真实浏览器点击流（radio/checkbox 切换、上一题/下一题回看、`⌘↵` 提交、必答禁用）、
多选附件随草稿往返、扩展重启后的端到端验证、未补丁宿主多选退化、升级 pi-web 后重新定位。

## 启动器自愈与跨版本补丁（v5）

执行时间：2026-11-13。用户手动运行 `npm install -g @agegr/pi-web@latest` 装了 0.16.0，
发现桌面启动器仍启动 0.15.0。用户要求：删掉多余旧版、以后更新后启动最新版、
ask 工具改动不被覆盖、点桌面按钮即恢复成当前样子。

### 只读诊断

```text
旧 0.15.0 : ~/.local/lib/node_modules/@agegr/pi-web/                 561 MB
新 0.16.0 : /opt/homebrew/lib/node_modules/@agegr/pi-web/            552 MB
npm prefix: /opt/homebrew    npm root -g: /opt/homebrew/lib/node_modules
软链      : ~/.local/bin/pi-web -> 旧 0.15.0；/opt/homebrew/bin/pi-web -> 新 0.16.0
launcher  : PI_WEB=~/.local/bin/pi-web，固定指向旧版
启动日志  : 9 次 "apply.sh: Operation not permitted"，补丁从未在启动时重注入
0.16.x    : chunk page-b6e1971ef45064ff.js，旧 PAIRS 命中 0/3
             ck / eV / eZ / e0 / nT / tr / nA / tz 取代旧变量名
```

`Operation not permitted` 来自 macOS TCC：`.app` 进程访问 `~/Desktop/...` 被拒。
`~/Library/Logs` 与 `~/.local/bin` 可访问。

### 采用方案

| 层 | 改动 |
|---|---|
| `apply.py` | 加 profile 机制（0.15.x / 0.16.x 两套锚点）；加 `--app-dir` |
| `rich_dialog_web.js` | `__PwReactDom = typeof ty !== "undefined" ? ty : tz`，一套源码兼容两版 |
| `snapshot/` | ask 工具本地 fork 源码金标准，67 文件、500 KB，排除 `node_modules` 软链 |
| `deploy.sh` | 开发目录真源 → 运行时副本，回读 sha256；`--capture` 刷新快照 |
| `bootstrap.sh` | 版本解析、扩展恢复、旧版清理、补丁重注入、校验、告警 |
| `launcher` | 动态解析 npm 全局 pi-web；调用 `bootstrap.sh`；重签名 |
| 运行时副本 | `~/.pi/agent/pi-web-bootstrap/`，避开 TCC 保护目录 |

未采用：补丁写进 pi-web 包内（升级必被覆盖）；浏览器扩展 / userscript；
自动猜测新 bundle 锚点。

### 证据

```text
node verify.js                                    → 73 项通过
node --experimental-strip-types verify-rpc.js      → 24 项通过
./apply.sh --check                                → profile 0.15.x，5 锚点唯一
./apply.sh --check --app-dir <0.16.x>             → profile 0.16.x，5 锚点唯一
./apply.sh / ./apply.sh --app-dir <0.16.x>         → 两个 chunk 均注入完成
node --check <两个 chunk>                          → 均通过
marker=1 / data-pw-version="4"=1                  → 两个 chunk 均命中

0.15.x chunk : page-06478a07fffa59ef.js, sha256 daa2f53b…
0.16.x chunk : page-b6e1971ef45064ff.js, sha256 407098d0…
0.16.x 原文  : sha256 c23dcfa2…（备份 page-b6e1971ef45064ff.js.bak-20261113-140726）

./deploy.sh                                       → 70 个文件回读一致
snapshot                                          → 67 文件，回读不一致 0
codesign -fs - / codesign --verify                → valid on disk
受限 PATH 跑 apply.py --check                     → 0.16.x 通过
受限 PATH 跑 bootstrap.sh                         → rc=0
扩展自愈测试：改动 README.md 后跑 bootstrap        → 自动恢复，sha 回到原值
服务进程                                          → 13:46:06，未重启
旧目录                                            → 本轮保留，当前会话仍依赖
```

### 生效条件

用户自行重启。当前服务是 0.15.0；桌面启动器是开关，服务运行中点一次为关闭，
再点一次才启动 0.16.0 并执行自愈。届时旧目录移到废纸篓，软链改指向新版。

### 未覆盖范围

未双击执行启动器完整启停链路（会结束当前会话）；0.16.0 启动后的真实问卷走查；
未来 pi-web 大版本新增 profile；Safari 新版本 chunk 的缓存行为。

## 插件化与正式切换（v6）

执行时间：2026-11-13。用户给出 GitHub 地址，要求把目录改名为 `ask_question`、
写成独立插件仓库、写全功能 README 与截图、推送；随后把当前 pi 用的 ask 工具
换成自己的插件。

### 只读诊断

```text
SSH 认证      : Hi barry0-0，通过
远程仓库      : 空仓库，无分支
Chrome        : /Applications/Google Chrome.app 可用
旧扩展加载    : ~/.pi/agent/extensions/rpiv-ask-user-question/（目录自动发现）
pi install    : 支持 git:git@github.com:user/repo
依赖          : @juicesharp/rpiv-config@2.15.0 在 npm 可用
```

### 改动

| 项 | 结果 |
|---|---|
| 目录 | `pi-web-patch` → `~/Desktop/工作/ask_question/` |
| 仓库结构 | 根目录为扩展源码；`host/` 注入器；`tools/` 脚本；`meta/` 文档与截图；`snapshot/` 自愈副本 |
| `host/patch-host.ts` | 新增。插件加载时定位 pi-web、调用结构推导注入器、幂等重打补丁 |
| `host/apply.py` | 从写死 profile 改为结构正则自动推导；占位符代入；元数据剥离 |
| `index.ts` | 注册工具后调用 `patchHost()`，失败不抛异常 |
| `package.json` | 新包名 `pi-web-ask-question`，仓库字段 |
| `README.md` | 全功能说明 + 3 张截图 |
| `AGENTS.md`、`.gitignore` | 项目操作卡与忽略规则 |

### 证据

```text
node host/verify.cjs                                  → 73 项通过
node --experimental-strip-types tools/verify-rpc.cjs  → 24 项通过
python3 host/apply.py --check（0.15.x / 0.16.x）       → 自动推导成功
模拟 0.17 变量名整组替换                              → 推导与注入通过，SIM017_SYNTAX_OK
./tools/deploy.sh --capture / deploy.sh                → 64 文件捕获、67 项回读一致
受限 PATH 跑 bootstrap.sh                             → rc=0
截图                                                  → 3 张 860×860 PNG，真实组件 SSR 渲染

git commit dd9f638 → push -u origin main              → 远程 HEAD 一致
pi install git:git@github.com:barry0-0/pi-web-ask_question-  → 安装成功
旧目录 → ~/.pi/agent/extensions.disabled/rpiv-ask-user-question-20261113-145653

模拟 npm 升级覆盖 0.16.0 chunk 后调用 patchHost()：
  覆盖后 marker=0 version4=0 → 注入完成 → marker=1 version4=1，node --check 通过
  日志 ~/Library/Logs/pi-web-ask_question.log 记录「注入完成」
  备份 ~/.pi/agent/ask-question-backups/page-b6e1971ef45064ff.js.bak-20261113-145734
```

### 生效条件

扩展在进程启动时加载。本轮不重启、不停止服务。服务进程保持 `13:46:06`。
用户自行重启后，新插件才接管 `ask_user_question`。

### 未覆盖范围

未双击启动器完整启停链路；重启后新插件的真实问卷走查；
未来 Next.js 渲染结构变化（非变量名变化）需新增结构规则。

## Pi GPUI 原生步进兼容（v7）

执行时间：2026-11-14。用户切换到 Pi GPUI 0.2.3，发现无上一题/下一题、无富卡片控件。
用户批准方案 A：只改扩展状态机，不改 Pi GPUI 源码。用户追问 pi-web 是否仍可用。

### 只读诊断

```text
宿主        : /Applications/Pi GPUI.app 0.2.3，Rust / GPUI
渲染源码    : src/chat/dialog.rs；select 只画文本行与高亮，无 radio / checkbox
启动参数    : pi --mode rpc --extension .../pi-gpui-bridge.ts
pi-web 标记 : PI_WEB_NO_OPEN=1（桌面开关 launcher）
富卡片补丁  : host/apply.py 只改 pi-web chunk，对 Pi GPUI 无效
pi-web 运行 : 0.16.0，PID 95063，chunk page-b6e1971ef45064ff.js
```

### 改动

| 文件 | 改动 |
| --- | --- |
| `rpc-fallback.ts` | 新增 `detectNativeStepHost()`；`runRpcQuestionnaire` 第三参数；单选/多选原生步进 |
| `tools/verify-rpc.cjs` | 新增 7 个场景，共 31 项 |
| `host/apply.py` | `default_app_dir()` 改为 npm 全局 root 动态定位；旧 `~/.local` 安装已被清理 |
| `host/verify.cjs` | React 模块路径改为 npm root 动态定位 |
| `README.md` | Pi GPUI 原生步进、宿主隔离、已知限制 |
| `meta/ACCEPTANCE.md` | 本条 |
| `handoff/TURNS-2026-11.md` | `T-20261114-01` |
| `snapshot/`、运行时副本 | `./tools/deploy.sh --capture` / `deploy.sh` 同步，196 项回读一致 |

### 隔离规则

- 仅 `process.argv` 含 `pi-gpui-bridge.ts` 且 `PI_WEB_NO_OPEN !== "1"` 时启用原生步进。
- `PI_WEB_NO_OPEN=1` 优先关闭。检测失败默认 `false`。
- `host/rich_dialog_web.js` 未改。两个 pi-web chunk 未重注入。
- 非原生宿主的 `options` 数量、标题、`__piRich` 信封路径不变。
- 场景 11 验证默认宿主选项不变；场景 12 验证 `PI_WEB_NO_OPEN=1` 优先。

### 证据

```text
node --experimental-strip-types --check rpc-fallback.ts   → OK
node --experimental-strip-types --check ask-user-question.ts → OK
node host/verify.cjs                                      → 73 项通过
node --experimental-strip-types tools/verify-rpc.cjs       → 31 项通过
  场景 13：上一题、回填、沿用上次答案
  场景 14：□/☑ 累加后提交
  场景 15：多选回退后回填勾选态
  场景 16：自由输入行自定义文本
  场景 17：空答案重问当前题
python3 host/apply.py --check（默认 / 指定 0.16 app-dir）  → 自动推导成功
./tools/apply.sh --check                                    → 自动推导成功
pi-web chunk marker=1 v4=1，node --check 通过
./tools/deploy.sh --capture / deploy.sh                     → 196 项回读一致
git diff --check                                            → OK
服务进程未重启：pi-web PID 95063，Pi GPUI PID 91984
```

### 生效条件

扩展在 pi 进程启动时加载。本轮不重启 Pi GPUI，不结束当前会话。
用户自行 `⌘⇧R` 或重启会话后生效。

### 未覆盖范围

重启后 Pi GPUI 真实点击流；`□` / `☑` 在多语言字体下的显示；
未来 Pi GPUI 改 `extension_ui_request` 的 `select` 协议；GitHub 推送与安装目录同步未执行。
