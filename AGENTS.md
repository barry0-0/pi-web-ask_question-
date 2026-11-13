# AGENTS.md — ask_question 插件

> 项目操作卡。全局兜底规范：`/Users/barry/Desktop/Obsidian/AGENTS.md`。
> 本文件是唯一入口。执行任何开发任务前先读本文件与全局规范。

## 1. 接入

- 本地仓库：`~/Desktop/工作/ask_question/`，远程：`git@github.com:barry0-0/pi-web-ask_question-.git`。
- 全局规范第 1、2、3、5 节全部适用。冲突顺序：安全红线 > 本文件 > 全局规范 > 历史记录。
- 链接地图：`README.md`（功能与用法）、`meta/ACCEPTANCE.md`（验收证据）、`meta/UPSTREAM-README.md`（上游扩展说明）、`meta/UPSTREAM-PATCH-README.md`（补丁历史）。
- Node 依赖外置：库内不存放实体 `node_modules`。扩展运行副本用软链指向 `~/.pi/agent/npm/node_modules`。

## 2. 表达与交付

- ASD-STE100 中文适配风格。短句，主动语态，一次一个意思。
- 交付汇报用 15 行极简表格。
- 文档只写当前有效规则，用正向陈述。

## 3. 提问与审批

- 拿不准必须提问，一次一个核心关键问题。
- 修改代码、文件、数据或执行变更性环境命令前，必须先输出完整方案并获明确批准。
- 只读检查、诊断、日志查看不受审批限制。
- 复杂场景（架构改造、状态机、多端流转）推荐触发 `/grill-me`。

## 4. 文档

| 文档 | 更新方式 |
|---|---|
| `AGENTS.md` | 少量覆盖 |
| `README.md` | 覆盖式，只写当前功能 |
| `meta/ACCEPTANCE.md` | 追加式验收证据 |
| `handoff/TURNS-YYYY-MM.md` | 追加式，位于 Obsidian 库 |

## 5. 安全红线（摘要）

1. 未明确说「可以部署」或「可以发布上线」，禁止生产构建、部署与 `git push`。
2. 默认本地轻量验证，禁止无必要频繁 build。
3. 禁止无 `WHERE` 条件的 `UPDATE` / `DELETE`。
4. 未经批准禁止 `DROP TABLE`、`TRUNCATE`、删列。
5. 云端写操作前提示备份并获确认。
6. 禁止硬编码或回显 Token、密钥、密码、数据库凭据。
7. 禁止修改方案外的无关代码。
8. 未经批准禁止安装第三方依赖。
9. 新功能必须闭环：输入、持久化、流转、展示。
10. 禁止虚构数据、假成功接口、断头字段。
11. 前端原型首选单文件 HTML，零 Node 依赖；本仓库是既有 pi-web 宿主补丁，不新建脚手架。
12. 工程化项目强制 Vue 3 + TS 四层架构；本仓库是既有 TypeScript 扩展与 Python 注入器，不引入新框架。
13. 界面自解释，说明信息下沉到代码注释；危险操作保留后果提示。
