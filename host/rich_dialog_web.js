/*
 * pi-web 富问卷卡片 —— 注入到 .next/static/chunks/app/page-*.js 的模块 61789 内。
 *
 * 宿主上下文（由 apply.py 保证注入位置）：
 *   i  = React            （var i = n(12115)）
 *   r  = react/jsx-runtime（var r = n(95155)）
 *   模块作用域变量由 apply.py 推导后替换占位符：
 *   __PW_REACT__ = React，__PW_REACT_DOM__ = react-dom。
 *   request: { id, method, title, message, options, placeholder, prefill, expiresAt }
 *   onRespond(request, { value | confirmed | cancelled })
 *
 * 设计约束（问答弹窗改造规范 v1.0）：
 *   1. 卡片作为消息列子元素，随消息滚动；不能用 position:absolute / portal 到 body。
 *   2. 只有「图片预览」允许 createPortal 到 document.body。
 *   3. 选项 label / description 两行渲染；「其他」直接内联输入，不跳转弹窗。
 *   4. ⌘↵ / Ctrl+↵ 提交；Enter 留在输入框内换行。
 *   5. 粘贴图片在 document 捕获阶段拦截，不写入聊天输入框。
 *   6. 无附件时返回纯字符串，保持原扩展的回答解析逻辑不变。
 *   7. 有附件时返回 {"__piRich":1,...} 信封，字段与 rpc-fallback.ts 对齐。
 *   8. 多题问卷按标题里的 [Q i/n #session M?] 显示步进 chip；i>1 才显示「← 上一题」。
 *   9. 回退只发 {"__piRich":1,"nav":"back"}，扩展重发上一题；草稿按 session+标题缓存并回填。
 *  10. 单选选项前是圆圈，多选选项前是方框；多选结果走 {"__piRich":1,"selected":[...]} 信封。
 *  11. 每题必答才能「下一题 →」/「提交」；⌘↵ 提交并进入下一题；末题提交即结束，无复核卡。
 *  12. 未打补丁的宿主看到纯文本进度提示，输入 /back 也能回退。
 *
 * 本文件是可读源码。apply.py 会把它包在起止标记之间并插入 bundle。
 * 所有标识符以 __Pw / __PW 开头，避免与 minified 短名冲突。
 */

/* 模块作用域变量名随打包版本变化，由注入器按结构推导后代入。 */
var __PwReactDom = __PW_REACT_DOM__;

var __PW_MAX_BYTES = 2 * 1024 * 1024;
var __PW_MAX_FILES = 4;

/*
 * 多题问卷会话缓存。key 是去掉进度标记后的标题；同一题重发时标题不变。
 * session 由扩展在每次 ask_user_question 调用时生成，新会话清空旧草稿。
 * 只存当前页面内存：刷新页面会丢草稿，但已提交答案仍在扩展的 answers 中。
 */
var __PW_NAV_CACHE = { session: null, byTitle: {} };

/*
 * 进度标记是纯文本，未打补丁的 RPC 宿主也能读到提示。
 * 卡片解析后把该行从可见标题里剥离，改成步进 chip 与「← 上一题」按钮。
 */
function __PwNavMeta(pwReq) {
	var pwRaw = __PwStrip(pwReq && pwReq.title);
	var pwM = pwRaw.match(/\[Q (\d+)\/(\d+) #([a-z0-9]+)(?: ([A-Z]+))?\]([^\n]*)/i);
	if (!pwM) return null;
	return {
		index: Number(pwM[1]) - 1,
		total: Number(pwM[2]),
		session: pwM[3],
		multi: /M/i.test(pwM[4] || ""),
		canBack: Number(pwM[1]) > 1
	};
}

function __PwStripNav(pwText) {
	return __PwStrip(pwText).replace(/\n?\[Q \d+\/\d+ #[a-z0-9]+(?: [A-Z]+)?\][^\n]*/gi, "");
}

/* 去掉宿主终端色序列，避免标题里出现 ESC 控制字符。 */
function __PwStrip(pwText) {
	return String(pwText == null ? "" : pwText)
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

/*
 * rpc-fallback.ts 的 formatOptionLine 产出 "N. label\ndescription"。
 * 普通 ui.select 选项只有一行，按 plain 处理。
 */
function __PwParseOption(pwRaw) {
	var pwTxt = __PwStrip(pwRaw);
	var pwIdx = pwTxt.indexOf("\n");
	if (pwIdx < 0) {
		return {
			label: pwTxt.replace(/^\s*\d+[.)]\s*/, ""),
			desc: "",
			number: "",
			plain: true
		};
	}
	var pwHead = pwTxt.slice(0, pwIdx).trim();
	var pwM = pwHead.match(/^(\d+)[.)]\s*([\s\S]*)$/);
	return {
		label: pwM ? pwM[2] : pwHead,
		desc: pwTxt.slice(pwIdx + 1).trim(),
		number: pwM ? pwM[1] + "." : "",
		plain: false
	};
}

/*
 * 识别扩展追加的哨兵选项（"Type something." / "输入内容"）。
 * 主判定用形状：末项无换行，前面所有项都有换行，且至少两项。
 * 部分宿主把 description 压平，只把 label 传给 ui.select，此时形状判定失效。
 * 兜底用固定哨兵文案识别，避免把"其他"当成普通按钮再渲染一次。
 */
function __PwDetectSentinel(pwOptions) {
	if (!Array.isArray(pwOptions) || pwOptions.length < 2) return -1;
	var pwLastIdx = pwOptions.length - 1;
	var pwTail = pwOptions[pwLastIdx];
	if (typeof pwTail !== "string" || pwTail.indexOf("\n") >= 0) return -1;
	var pwByShape = true;
	for (var pwI = 0; pwI < pwLastIdx; pwI++) {
		if (typeof pwOptions[pwI] !== "string" || pwOptions[pwI].indexOf("\n") < 0) {
			pwByShape = false;
			break;
		}
	}
	if (pwByShape) return pwLastIdx;
	return /Type something\.|输入内容|type something/i.test(__PwStrip(pwTail)) ? pwLastIdx : -1;
}

/*
 * 只对本扩展的问卷请求启用富卡片与 __piRich 信封。
 * select 兜底：选项数 >= 2 时一律启用。宿主可能不传 description，
 * 也可能不追加哨兵，形状判定会漏判并退回原 d_ 居中弹窗。
 * 富卡片在无附件时仍返回选项原字符串，答案格式与原弹窗一致。
 * confirm 与未知 method 保留宿主原始 d_ 弹窗。
 */
function __PwIsQuestionRequest(pwReq) {
	if (!pwReq || !pwReq.method || "confirm" === pwReq.method) return false;
	if ("select" === pwReq.method) {
		var pwOptions = Array.isArray(pwReq.options) ? pwReq.options : [];
		if (__PwDetectSentinel(pwOptions) >= 0) return true;
		return pwOptions.length >= 2;
	}
	if ("input" === pwReq.method || "editor" === pwReq.method) {
		var pwTitle = __PwStrip(pwReq.title);
		var pwPh = String(pwReq.placeholder || "");
		return pwPh.indexOf("custom answer") >= 0
			|| pwTitle.indexOf("Enter the numbers of all that apply") >= 0
			|| pwTitle.indexOf("Type your answer:") >= 0;
	}
	return false;
}

/*
 * __piRich 必须是第一个 JSON key：rpc-fallback.ts 用
 * RICH_SELECTION_PREFIX = '{"__piRich":1' 做 startsWith 判定。
 * attachmentsData 用裸 base64，materializeAttachments 会按魔数落临时文件。
 */
function __PwBuildEnvelope(pwFiles, pwExtra) {
	var pwEnv = {
		__piRich: 1,
		attachments: [],
		attachmentsData: pwFiles.map(function (pwF) {
			return { name: pwF.name, data: pwF.data };
		})
	};
	Object.keys(pwExtra).forEach(function (pwK) {
		pwEnv[pwK] = pwExtra[pwK];
	});
	return JSON.stringify(pwEnv);
}

/* 用 createElement 构造节点，避开 jsx/jsxs 的 children 形态差异。 */
function __PwE(pwTag, pwProps, pwKids) {
	return __PW_REACT__.createElement.apply(null, [pwTag, pwProps].concat(pwKids || []));
}

/*
 * SSR 不跑 effect，也不允许 useLayoutEffect（会告警）。
 * 浏览器用 useLayoutEffect 避免绘制后再跳一帧，服务端退回 useEffect。
 */
var pwUseIsoLayoutEffect = "undefined" == typeof window ? __PW_REACT__.useEffect : __PW_REACT__.useLayoutEffect;

/*
 * 从卡片节点向上找最近的可滚动祖先，把它置底。
 * 宿主的消息列是 div[ref:tn].overflow-y-auto，命中后设 scrollTop=scrollHeight。
 * 抽成纯函数便于 verify.js 用假 DOM 验证。
 */
function __PwScrollContainerToBottom(pwNode) {
	if (!pwNode || "undefined" == typeof window) return false;
	var pwAncestor = pwNode.parentElement;
	while (pwAncestor) {
		var pwOverflow = window.getComputedStyle(pwAncestor).overflowY;
		if ("auto" === pwOverflow || "scroll" === pwOverflow) {
			pwAncestor.scrollTop = pwAncestor.scrollHeight;
			return true;
		}
		pwAncestor = pwAncestor.parentElement;
	}
	return false;
}

function __PwRichQuestion(pwProps) {
	var pwRequest = pwProps.request;
	var pwWaiting = pwProps.waitingCount;
	var pwRespond = pwProps.onRespond;
	var pwMethod = pwRequest && pwRequest.method;
	var pwOptions = Array.isArray(pwRequest && pwRequest.options) ? pwRequest.options : [];
	var pwSentinel = "select" === pwMethod ? __PwDetectSentinel(pwOptions) : -1;
	var pwTitle = __PwStripNav(pwRequest && pwRequest.title);

	/*
	 * 多题导航：扩展在标题里放 [Q i/n #session]。
	 * 同一题重发时标题不变，按标题缓存的草稿就能回填。
	 * 新 session 表示另一次 ask_user_question 调用，清空旧草稿。
	 */
	var pwNav = __PwNavMeta(pwRequest);
	var pwIsMulti = !!(pwNav && pwNav.multi);
	var pwKey = pwNav ? __PwStripNav(pwRequest && pwRequest.title).trim() : null;
	if (pwNav && __PW_NAV_CACHE.session !== pwNav.session) {
		__PW_NAV_CACHE.session = pwNav.session;
		__PW_NAV_CACHE.byTitle = {};
	}
	var pwCached = pwKey ? __PW_NAV_CACHE.byTitle[pwKey] : null;

	var pwTextState = (0, __PW_REACT__.useState)(
		pwCached ? pwCached.text
			: ("input" === pwMethod || "editor" === pwMethod ? String((pwRequest && pwRequest.prefill) || "") : "")
	);
	var pwText = pwTextState[0];
	var pwSetText = pwTextState[1];

	/* 单选：选项与「其他」互斥高亮；多选：勾选项存索引数组。 */
	var pwChoiceState = (0, __PW_REACT__.useState)(pwCached ? pwCached.choice : null);
	var pwChoice = pwChoiceState[0];
	var pwSetChoice = pwChoiceState[1];

	var pwSelectedState = (0, __PW_REACT__.useState)(pwCached ? pwCached.selected || [] : []);
	var pwSelected = pwSelectedState[0];
	var pwSetSelected = pwSelectedState[1];

	var pwFilesState = (0, __PW_REACT__.useState)(pwCached ? pwCached.files || [] : []);
	var pwFiles = pwFilesState[0];
	var pwSetFiles = pwFilesState[1];
	/* ref 是附件的唯一真源：FileReader 异步完成后立即写入，
	   不等 React 重渲染，避免刚粘贴就提交时漏掉附件。 */
	var pwFilesRef = (0, __PW_REACT__.useRef)(pwCached ? pwCached.files || [] : []);

	/* 必答：未选且未输入时禁用「下一题 →」与「提交」，⌘↵ 同样受控。 */
	var pwHasText = pwText.trim().length > 0;
	var pwHasAnswer = pwIsMulti
		? (pwSelected.length > 0 || pwHasText)
		: ("select" === pwMethod
			? (!!pwChoice && ("option" === pwChoice.kind || pwHasText))
			: pwHasText);
	var pwCanSubmit = pwHasAnswer || pwFilesRef.current.length > 0;

	var pwPreviewState = (0, __PW_REACT__.useState)(null);
	var pwPreview = pwPreviewState[0];
	var pwSetPreview = pwPreviewState[1];

	var pwErrorState = (0, __PW_REACT__.useState)("");
	var pwError = pwErrorState[0];
	var pwSetError = pwErrorState[1];

	var pwPickerRef = (0, __PW_REACT__.useRef)(null);
	var pwCardRef = (0, __PW_REACT__.useRef)(null);

	/*
	 * 答后置底。旧卡片卸载时 scrollHeight 变小，浏览器把 scrollTop 收敛；
	 * 下一题挂载时 scrollHeight 变大但 scrollTop 不回补，卡片落在视口之外。
	 * 依赖 request.id：只在题目切换时执行一次，不打断用户中途上滚看历史。
	 * rAF 二次校正覆盖图片 / chip 引起的后续高度变化。
	 */
	(0, pwUseIsoLayoutEffect)(function () {
		function pwToBottom() {
			__PwScrollContainerToBottom(pwCardRef.current);
		}
		pwToBottom();
		if ("undefined" == typeof requestAnimationFrame) return;
		var pwFrame = requestAnimationFrame(pwToBottom);
		return function () { cancelAnimationFrame(pwFrame); };
	}, [pwRequest && pwRequest.id]);

	/*
	 * 捕获阶段拦截图片粘贴。只处理含 image/* 的剪贴板内容。
	 * 阻止默认行为并阻断后续监听，聊天输入框文字不变。
	 */
	function pwAddFiles(pwList) {
		var pwIncoming = Array.prototype.slice.call(pwList || []).filter(function (pwF) {
			return pwF && pwF.type && pwF.type.indexOf("image/") === 0;
		});
		if (!pwIncoming.length) return;
		var pwRoom = __PW_MAX_FILES - pwFilesRef.current.length;
		if (pwRoom <= 0) {
			pwSetError("附件数量已达上限 " + __PW_MAX_FILES);
			return;
		}
		var pwSkipped = 0;
		pwSetError("");
		pwIncoming.slice(0, pwRoom).forEach(function (pwF) {
			if (pwF.size > __PW_MAX_BYTES) {
				pwSkipped++;
				return;
			}
			var pwReader = new FileReader();
			pwReader.onload = function () {
				var pwUrl = String(pwReader.result || "");
				var pwComma = pwUrl.indexOf(",");
				var pwItem = {
					name: pwF.name || "pasted-image.png",
					/* rpc-fallback.ts 期望裸 base64，去掉 data:image/...;base64, 前缀 */
					data: pwComma >= 0 ? pwUrl.slice(pwComma + 1) : pwUrl,
					url: pwUrl
				};
				if (pwFilesRef.current.length >= __PW_MAX_FILES) return;
				pwFilesRef.current = pwFilesRef.current.concat([pwItem]);
				pwSetFiles(pwFilesRef.current);
			};
			pwReader.readAsDataURL(pwF);
		});
		if (pwSkipped > 0) pwSetError("单张图片超过 2MB，已跳过 " + pwSkipped + " 张");
	}

	(0, __PW_REACT__.useEffect)(function () {
		function pwOnPaste(pwEvt) {
			var pwItems = pwEvt.clipboardData && pwEvt.clipboardData.items
				? Array.prototype.slice.call(pwEvt.clipboardData.items)
				: [];
			var pwImgs = pwItems.filter(function (pwIt) {
				return pwIt && pwIt.type && pwIt.type.indexOf("image/") === 0;
			}).map(function (pwIt) {
				return pwIt.getAsFile();
			}).filter(function (pwF) {
				return !!pwF;
			});
			if (!pwImgs.length) return;
			pwEvt.preventDefault();
			pwEvt.stopPropagation();
			if (pwEvt.stopImmediatePropagation) pwEvt.stopImmediatePropagation();
			pwAddFiles(pwImgs);
		}
		document.addEventListener("paste", pwOnPaste, true);
		return function () {
			document.removeEventListener("paste", pwOnPaste, true);
		};
	}, []);

	/*
	 * 预览关闭：Esc 优先级必须高于宿主的全局监听和卡片自身的 React onKeyDown。
	 * 捕获阶段 + stopImmediatePropagation 可阻止后续所有同名监听。
	 */
	(0, __PW_REACT__.useEffect)(function () {
		if (pwPreview === null) return;
		function pwOnKey(pwEvt) {
			if ("Escape" !== pwEvt.key) return;
			pwEvt.preventDefault();
			pwEvt.stopPropagation();
			if (pwEvt.stopImmediatePropagation) pwEvt.stopImmediatePropagation();
			pwSetPreview(null);
		}
		document.addEventListener("keydown", pwOnKey, true);
		return function () {
			document.removeEventListener("keydown", pwOnKey, true);
		};
	}, [pwPreview]);

	
	/* 无附件时回退纯字符串，保持原有回答解析路径。 */
	function pwReply(pwExtra, pwFallback) {
		if (!pwRequest) return;
		if (pwFilesRef.current.length === 0) {
			pwRespond(pwRequest, { value: pwFallback });
			return;
		}
		pwRespond(pwRequest, { value: __PwBuildEnvelope(pwFilesRef.current, pwExtra) });
	}

	/* 提交或回退前保存草稿，回到本题时恢复选项、勾选项、输入与附件。 */
	function pwSaveDraft() {
		if (!pwKey) return;
		__PW_NAV_CACHE.byTitle[pwKey] = {
			choice: pwChoice,
			selected: pwSelected,
			text: pwText,
			files: pwFilesRef.current
		};
	}

	/* 「← 上一题」只发导航信封，不当成答案。扩展收到后回退题号并重发上一题。 */
	function pwBack() {
		if (!pwNav || !pwNav.canBack || !pwRequest) return;
		pwSaveDraft();
		pwRespond(pwRequest, { value: __PwBuildEnvelope([], { nav: "back" }) });
	}

	function pwPickOption(pwIdx, pwRaw) {
		pwSetChoice({ kind: "option", idx: pwIdx, raw: pwRaw });
	}

	/* 多选：点一次勾上，再点一次取消；不立即提交。 */
	function pwToggleMulti(pwIdx) {
		pwSetSelected(function (pwPrev) {
			return pwPrev.indexOf(pwIdx) >= 0
				? pwPrev.filter(function (pwI) { return pwI !== pwIdx; })
				: pwPrev.concat([pwIdx]);
		});
	}

	function pwOnText(pwValue) {
		pwSetText(pwValue);
		if ("select" !== pwMethod) return;
		pwSetChoice(pwValue.trim().length > 0 ? { kind: "other" } : null);
	}

	function pwSubmit() {
		if (!pwCanSubmit) return;
		pwSaveDraft();
		if (pwIsMulti) {
			/* 多选结果无法用单个选项行表达，无附件也发信封。 */
			if (pwRequest) pwRespond(pwRequest, {
				value: __PwBuildEnvelope(pwFilesRef.current, { selected: pwSelected, other: pwText })
			});
			return;
		}
		if ("select" !== pwMethod) {
			pwReply({ value: pwText }, pwText);
			return;
		}
		if (!pwChoice) {
			/* 允许只提交附件；带附件时走信封，不会被判成取消 */
			if (pwFilesRef.current.length === 0) return;
			pwReply({ other: "" }, "");
			return;
		}
		if ("option" === pwChoice.kind) {
			pwReply({ option: pwChoice.raw }, pwChoice.raw);
			return;
		}
		/* 空纯字符串会被扩展判定为取消，必须拦截 */
		if (pwText.trim().length === 0 && pwFilesRef.current.length === 0) return;
		pwReply({ other: pwText }, pwText);
	}

	function pwCancel() {
		if (pwRequest) pwRespond(pwRequest, { cancelled: true });
	}

	function pwRemoveFile(pwIdx) {
		pwFilesRef.current = pwFilesRef.current.filter(function (pwF, pwI) {
			return pwI !== pwIdx;
		});
		pwSetFiles(pwFilesRef.current);
	}

	var pwKids = [];

	/* 标题区。preview 块由扩展拼进 title，用 pre-wrap 保留排版。 */
	pwKids.push(__PwE("div", {
		style: {
			padding: "12px 14px 10px",
			borderBottom: "1px solid var(--border)",
			display: "flex",
			alignItems: "flex-start",
			gap: 10
		}
	}, [
		__PwE("div", {
			style: {
				flex: 1,
				minWidth: 0,
				fontSize: 14,
				fontWeight: 650,
				lineHeight: 1.5,
				whiteSpace: "pre-wrap",
				overflowWrap: "anywhere",
				maxHeight: "38vh",
				overflowY: "auto"
			}
		}, [pwTitle]),
		pwNav && pwNav.total > 1
			? __PwE("span", {
				"data-pw-step": (pwNav.index + 1) + "/" + pwNav.total,
				style: { flex: "none", fontSize: 11, color: "var(--text-dim)", paddingTop: 3 }
			}, [(pwNav.index + 1) + " / " + pwNav.total])
			: null,
		pwWaiting && pwWaiting > 1
			? __PwE("div", {
				style: { flex: "none", fontSize: 11, color: "var(--text-dim)", paddingTop: 3 }
			}, ["待处理 " + pwWaiting])
			: null
	]));

	var pwBody = [];

	/* 选项：单选圆圈、多选方框 + label + description。哨兵项不渲染为按钮。 */
	if ("select" === pwMethod) {
		pwOptions.forEach(function (pwRaw, pwIdx) {
			if (pwIdx === pwSentinel) return;
			var pwOpt = __PwParseOption(pwRaw);
			var pwChecked = pwIsMulti
				? pwSelected.indexOf(pwIdx) >= 0
				: !!(pwChoice && "option" === pwChoice.kind && pwChoice.idx === pwIdx);
			pwBody.push(__PwE("button", {
				key: "opt-" + pwIdx,
				type: "button",
				"data-pw-option": pwIdx,
				"data-pw-control": pwIsMulti ? "checkbox" : "radio",
				"data-pw-checked": pwChecked ? "1" : "0",
				"data-pw-selected": pwChecked ? "1" : "0",
				"aria-pressed": pwChecked ? "true" : "false",
				onClick: function () {
					if (pwIsMulti) { pwToggleMulti(pwIdx); return; }
					pwPickOption(pwIdx, pwRaw);
				},
				style: {
					display: "flex",
					alignItems: "flex-start",
					width: "100%",
					textAlign: "left",
					boxSizing: "border-box",
					padding: "9px 11px",
					marginBottom: 7,
					border: "1px solid " + (pwChecked ? "var(--accent)" : "var(--border)"),
					boxShadow: pwChecked ? "0 0 0 1px var(--accent)" : "none",
					borderRadius: 8,
					background: "var(--bg-panel)",
					color: "var(--text)",
					cursor: "pointer"
				}
			}, [
				__PwE("span", {
					"data-pw-mark": pwIsMulti ? "checkbox" : "radio",
					"aria-hidden": "true",
					style: {
						flex: "none",
						width: 15,
						height: 15,
						marginTop: 2,
						marginRight: 9,
						boxSizing: "border-box",
						border: "1.5px solid " + (pwChecked ? "var(--accent)" : "var(--text-muted)"),
						borderRadius: pwIsMulti ? 4 : 8,
						background: pwChecked ? "var(--accent)" : "transparent",
						boxShadow: pwChecked && !pwIsMulti ? "inset 0 0 0 3px var(--bg-panel)" : "none",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--accent-contrast)",
						fontSize: 11,
						lineHeight: 1
					}
				}, [pwChecked && pwIsMulti ? "✓" : null]),
				__PwE("div", { style: { flex: 1, minWidth: 0 } }, [
					__PwE("div", {
						style: { fontSize: 13, fontWeight: 600, lineHeight: 1.45, overflowWrap: "anywhere" }
					}, [pwOpt.number ? pwOpt.number + " " + pwOpt.label : pwOpt.label]),
					pwOpt.desc
						? __PwE("div", {
							style: {
								marginTop: 3,
								fontSize: 12,
								lineHeight: 1.5,
								color: "var(--text-muted)",
								whiteSpace: "pre-wrap",
								overflowWrap: "anywhere"
							}
						}, [pwOpt.desc])
						: null
				])
			]));
		});
	}

	/* 「其他」内联输入；Enter 换行，⌘/Ctrl+Enter 由卡片级监听提交。 */
	var pwIsOther = "select" === pwMethod;
	var pwOtherActive = pwIsMulti ? pwHasText : !!(pwChoice && "other" === pwChoice.kind);
	pwBody.push(__PwE("textarea", {
		key: "other-input",
		"data-pw-other": "1",
		"data-pw-other-active": pwOtherActive ? "1" : "0",
		"aria-label": pwIsOther ? "其他" : "回答",
		placeholder: pwIsOther ? "其他" : String((pwRequest && pwRequest.placeholder) || "回答"),
		value: pwText,
		rows: pwIsOther ? 2 : 3,
		spellCheck: false,
		onChange: function (pwEvt) { pwOnText(pwEvt.target.value); },
		style: {
			display: "block",
			width: "100%",
			boxSizing: "border-box",
			resize: "vertical",
			padding: "9px 11px",
			fontSize: 13,
			lineHeight: 1.5,
			fontFamily: "inherit",
			color: "var(--text)",
			background: "var(--bg)",
			border: "1px solid " + (pwOtherActive ? "var(--accent)" : "var(--border)"),
			boxShadow: pwOtherActive ? "0 0 0 1px var(--accent)" : "none",
			borderRadius: 8,
			outline: "none"
		}
	}));

	/* 附件：文件选择 + 已添加图片 chip。chip 点击打开全屏预览。 */
	pwBody.push(__PwE("input", {
		key: "picker",
		ref: pwPickerRef,
		type: "file",
		accept: "image/*",
		multiple: true,
		style: { display: "none" },
		onChange: function (pwEvt) {
			pwAddFiles(pwEvt.target.files);
			pwEvt.target.value = "";
		}
	}));

	var pwChips = pwFiles.map(function (pwF, pwIdx) {
		return __PwE("span", {
			key: "chip-" + pwIdx,
			role: "button",
			tabIndex: 0,
			"aria-label": "预览 " + pwF.name,
			onClick: function () { pwSetPreview(pwF); },
			onKeyDown: function (pwEvt) {
				if ("Enter" === pwEvt.key || " " === pwEvt.key) {
					pwEvt.preventDefault();
					pwSetPreview(pwF);
				}
			},
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				maxWidth: 190,
				padding: "3px 6px",
				border: "1px solid var(--border)",
				borderRadius: 6,
				background: "var(--bg-panel)",
				fontSize: 11,
				cursor: "zoom-in"
			}
		}, [
			__PwE("img", {
				src: pwF.url,
				alt: pwF.name,
				style: { width: 22, height: 22, objectFit: "cover", borderRadius: 3, flex: "none" }
			}),
			__PwE("span", {
				style: {
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
					maxWidth: 120
				}
			}, [pwF.name]),
			__PwE("button", {
				type: "button",
				"aria-label": "移除 " + pwF.name,
				onClick: function (pwEvt) {
					pwEvt.stopPropagation();
					pwRemoveFile(pwIdx);
				},
				style: {
					flex: "none",
					border: "none",
					background: "transparent",
					color: "var(--text-muted)",
					cursor: "pointer",
					fontSize: 14,
					lineHeight: 1,
					padding: "0 2px"
				}
			}, ["×"])
		]);
	});

	pwBody.push(__PwE("div", {
		key: "attachments",
		style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 9 }
	}, [
		__PwE("button", {
			type: "button",
			onClick: function () { if (pwPickerRef.current) pwPickerRef.current.click(); },
			style: {
				padding: "5px 10px",
				fontSize: 12,
				border: "1px solid var(--border)",
				borderRadius: 6,
				background: "var(--bg-panel)",
				color: "var(--text)",
				cursor: "pointer"
			}
		}, ["选择图片"])
	].concat(pwChips)));

	if (pwError) {
		pwBody.push(__PwE("div", {
			key: "error",
			role: "alert",
			style: { marginTop: 7, fontSize: 11, color: "var(--text-muted)" }
		}, [pwError]));
	}

	pwKids.push(__PwE("div", {
		style: { padding: "11px 14px" }
	}, pwBody));

	/* 底部操作区。快捷键只放在 title 里，不增加可见说明文字。 */
	pwKids.push(__PwE("div", {
		style: {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8,
			padding: "10px 14px",
			borderTop: "1px solid var(--border)"
		}
	}, [
		pwNav && pwNav.canBack
			? __PwE("button", {
				type: "button",
				"data-pw-back": "1",
				onClick: pwBack,
				style: {
					padding: "6px 12px",
					marginRight: "auto",
					fontSize: 12,
					border: "1px solid var(--border)",
					borderRadius: 6,
					background: "transparent",
					color: "var(--text-muted)",
					cursor: "pointer"
				}
			}, ["← 上一题"])
			: null,
		__PwE("button", {
			type: "button",
			onClick: pwCancel,
			style: {
				padding: "6px 14px",
				fontSize: 12,
				border: "1px solid var(--border)",
				borderRadius: 6,
				background: "transparent",
				color: "var(--text-muted)",
				cursor: "pointer"
			}
		}, ["取消"]),
		pwNav && pwNav.index < pwNav.total - 1
			? __PwE("button", {
				type: "button",
				"data-pw-next": "1",
				"data-pw-disabled": pwCanSubmit ? "0" : "1",
				disabled: !pwCanSubmit,
				title: "⌘↵ 提交并进入下一题",
				onClick: pwSubmit,
				style: {
					padding: "6px 16px",
					fontSize: 12,
					fontWeight: 600,
					border: "1px solid var(--accent)",
					borderRadius: 6,
					background: "var(--accent)",
					color: "var(--accent-contrast)",
					opacity: pwCanSubmit ? 1 : 0.45,
					cursor: pwCanSubmit ? "pointer" : "not-allowed"
				}
			}, ["下一题 →"])
			: __PwE("button", {
				type: "button",
				"data-pw-submit": "1",
				"data-pw-disabled": pwCanSubmit ? "0" : "1",
				disabled: !pwCanSubmit,
				title: "⌘↵ 提交",
				onClick: pwSubmit,
				style: {
					padding: "6px 16px",
					fontSize: 12,
					fontWeight: 600,
					border: "1px solid var(--accent)",
					borderRadius: 6,
					background: "var(--accent)",
					color: "var(--accent-contrast)",
					opacity: pwCanSubmit ? 1 : 0.45,
					cursor: pwCanSubmit ? "pointer" : "not-allowed"
				}
			}, ["提交"])
	]));

	var pwCard = __PwE("div", {
		ref: pwCardRef,
		role: "dialog",
		"data-pw-card": "1",
		"data-pw-version": "4",
		"aria-label": pwTitle,
		style: {
			width: "100%",
			boxSizing: "border-box",
			margin: "12px 0 24px",
			border: "1px solid var(--border)",
			borderRadius: 10,
			background: "var(--bg)",
			color: "var(--text)",
			boxShadow: "0 8px 28px rgba(0,0,0,.12)",
			overflow: "hidden"
		},
		onKeyDown: function (pwEvt) {
			if ("Escape" === pwEvt.key && !pwEvt.nativeEvent.isComposing && pwPreview === null) {
				pwEvt.preventDefault();
				pwEvt.stopPropagation();
				pwCancel();
				return;
			}
			/* ⌘/Ctrl+↵ 提到卡片级：选中选项后可直接提交并进入下一题。 */
			if ("Enter" === pwEvt.key && (pwEvt.metaKey || pwEvt.ctrlKey)
				&& !pwEvt.nativeEvent.isComposing && pwPreview === null) {
				pwEvt.preventDefault();
				pwEvt.stopPropagation();
				pwSubmit();
			}
		}
	}, pwKids);

	/*
	 * 只有图片预览 portal 到 body。卡片本身保留在消息列内。
	 * 背景点击 / × / Esc 三种关闭方式。
	 */
	var pwLightbox = pwPreview === null
		? null
		: (0, __PwReactDom.createPortal)(__PwE("div", {
			"aria-label": "图片预览",
			onClick: function () { pwSetPreview(null); },
			style: {
				position: "fixed",
				inset: 0,
				zIndex: 9999,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: 24,
				background: "rgba(0,0,0,.78)",
				cursor: "zoom-out"
			}
		}, [
			__PwE("img", {
				src: pwPreview.url,
				alt: pwPreview.name,
				onClick: function (pwEvt) { pwEvt.stopPropagation(); },
				style: {
					maxWidth: "100%",
					maxHeight: "100%",
					objectFit: "contain",
					borderRadius: 6,
					boxShadow: "0 20px 60px rgba(0,0,0,.5)",
					cursor: "default"
				}
			}),
			__PwE("button", {
				type: "button",
				"aria-label": "关闭预览",
				title: "关闭预览 (Esc)",
				onClick: function (pwEvt) {
					pwEvt.stopPropagation();
					pwSetPreview(null);
				},
				style: {
					position: "absolute",
					top: 18,
					right: 22,
					width: 36,
					height: 36,
					borderRadius: 18,
					border: "1px solid rgba(255,255,255,.35)",
					background: "rgba(0,0,0,.45)",
					color: "#fff",
					fontSize: 20,
					lineHeight: "32px",
					cursor: "pointer"
				}
			}, ["×"])
		]), document.body);

	return __PwE(__PW_REACT__.Fragment, {}, [pwCard, pwLightbox]);
}
