window.__ModuleLoader__.load({
	id: "dsh-plugin-weekly",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// The host composition guarantees this module when dsh.client.inject lists it.
		try {
			require("@deepseek-ai/dsh-client-runtime");
		} catch (error) {
			console.warn("[weekly] client runtime not available:", error?.message ?? error);
		}

		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useState } = React;

		const API = "/weekly/api";
		const PANEL_ID = "weekly";

		const S = {
			wrap: {
				display: "flex",
				flexDirection: "column",
				gap: "14px",
				fontSize: "13px",
				lineHeight: 1.5,
				padding: "20px 24px 32px",
				boxSizing: "border-box",
				width: "100%",
				maxWidth: "900px",
				margin: "0 auto",
				height: "100%",
				overflowY: "auto",
			},
			row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			col: { display: "flex", flexDirection: "column", gap: "6px" },
			card: {
				border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
				borderRadius: "8px",
				padding: "10px 12px",
				display: "flex",
				flexDirection: "column",
				gap: "8px",
			},
			title: { fontSize: "13px", fontWeight: 600, margin: 0 },
			hint: { fontSize: "12px", opacity: 0.65 },
			chip: {
				borderRadius: "999px",
				padding: "1px 8px",
				fontSize: "11px",
				border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
				opacity: 0.9,
			},
			chipOk: { borderColor: "color-mix(in srgb, #22c55e 60%, transparent)", color: "#16a34a" },
			chipBad: { borderColor: "color-mix(in srgb, #ef4444 60%, transparent)", color: "#dc2626" },
			btn: {
				border: "1px solid color-mix(in srgb, currentColor 28%, transparent)",
				borderRadius: "6px",
				padding: "4px 12px",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				fontSize: "12px",
			},
			btnPrimary: {
				border: "1px solid color-mix(in srgb, #2563eb 60%, transparent)",
				background: "color-mix(in srgb, #2563eb 16%, transparent)",
				borderRadius: "6px",
				padding: "4px 12px",
				color: "inherit",
				cursor: "pointer",
				fontSize: "12px",
				fontWeight: 600,
			},
			input: {
				border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
				borderRadius: "6px",
				padding: "5px 8px",
				background: "transparent",
				color: "inherit",
				fontSize: "13px",
				fontFamily: "inherit",
				lineHeight: 1.5,
				width: "100%",
				boxSizing: "border-box",
			},
			area: {
				border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
				borderRadius: "6px",
				padding: "8px",
				background: "transparent",
				color: "inherit",
				fontSize: "13px",
				fontFamily: "inherit",
				lineHeight: 1.6,
				width: "100%",
				boxSizing: "border-box",
				resize: "vertical",
			},
			pre: {
				margin: 0,
				padding: "10px",
				borderRadius: "6px",
				border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
				background: "color-mix(in srgb, currentColor 5%, transparent)",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				fontSize: "12.5px",
				fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
				maxHeight: "320px",
				overflow: "auto",
			},
			error: {
				border: "1px solid color-mix(in srgb, #ef4444 55%, transparent)",
				background: "color-mix(in srgb, #ef4444 10%, transparent)",
				borderRadius: "6px",
				padding: "6px 10px",
				fontSize: "12px",
				whiteSpace: "pre-wrap",
			},
			ok: {
				border: "1px solid color-mix(in srgb, #22c55e 55%, transparent)",
				background: "color-mix(in srgb, #22c55e 10%, transparent)",
				borderRadius: "6px",
				padding: "6px 10px",
				fontSize: "12px",
				whiteSpace: "pre-wrap",
			},
			label: { fontSize: "11.5px", opacity: 0.7 },
			divider: {
				height: "1px",
				background: "color-mix(in srgb, currentColor 12%, transparent)",
				margin: "2px 0",
			},
		};

		async function call(path, body, method) {
			const response = await fetch(`${API}${path}`, {
				method: method ?? (body === undefined ? "GET" : "POST"),
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok) {
				throw new Error(payload?.error ?? `HTTP ${response.status}`);
			}
			if (payload && payload.ok === false) throw new Error(payload.error ?? "请求失败");
			return payload;
		}

		function Chip(props) {
			const style = props.good === undefined ? S.chip : props.good ? { ...S.chip, ...S.chipOk } : { ...S.chip, ...S.chipBad };
			return h("span", { style }, props.children);
		}

		function Button(props) {
			return h(
				"button",
				{
					type: "button",
					style: props.primary ? S.btnPrimary : S.btn,
					disabled: props.disabled,
					onClick: props.onClick,
					title: props.title,
				},
				props.children,
			);
		}

		function Field(props) {
			return h(
				"label",
				{ style: S.col },
				h("span", { style: S.label }, props.label),
				h("input", {
					style: S.input,
					value: props.value,
					placeholder: props.placeholder,
					onChange: (event) => props.onChange(event.target.value),
				}),
			);
		}

		/** Sidebar rail icon for the main panel entry. */
		function WeeklyIcon({ size = 16, active = false }) {
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: active ? 2 : 1.7,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					style: { display: "block", opacity: active ? 1 : 0.8 },
					"aria-hidden": "true",
				},
				h("rect", { x: 4, y: 3, width: 16, height: 18, rx: 2.5 }),
				h("path", { d: "M8 8.5h8M8 12.5h8M8 16.5h4.5" }),
			);
		}

		function Panel() {
			const [state, setState] = useState(null);
			const [week, setWeek] = useState(null);
			const [draft, setDraft] = useState("");
			const [draftDirty, setDraftDirty] = useState(false);
			const [noteText, setNoteText] = useState("");
			const [editingAt, setEditingAt] = useState(null);
			const [editText, setEditText] = useState("");
			const [notes, setNotes] = useState([]);
			const [busy, setBusy] = useState("");
			const [error, setError] = useState("");
			const [notice, setNotice] = useState("");
			const [preview, setPreview] = useState(null);
			const [config, setConfig] = useState(null);
			const [showSettings, setShowSettings] = useState(false);

			/**
			 * 应用服务端快照，并保证手工记录列表一定拿得到：
			 * 老版本宿主 /state 不带 notes 时退回读 /activity。
			 */
			const applyState = useCallback((next) => {
				setState(next);
				if (!week && next?.week) setWeek(next.week);
				if (typeof next?.draft === "string") {
					setDraft(next.draft);
					setDraftDirty(false);
				}
				if (next?.config) setConfig(next.config);
				if (Array.isArray(next?.notes)) {
					setNotes(next.notes);
					return;
				}
				const target = next?.week ?? week;
				if (!target) return;
				call("/activity", { week: target })
					.then((activity) => setNotes(Array.isArray(activity?.notes) ? activity.notes : []))
					.catch(() => setNotes([]));
			}, [week]);

			const load = useCallback(
				async (nextWeek) => {
					setError("");
					try {
						const query = nextWeek ? `?week=${encodeURIComponent(nextWeek)}` : "";
						const next = await call(`/state${query}`);
						if (nextWeek) setWeek(next.week);
						applyState(next);
					} catch (loadError) {
						setError(String(loadError?.message ?? loadError));
					}
				},
				[applyState],
			);

			useEffect(() => {
				load(undefined);
			}, [load]);

			const run = useCallback(async (label, work) => {
				setBusy(label);
				setError("");
				setNotice("");
				try {
					await work();
				} catch (taskError) {
					setError(String(taskError?.message ?? taskError));
				} finally {
					setBusy("");
				}
			}, []);

			const onWeekChange = useCallback(
				(value) => {
					if (draftDirty && !window.confirm("当前草稿有未保存的修改，切换周会丢弃它们，继续？")) return;
					setPreview(null);
					setWeek(value);
					load(value);
				},
				[draftDirty, load],
			);

			const onGenerate = useCallback(() => {
				run("正在收集本周活动并生成周报…", async () => {
					const next = await call("/generate", { week });
					applyState(next);
					setPreview(null);
					setNotice(`已生成草稿（${next?.stats?.sessions ?? 0} 个会话，${next?.stats?.notes ?? 0} 条手工记录）`);
				});
			}, [applyState, run, week]);

			const onSaveDraft = useCallback(() => {
				run("保存中…", async () => {
					const next = await call("/draft", { week, markdown: draft });
					applyState(next);
					setNotice("草稿已保存");
				});
			}, [applyState, draft, run, week]);

			const onAddNote = useCallback(() => {
				const text = noteText.trim();
				if (!text) return;
				run("添加记录中…", async () => {
					const next = await call("/notes", { text, week });
					applyState(next);
					setNoteText("");
					setNotice("已记录");
				});
			}, [applyState, noteText, run, week]);

			const onDeleteNote = useCallback(
				(at) => {
					run("删除中…", async () => {
						const next = await call("/notes/delete", { at, week });
						applyState(next);
						setEditingAt(null);
					});
				},
				[applyState, run, week],
			);

			const onStartEditNote = useCallback((note) => {
				setEditingAt(note.at);
				setEditText(note.text);
			}, []);

			const onCancelEditNote = useCallback(() => {
				setEditingAt(null);
				setEditText("");
			}, []);

			const onSaveEditNote = useCallback(() => {
				const text = editText.trim();
				if (!text || editingAt === null) return;
				run("保存修改…", async () => {
					const next = await call("/notes/update", { at: editingAt, text, week });
					applyState(next);
					setEditingAt(null);
					setEditText("");
					setNotice("记录已更新");
				});
			}, [applyState, editText, editingAt, run, week]);

			const onPreview = useCallback(() => {
				run("准备邮件预览…", async () => {
					const result = await call("/preview", { week, markdown: draft });
					setPreview(result);
				});
			}, [draft, run, week]);

			const onSend = useCallback(
				(dryRun) => {
					run(dryRun ? "试运行（不实际发送）…" : "正在发送邮件…", async () => {
						const result = await call("/send", { week, markdown: draft, dryRun });
						setPreview(null);
						setNotice(
							dryRun
								? "试运行通过：参数合法，未实际发送。"
								: `已发送给 ${(result?.mail?.to ?? []).join("、") || "收件人"}`,
						);
					});
				},
				[draft, run, week],
			);

			const onSaveConfig = useCallback(() => {
				run("保存设置…", async () => {
					const next = await call("/config", { config, week });
					applyState(next);
					setNotice("设置已保存");
				});
			}, [applyState, config, run, week]);

			const counts = state?.counts ?? { sessions: 0, notes: 0, projects: [] };
			const weeks = state?.weeks ?? [];
			const rangeText = state?.range ? `${state.range.fromText} ~ ${state.range.toText}` : "";
			const wecom = state?.wecom;

			return h(
				"div",
				{ style: S.wrap },
				h(
					"div",
					{ style: S.row },
					h("span", { style: { ...S.title, fontSize: "14px" } }, "周报"),
					h("span", { style: S.hint }, "汇总本周 DSH 会话 + 手工记录 → 生成四段式周报 → 用企业微信邮件发给领导"),
				),

				error ? h("div", { style: S.error }, error) : null,
				notice ? h("div", { style: S.ok }, notice) : null,

				h(
					"div",
					{ style: S.card },
					h(
						"div",
						{ style: S.row },
						h("span", { style: S.label }, "周"),
						h(
							"select",
							{
								style: { ...S.input, width: "auto", minWidth: "230px" },
								value: week ?? "",
								onChange: (event) => onWeekChange(event.target.value),
							},
							weeks.length === 0 ? h("option", { value: week ?? "" }, week ?? "载入中…") : null,
							weeks.map((entry) => h("option", { key: entry.week, value: entry.week }, entry.label)),
						),
						h("span", { style: S.hint }, rangeText),
						h(Button, { onClick: () => load(week), title: "重新读取磁盘上的会话与记录" }, "刷新"),
					),
					h(
						"div",
						{ style: S.row },
						h(Chip, null, `本周会话 ${counts.sessions}`),
						h(Chip, null, `手工记录 ${counts.notes}`),
						h(
							Chip,
							{ good: !(config?.workspaces ?? []).length },
							(config?.workspaces ?? []).length
								? `工作区 ${config.workspaces.length}/${(state?.workspaces ?? []).length || config.workspaces.length}`
								: "全部工作区",
						),
						counts.projects?.length
							? h(
									Chip,
									null,
									`项目 ${counts.projects.slice(0, 4).map((item) => `${item.project}×${item.count}`).join("、")}${counts.projects.length > 4 ? "…" : ""}`,
								)
							: null,
						h(Chip, { good: wecom?.authorized === true }, wecom?.authorized ? "企业微信已授权" : "企业微信未授权"),
					),
					wecom && !wecom.authorized
						? h(
								"div",
								{ style: S.hint },
								`发送前需要在终端完成一次登录：wecom-cli auth init（当前状态：${wecom.detail || "未授权"}）`,
							)
						: null,
				),

				h(
					"div",
					{ style: S.card },
					h(
						"div",
						{ style: S.row },
						h("span", { style: S.title }, "草稿"),
						h(Button, { primary: true, onClick: onGenerate, disabled: Boolean(busy) }, "生成草稿"),
						h(Button, { onClick: onSaveDraft, disabled: Boolean(busy) || !draftDirty }, "保存草稿"),
						h(Button, { onClick: onPreview, disabled: Boolean(busy) || !draft.trim() }, "预览邮件"),
						h("span", { style: S.hint }, draft ? `${draft.length} 字符${draftDirty ? "（未保存）" : ""}` : "还没有草稿"),
					),
					h("textarea", {
						style: { ...S.area, minHeight: "300px" },
						value: draft,
						placeholder: "点「生成草稿」由模型写；也可以直接粘贴/手写。发送前一定要自己读一遍。",
						onChange: (event) => {
							setDraft(event.target.value);
							setDraftDirty(true);
						},
					}),
				),

				preview
					? h(
							"div",
							{ style: S.card },
							h("div", { style: S.title }, "邮件预览"),
							h(
								"div",
								{ style: S.col },
								h("div", null, h("span", { style: S.label }, "收件人："), preview.to.join("、")),
								h(
									"div",
									null,
									h("span", { style: S.label }, "抄送："),
									preview.cc.length ? preview.cc.join("、") : "（无）",
								),
								h("div", null, h("span", { style: S.label }, "主题："), preview.subject),
							),
							h("pre", { style: S.pre }, preview.body),
							h(
								"div",
								{ style: S.row },
								h(Button, { primary: true, onClick: () => onSend(false), disabled: Boolean(busy) }, "确认发送"),
								h(Button, { onClick: () => onSend(true), disabled: Boolean(busy) }, "试运行（不发送）"),
								h(Button, { onClick: () => setPreview(null) }, "取消"),
								h("span", { style: S.hint }, `正文 ${preview.chars} 字符`),
							),
						)
					: null,

				h(
					"div",
					{ style: S.card },
					h(
						"div",
						{ style: S.row },
						h("span", { style: S.title }, "手工记录（DSH 以外的工作，平时随手记）"),
						h("span", { style: S.hint }, `本周 ${notes.length} 条`),
					),
					h(
						"div",
						{ style: S.row },
						h("textarea", {
							style: { ...S.area, minHeight: "54px", flex: "1 1 320px" },
							value: noteText,
							placeholder: "例：和供应商对完 X 模块的验收口径；评审 Y 方案；线上 Z 故障复盘",
							onChange: (event) => setNoteText(event.target.value),
						}),
						h(Button, { primary: true, onClick: onAddNote, disabled: Boolean(busy) || !noteText.trim() }, "添加记录"),
					),
					notes.length === 0
						? h("div", { style: S.hint }, "本周还没有手工记录。")
						: h(
								"div",
								{ style: S.col },
								notes.map((note) =>
									editingAt === note.at
										? h(
												"div",
												{ key: note.at, style: S.col },
												h("textarea", {
													style: { ...S.area, minHeight: "54px" },
													value: editText,
													autoFocus: true,
													onChange: (event) => setEditText(event.target.value),
													onKeyDown: (event) => {
														if (event.key === "Escape") onCancelEditNote();
														if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) onSaveEditNote();
													},
												}),
												h(
													"div",
													{ style: S.row },
													h(Button, { primary: true, onClick: onSaveEditNote, disabled: Boolean(busy) || !editText.trim() }, "保存修改"),
													h(Button, { onClick: onCancelEditNote }, "取消"),
													h("span", { style: S.hint }, "Ctrl+Enter 保存，Esc 取消"),
												),
											)
										: h(
												"div",
												{ key: note.at, style: { ...S.row, alignItems: "flex-start", gap: "10px" } },
												h("span", { style: { ...S.hint, minWidth: "86px" } }, new Date(note.at).toLocaleString()),
												h("span", { style: { flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, note.text),
												h(Button, { onClick: () => onStartEditNote(note), disabled: Boolean(busy) }, "编辑"),
												h(Button, { onClick: () => onDeleteNote(note.at), disabled: Boolean(busy) }, "删除"),
											),
								),
							),
				),

				h(
					"div",
					{ style: S.card },
					h(
						"div",
						{ style: S.row },
						h("span", { style: S.title }, "设置"),
						h(Button, { onClick: () => setShowSettings((value) => !value) }, showSettings ? "收起" : "展开"),
						h("span", { style: S.hint }, state?.storageDir ?? ""),
					),
					showSettings && config
						? h(
								"div",
								{ style: S.col },
								h(Field, {
									label: "收件人（逗号分隔）",
									value: (config.to ?? []).join(", "),
									onChange: (value) =>
										setConfig({ ...config, to: value.split(/[,;\s]+/).filter(Boolean) }),
								}),
								h(Field, {
									label: "抄送（逗号分隔）",
									value: (config.cc ?? []).join(", "),
									onChange: (value) =>
										setConfig({ ...config, cc: value.split(/[,;\s]+/).filter(Boolean) }),
								}),
								h(Field, {
									label: "主题模板（可用 {range} {week} {name}）",
									value: config.subjectTemplate,
									onChange: (value) => setConfig({ ...config, subjectTemplate: value }),
								}),
								h(Field, {
									label: "署名（正文末尾）",
									value: config.signature,
									onChange: (value) => setConfig({ ...config, signature: value }),
								}),
								h(
									"div",
									{ style: S.row },
									h(Field, {
										label: "模型 provider（留空用 DSH 默认）",
										value: config.provider,
										onChange: (value) => setConfig({ ...config, provider: value }),
									}),
									h(Field, {
										label: "模型 model（留空用 DSH 默认）",
										value: config.model,
										onChange: (value) => setConfig({ ...config, model: value }),
									}),
								),
								h("label", { style: S.col },
									h("span", { style: S.label }, "额外写作要求（可选）"),
									h("textarea", {
										style: { ...S.area, minHeight: "64px", fontFamily: "inherit" },
										value: config.extraPrompt,
										onChange: (event) => setConfig({ ...config, extraPrompt: event.target.value }),
									}),
								),
								h(
									"div",
									{ style: S.col },
									h("span", { style: S.label }, "生成草稿时收集哪些工作区"),
									h(
										"label",
										{ style: { ...S.row, gap: "6px", cursor: "pointer" } },
										h("input", {
											type: "checkbox",
											checked: !(config.workspaces ?? []).length,
											onChange: (event) => {
												if (event.target.checked) setConfig({ ...config, workspaces: [] });
											},
										}),
										h("span", null, "全部工作区（默认）"),
									),
									(state?.workspaces ?? []).map((workspace) => {
										const list = config.workspaces ?? [];
										const checked = list.some(
											(item) => item.toLowerCase() === workspace.cwd.toLowerCase(),
										);
										return h(
											"label",
											{
												key: workspace.cwd,
												style: { ...S.row, gap: "6px", cursor: "pointer", alignItems: "baseline" },
											},
											h("input", {
												type: "checkbox",
												checked,
												onChange: (event) => {
													const keys = new Set(list.map((item) => item.toLowerCase()));
													if (event.target.checked) keys.add(workspace.cwd.toLowerCase());
													else keys.delete(workspace.cwd.toLowerCase());
													const next = [];
													for (const item of state?.workspaces ?? []) {
														if (keys.has(item.cwd.toLowerCase())) next.push(item.cwd);
													}
													for (const item of list) {
														if (keys.has(item.toLowerCase()) && !next.includes(item)) next.push(item);
													}
													setConfig({ ...config, workspaces: next });
												},
											}),
											h("span", null, workspace.project),
											h("span", { style: S.hint }, workspace.cwd),
											h("span", { style: S.hint }, `${workspace.sessions} 个会话`),
										);
									}),
									h(
										"span",
										{ style: S.hint },
										(config.workspaces ?? []).length
											? "只从勾选的工作区收集 DSH 会话；全不勾 = 全部。"
											: "当前收集全部工作区的会话。",
									),
								),
								h(
									"div",
									{ style: S.row },
									h(Button, { primary: true, onClick: onSaveConfig, disabled: Boolean(busy) }, "保存设置"),
								),
							)
						: null,
				),

				busy ? h("div", { style: S.hint }, busy) : null,
			);
		}

		function apply(ctx) {
			const disposers = [];
			const own = (dispose) => {
				if (typeof dispose === "function") disposers.push(dispose);
				return dispose;
			};
			try {
				// 主面板：侧边栏图标点开后在主列显示的面板
				own(
					ctx.slots.inject("main", () =>
						ctx.slots.register({ name: "main", key: PANEL_ID }, Panel),
					),
				);
				// 侧边栏图标行：id 必须与上面 main 的 key 一致
				own(
					ctx.slots.inject("sidebar.panellist", () =>
						ctx.slots.register(
							{ name: "sidebar.panellist", id: PANEL_ID, order: 12, label: "周报" },
							WeeklyIcon,
						),
					),
				);
				return async () => {
					for (const dispose of disposers.splice(0).reverse()) {
						try {
							dispose();
						} catch (error) {
							console.warn("[weekly] dispose failed:", error);
						}
					}
				};
			} catch (error) {
				console.error("[weekly] slot registration failed:", error);
				throw error;
			}
		}

		module.exports.apply = apply;
		module.exports.inject = ["slots"];
		module.exports.name = "weekly";

		return module.exports;
	}
});
