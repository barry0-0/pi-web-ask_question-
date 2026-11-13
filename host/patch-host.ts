/**
 * 插件加载时自动给当前 pi-web 打前端补丁。
 *
 * 为什么需要它：pi-web 在 RPC 模式下只暴露 ui.select / ui.input。
 * 富问卷卡片的渲染层在 pi-web 自己的 chunk 里，扩展 API 改不到。
 * 本模块在扩展加载时定位 pi-web 安装目录，用 host/apply.py
 * 做结构推导与幂等注入。升级 pi-web 后 chunk 被覆盖，下一次加载自动重打。
 *
 * 约束：
 *   - 不抛异常。任何失败只写日志，不阻塞扩展加载与服务启动。
 *   - 不写死版本号与压缩变量名。推导逻辑在 apply.py。
 *   - 备份写到 ~/.pi/agent/ask-question-backups，不写插件安装目录。
 */

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_DIR = fileURLToPath(new URL("./", import.meta.url));
const APPLY_PY = join(HOST_DIR, "apply.py");
const CARD_JS = join(HOST_DIR, "rich_dialog_web.js");
const MARKER = "/*__PI_WEB_RICH_QUESTION_START__*/";
const VERSION_MARK = 'data-pw-version": "4"';
const LOG_DIR = join(homedir(), "Library/Logs");
const LOG_FILE = join(LOG_DIR, "pi-web-ask_question.log");
const BACKUP_DIR = join(homedir(), ".pi/agent/ask-question-backups");

function log(message: string): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, "utf8");
	} catch {
		// 日志不可写时静默，不影响扩展。
	}
}

/** npm 全局 root 与常见安装目录，按优先级去重。 */
function npmRoots(): string[] {
	const roots: string[] = [];
	const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
	for (const npm of [
		"/opt/homebrew/bin/npm",
		"/usr/local/bin/npm",
		join(homedir(), ".local/bin/npm"),
	]) {
		if (!existsSync(npm)) continue;
		try {
			const root = execFileSync(npm, ["root", "-g"], {
				encoding: "utf8",
				timeout: 5000,
				env: { ...process.env, PATH: pathPrefix },
			}).trim();
			if (root) roots.push(root);
		} catch {
			// 某个 npm 不可用时继续试下一个。
		}
	}
	roots.push(
		"/opt/homebrew/lib/node_modules",
		"/usr/local/lib/node_modules",
		join(homedir(), ".local/lib/node_modules"),
	);
	return [...new Set(roots)];
}

/** 定位唯一的 page-*.js。多个候选时跳过，避免打错文件。 */
function findChunk(): string | null {
	for (const root of npmRoots()) {
		const appDir = join(root, "@agegr/pi-web/.next/static/chunks/app");
		if (!existsSync(appDir)) continue;
		const files = readdirSync(appDir).filter((name) => /^page-.*\.js$/.test(name));
		if (files.length !== 1) {
			log(`chunk 不唯一，跳过: ${appDir} (${files.length})`);
			continue;
		}
		return join(appDir, files[0]);
	}
	return null;
}

function runApply(python: string, args: string[]): void {
	execFileSync(python, args, {
		encoding: "utf8",
		timeout: 30000,
		env: {
			...process.env,
			PI_ASK_BACKUP_DIR: BACKUP_DIR,
			PI_ASK_NODE: process.execPath,
		},
	});
}

/** 由 index.ts 在扩展注册后调用。异步但不阻塞。 */
export async function patchHost(): Promise<void> {
	try {
		if (!existsSync(APPLY_PY) || !existsSync(CARD_JS)) {
			log("缺 host/apply.py 或 host/rich_dialog_web.js，跳过");
			return;
		}
		const chunk = findChunk();
		if (!chunk) {
			log("未找到 pi-web chunk，跳过注入");
			return;
		}
		const text = readFileSync(chunk, "utf8");
		if (text.includes(MARKER) && text.includes(VERSION_MARK)) {
			log(`已是目标版本: ${chunk}`);
			return;
		}
		const python = process.env.PI_ASK_PYTHON || "python3";
		runApply(python, [APPLY_PY, "--bundle", chunk, "--check"]);
		runApply(python, [APPLY_PY, "--bundle", chunk]);
		log(`注入完成: ${chunk}`);
	} catch (error) {
		log(`注入失败（不阻塞启动）: ${error instanceof Error ? error.message : String(error)}`);
	}
}
