/**
 * dsh-plugin-weekly — host half.
 *
 * Responsibilities:
 *  - read the current ISO week's desktop DSH sessions from the session metadata cache;
 *  - read manually recorded work items (JSONL notes);
 *  - assemble one model prompt, ask the configured model for a four-section report;
 *  - keep drafts on disk so they can be edited before sending;
 *  - send the reviewed draft through `wecom-cli mail send` (WeCom mail is the only
 *    channel that can reach an arbitrary address; the bot chat channel is limited to
 *    the authorized user and the recent-20 conversations).
 *
 * HTTP surface (registered on the DSH web server, same origin as the GUI):
 *   GET  /weekly/api/state?week=YYYY-Www
 *   POST /weekly/api/config        { config }
 *   POST /weekly/api/notes         { text, week }
 *   POST /weekly/api/notes/delete  { at, week }
 *   POST /weekly/api/activity      { week }            -> collected activity (preview)
 *   POST /weekly/api/generate      { week }            -> draft markdown
 *   POST /weekly/api/draft         { week, markdown }
 *   POST /weekly/api/preview       { week }            -> mail envelope preview
 *   POST /weekly/api/send          { week, dryRun }
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';

export const name = 'weekly';
export const inject = ['webServer', 'llm', 'agentDefaultModel'];

const PLUGIN_ID = 'dsh-plugin-weekly';
const LOG_PREFIX = '[weekly]';

const SESSION_LIMIT = 28;
const TURN_LIMIT = 9;
const PROMPT_CHAR_BUDGET = 42000;
const WECOM_TTL_MS = 60 * 1000;
const SCAN_TTL_MS = 60 * 1000;

/* ------------------------------------------------------------------ storage */

function storageDir() {
  return join(homedir(), '.dsh', 'storages', 'weekly');
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function configPath() {
  return join(storageDir(), 'config.json');
}

function notesPath() {
  return join(storageDir(), 'notes.jsonl');
}

function draftPath(week) {
  return join(ensureDir(join(storageDir(), 'drafts')), `${week}.md`);
}

function outboxPath(week) {
  return join(ensureDir(join(storageDir(), 'outbox')), `${week}.md`);
}

const DEFAULT_CONFIG = {
  to: [],
  cc: [],
  subjectTemplate: '周报（{range}）',
  signature: '',
  provider: '',
  model: '',
  extraPrompt: '',
  weeksBack: 6,
  workspaces: [],
};

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    return normalizeConfig({ ...DEFAULT_CONFIG, ...raw });
  } catch {
    return normalizeConfig({ ...DEFAULT_CONFIG });
  }
}

function normalizeConfig(input) {
  const config = { ...DEFAULT_CONFIG, ...(input ?? {}) };
  return {
    to: toEmailList(config.to),
    cc: toEmailList(config.cc),
    subjectTemplate: String(config.subjectTemplate || DEFAULT_CONFIG.subjectTemplate),
    signature: String(config.signature ?? ''),
    provider: String(config.provider ?? ''),
    model: String(config.model ?? ''),
    extraPrompt: String(config.extraPrompt ?? ''),
    weeksBack: clampInt(config.weeksBack, 4, 26, DEFAULT_CONFIG.weeksBack),
    workspaces: pathList(config.workspaces),
  };
}

/** Absolute-ish directory list: trimmed, deduped, case-insensitive on Windows. */
function pathList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\r\n;]+/);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const text = String(item ?? '').trim().replace(/[\\/]+$/, '');
    if (!text) continue;
    const key = pathKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function pathKey(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Empty workspace list means "every workspace". */
function inWorkspaces(cwd, workspaces) {
  if (!workspaces.length) return true;
  const key = pathKey(cwd);
  if (!key) return false;
  return workspaces.some((workspace) => {
    const target = pathKey(workspace);
    return Boolean(target) && (key === target || key.startsWith(`${target}/`));
  });
}

function saveConfig(input) {
  const config = normalizeConfig(input);
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}

function toEmailList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;\s]+/);
  const out = [];
  for (const item of list) {
    const text = String(item ?? '').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function isEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/* -------------------------------------------------------------------- notes */

function appendNote(text, at = Date.now()) {
  ensureDir(storageDir());
  appendFileSync(notesPath(), `${JSON.stringify({ at, text })}\n`, 'utf8');
}

function readNotes() {
  let raw = '';
  try {
    raw = readFileSync(notesPath(), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const entry = JSON.parse(text);
      if (!Number.isFinite(entry?.at) || typeof entry?.text !== 'string') continue;
      out.push({ at: entry.at, text: entry.text });
    } catch {
      /* torn or hand-edited line: ignore */
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function writeNotes(notes) {
  ensureDir(storageDir());
  writeFileSync(
    notesPath(),
    notes.map((note) => JSON.stringify(note)).join('\n') + (notes.length ? '\n' : ''),
    'utf8',
  );
}

function deleteNote(at) {
  const notes = readNotes();
  const kept = notes.filter((note) => note.at !== at);
  writeNotes(kept);
  return notes.length - kept.length;
}

function updateNote(at, text) {
  const notes = readNotes();
  const target = notes.find((note) => note.at === at);
  if (!target) return 0;
  target.text = text;
  writeNotes(notes);
  return 1;
}

function notesInRange(fromMs, toMs) {
  return readNotes().filter((note) => note.at >= fromMs && note.at < toMs);
}

/* -------------------------------------------------------------------- weeks */

function pad2(value) {
  return String(value).padStart(2, '0');
}

function fmtDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function fmtShort(date) {
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function fmtTime(ms) {
  const date = new Date(ms);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** ISO week key (Monday-based) of a local date. */
function weekKeyOf(date) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(utc.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((utc.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${pad2(week)}`;
}

function normalizeWeek(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-W(\d{1,2})$/.exec(text);
  if (!match) return weekKeyOf(new Date());
  const year = Number(match[1]);
  const week = clampInt(match[2], 1, 53, 1);
  return `${year}-W${pad2(week)}`;
}

/** Local Monday 00:00 .. next Monday 00:00 for an ISO week key. */
function weekRange(week) {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(week);
  const year = match ? Number(match[1]) : new Date().getFullYear();
  const index = match ? clampInt(match[2], 1, 53, 1) : 1;
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const monday = new Date(year, 0, 4 - (jan4Day - 1) + (index - 1) * 7, 0, 0, 0, 0);
  const end = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7, 0, 0, 0, 0);
  return { from: monday, end };
}

function listWeeks(count) {
  const weeks = [];
  const cursor = new Date();
  for (let index = 0; index < count; index += 1) {
    const key = weekKeyOf(cursor);
    if (!weeks.some((entry) => entry.week === key)) {
      const { from, end } = weekRange(key);
      weeks.push({
        week: key,
        fromText: fmtDate(from),
        toText: fmtDate(new Date(end.getTime() - 86400000)),
        label: `${key}（${fmtShort(from)} ~ ${fmtShort(new Date(end.getTime() - 86400000))}）`,
      });
    }
    cursor.setDate(cursor.getDate() - 7);
  }
  return weeks;
}

function weekRangeText(week) {
  const { from, end } = weekRange(week);
  return `${fmtDate(from)} ~ ${fmtDate(new Date(end.getTime() - 86400000))}`;
}

/* ----------------------------------------------------------------- activity */

function sessionCacheDir() {
  return join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function stripEllipsis(text) {
  return String(text ?? '').replace(/…$/, '');
}

let scanCache = { key: '', at: 0, value: null };

function collectSessions(fromMs, toMs) {
  const key = `${fromMs}:${toMs}`;
  if (scanCache.key === key && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.value;

  const dir = sessionCacheDir();
  const sessions = [];
  let scanned = 0;
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      scanned += 1;
      let doc;
      try {
        doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch {
        continue;
      }
      const rows = doc?.record?.rows;
      if (!rows) continue;
      const subagent = rows.subagent?.val;
      if (subagent && typeof subagent === 'object' && Object.keys(subagent).length > 0) continue;
      const meta = rows.sessionListMetadata?.val ?? {};
      if (meta.blank) continue;
      const last = Number(meta.lastPromptAt ?? 0);
      if (!Number.isFinite(last) || last < fromMs || last >= toMs) continue;
      const turns = rows.turnOutline?.val?.turns;
      if (!Array.isArray(turns) || turns.length === 0) continue;
      const cwd = String(rows.workingDirectory?.val || doc?.record?.identity?.cwd || '');
      sessions.push({
        sessionId: file.replace(/^session-/, '').replace(/\.json$/, ''),
        title: String(rows.title?.val || '').trim() || '(未命名会话)',
        project: cwd ? basename(cwd) || cwd : 'unknown',
        cwd,
        lastPromptAt: last,
        turns: turns.map((turn) => ({
          turn: Number(turn?.turn) || 0,
          prompt: clip(stripEllipsis(turn?.prompt), 220),
          response: clip(stripEllipsis(turn?.response), 200),
        })),
      });
    }
  }
  sessions.sort((a, b) => b.lastPromptAt - a.lastPromptAt);
  const value = { sessions, scanned };
  scanCache = { key, at: Date.now(), value };
  return value;
}

function activityFor(week, config = loadConfig()) {
  const { from, end } = weekRange(week);
  const scannedSessions = collectSessions(from.getTime(), end.getTime());
  const workspaces = pathList(config?.workspaces);
  const sessions = scannedSessions.sessions.filter((session) => inWorkspaces(session.cwd, workspaces));
  const notes = notesInRange(from.getTime(), end.getTime());
  const projects = new Map();
  for (const session of sessions) {
    projects.set(session.project, (projects.get(session.project) ?? 0) + 1);
  }
  return {
    week,
    range: weekRangeText(week),
    sessions,
    notes,
    scanned: scannedSessions.scanned,
    filteredByWorkspace: scannedSessions.sessions.length !== sessions.length,
    workspaces,
    projectCounts: [...projects.entries()]
      .map(([project, count]) => ({ project, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Distinct workspaces seen in a week, so settings can offer them as checkboxes. */
function workspacesSeen(week, config = loadConfig()) {
  const { from, end } = weekRange(week);
  const { sessions } = collectSessions(from.getTime(), end.getTime());
  const map = new Map();
  for (const session of sessions) {
    const cwd = String(session.cwd ?? '').trim();
    if (!cwd) continue;
    const key = pathKey(cwd);
    const entry = map.get(key) ?? { cwd, project: session.project, sessions: 0 };
    entry.sessions += 1;
    map.set(key, entry);
  }
  for (const workspace of pathList(config?.workspaces)) {
    const key = pathKey(workspace);
    if (!map.has(key)) map.set(key, { cwd: workspace, project: basename(workspace) || workspace, sessions: 0 });
  }
  return [...map.values()].sort((a, b) => b.sessions - a.sessions);
}

/* ------------------------------------------------------------------- prompt */

const SYSTEM_PROMPT = [
  '你是周报写作助手，服务对象是一位技术负责人（署名见用户消息）。',
  '材料是他这一周在 DSH（他的 AI 编码工作台）里的会话摘要，以及他自己记下的其他工作。',
  '写作要求：',
  '1. 只写材料里能支撑的事实，不编造项目、进度、数字；不确定的写成待确认的推进状态。',
  '2. 合并同类项：同一个项目的多个会话归并成 1-3 条进展，不要逐会话罗列。',
  '3. 不写任何工具过程性指标（会话数、token、耗时、工具调用次数）。读者关心的是事情做到哪一步。',
  '4. 不写空话套话（“持续跟进”“深入优化”“赋能”之类），每条都要有具体对象：哪个项目、哪个模块、做到什么程度。',
  '5. 每条 1-2 行，动词开头。',
  '输出格式（严格遵守，不要加任何前言、结语、代码块）：',
  '## 本周完成',
  '## 当前推进中',
  '## 风险与需要支持',
  '## 下周计划',
  '每节 2-5 条，用「- 」开头；某节确实没有材料支撑时只写「- 暂无」。',
].join('\n');

function buildUserPrompt(week, activity, config) {
  const lines = [];
  lines.push(`时间范围：${activity.range}（${week}）`);
  lines.push(`署名：${config.signature || '(未配置)'}`);
  lines.push('');

  const sessions = activity.sessions.slice(0, SESSION_LIMIT);
  lines.push(
    `## DSH 会话摘要（本周共 ${activity.sessions.length} 个主会话，按最近活动排序，最多取 ${SESSION_LIMIT} 个）`,
  );
  if (activity.projectCounts.length) {
    lines.push(
      `项目分布：${activity.projectCounts.map((item) => `${item.project}(${item.count})`).join('、')}`,
    );
  }
  for (const session of sessions) {
    lines.push('');
    lines.push(`### ${session.project} · ${session.title} · 最后活动 ${fmtTime(session.lastPromptAt)}`);
    for (const turn of session.turns.slice(-TURN_LIMIT)) {
      lines.push(`- 我：${turn.prompt}`);
      if (turn.response) lines.push(`  助手：${turn.response}`);
    }
  }

  lines.push('');
  lines.push('## 我手工记录的其他工作（DSH 以外，或 DSH 内需要强调的）');
  if (activity.notes.length === 0) {
    lines.push('- （本周没有手工记录）');
  } else {
    for (const note of activity.notes) {
      lines.push(`- ${fmtTime(note.at)}：${note.text}`);
    }
  }

  if (config.extraPrompt.trim()) {
    lines.push('');
    lines.push('## 额外要求');
    lines.push(config.extraPrompt.trim());
  }

  let text = lines.join('\n');
  if (text.length > PROMPT_CHAR_BUDGET) {
    text = `${text.slice(0, PROMPT_CHAR_BUDGET)}\n...(材料过长已截断)`;
  }
  return text;
}

/* -------------------------------------------------------------------- model */

function resolveSelection(ctx, config) {
  let fallback = {};
  try {
    fallback = ctx.agentDefaultModel?.currentSelection?.() ?? {};
  } catch {
    fallback = {};
  }
  const provider = config.provider.trim() || String(fallback.provider ?? '');
  const model = config.model.trim() || String(fallback.model ?? '');
  if (!provider || !model) {
    throw new Error('没有可用的模型：请在周报设置里填写 provider/model，或先设置 DSH 默认模型。');
  }
  return { provider, model, reasoningEffort: fallback.reasoningEffort };
}

async function runModel(ctx, config, system, user) {
  const selection = resolveSelection(ctx, config);
  let text = '';
  let failure = null;
  const stream = ctx.llm.stream({
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens: 3200,
  });
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
    } else if (chunk?.type === 'finish') {
      const reason = chunk.reason ?? {};
      if (reason.kind && reason.kind !== 'stop') {
        failure =
          reason.kind === 'error'
            ? `${reason.error?.code ?? 'LLM_ERROR'}: ${reason.error?.message ?? '模型调用失败'}`
            : `模型调用提前结束（${reason.kind}）`;
      }
    }
  }
  const body = text.trim();
  if (!body) throw new Error(failure ?? '模型没有返回内容');
  return stripCodeFence(body);
}

function stripCodeFence(text) {
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text.trim());
  return fenced ? fenced[1].trim() : text;
}

/* ------------------------------------------------------------------- drafts */

function readDraft(week) {
  try {
    return readFileSync(draftPath(week), 'utf8');
  } catch {
    return '';
  }
}

function saveDraft(week, markdown) {
  writeFileSync(draftPath(week), String(markdown ?? ''), 'utf8');
}

/* ---------------------------------------------------------------- wecom CLI */

function cliScriptPath() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'npm', 'node_modules', '@wecom', 'cli', 'bin', 'wecom.js');
}

let cliCache = null;

function runProcess(command, args, { timeoutMs = 60000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      finish({ code: -1, stdout, stderr, error: `命令超时（${timeoutMs}ms）` });
    }, timeoutMs);
    try {
      child = spawn(command, args, {
        windowsHide: true,
        shell: false,
        env: { ...process.env, ...env },
      });
    } catch (error) {
      finish({ code: -1, stdout, stderr, error: String(error?.message ?? error) });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (data) => {
      stdout += data;
    });
    child.stderr?.on('data', (data) => {
      stderr += data;
    });
    child.on('error', (error) => {
      finish({ code: -1, stdout, stderr, error: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      finish({ code: code ?? 0, stdout, stderr });
    });
  });
}

/** Find an executable that can run the WeCom CLI's node entry point with clean argv. */
async function pickCli() {
  if (cliCache) return cliCache;
  const script = cliScriptPath();
  const exeName = basename(process.execPath).toLowerCase();
  const candidates = [];
  if (/^node(\.exe)?$/.test(exeName)) candidates.push({ command: process.execPath, env: {} });
  if (process.versions?.electron) {
    candidates.push({ command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
  }
  candidates.push({ command: 'node.exe', env: {} });
  candidates.push({ command: join(process.execPath, '..', 'node.exe'), env: {} });

  const failures = [];
  for (const candidate of candidates) {
    const probe = await runProcess(candidate.command, [script, '--version'], {
      timeoutMs: 15000,
      env: candidate.env,
    });
    if (probe.code === 0 && /\d+\.\d+/.test(probe.stdout)) {
      cliCache = { script, command: candidate.command, env: candidate.env };
      return cliCache;
    }
    failures.push(
      `${candidate.command}: ${probe.error ?? probe.stderr.trim().slice(0, 120) ?? `退出码 ${probe.code}`}`,
    );
  }
  throw new Error(`无法运行 wecom-cli（未找到可用的 node 解释器）：${failures.join(' | ')}`);
}

async function execCliArgv(argv, { timeoutMs = 60000 } = {}) {
  const cli = await pickCli();
  return runProcess(cli.command, [cli.script, ...argv], { timeoutMs, env: cli.env });
}

let wecomCache = { at: 0, value: null };

async function wecomStatus() {
  if (wecomCache.value && Date.now() - wecomCache.at < WECOM_TTL_MS) return wecomCache.value;
  let value;
  try {
    const result = await execCliArgv(['auth', 'show', '--status'], { timeoutMs: 25000 });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const lowered = text.toLowerCase();
    // 注意："unauthorized" 里也含 "authorized"，必须先排掉否定词。
    const authorized =
      result.code === 0 &&
      !lowered.includes('unauthorized') &&
      !text.includes('未授权') &&
      /(已授权|authoriz|logged[\s-]?in|登录成功)/i.test(text);
    value = {
      available: result.code === 0,
      authorized,
      detail: clip(text, 400) || `退出码 ${result.code}`,
      script: cliScriptPath(),
      node: cliCache?.command ?? null,
    };
  } catch (error) {
    value = {
      available: false,
      authorized: false,
      detail: String(error?.message ?? error),
      script: cliScriptPath(),
      node: null,
    };
  }
  wecomCache = { at: Date.now(), value };
  return value;
}

/* --------------------------------------------------------------------- mail */

function buildMail(config, week, markdown) {
  const range = weekRangeText(week);
  const subject = config.subjectTemplate
    .replace(/\{range\}/g, range)
    .replace(/\{week\}/g, week)
    .replace(/\{name\}/g, config.signature || '周报')
    .trim();
  const body = `${String(markdown ?? '').trim()}\n\n---\n${config.signature}\n`;
  return { subject: subject || `周报（${range}）`, to: config.to, cc: config.cc, body, range };
}

async function sendMail(config, week, markdown, { dryRun = false } = {}) {
  const mail = buildMail(config, week, markdown);
  if (!mail.to.length) throw new Error('没有配置收件人（to）');
  for (const address of [...mail.to, ...mail.cc]) {
    if (!isEmail(address)) throw new Error(`邮箱地址不合法：${address}`);
  }
  const file = outboxPath(week);
  writeFileSync(file, mail.body, 'utf8');
  const argv = [
    'mail',
    'send',
    '--to',
    JSON.stringify({ emails: mail.to }),
    '--subject',
    mail.subject,
    '--file-path',
    file,
    '--content-type',
    'markdown',
  ];
  if (mail.cc.length) argv.push('--cc', JSON.stringify({ emails: mail.cc }));
  if (dryRun) argv.push('--dry-run');

  const result = await execCliArgv(argv, { timeoutMs: 120000 });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (result.code !== 0) {
    return {
      ok: false,
      dryRun,
      mail,
      file,
      error: clip(stderr || stdout || result.error || `退出码 ${result.code}`, 900),
    };
  }
  let payload = null;
  try {
    payload = JSON.parse(stdout);
  } catch {
    payload = null;
  }
  return {
    ok: true,
    dryRun,
    mail,
    file,
    mailId: payload?.mail_id ?? payload?.data?.mail_id ?? null,
    raw: clip(stdout || stderr, 400),
  };
}

/* -------------------------------------------------------------------- routes */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function describeError(error) {
  return String(error?.message ?? error);
}

async function snapshot(ctx, weekInput) {
  const week = normalizeWeek(weekInput);
  const config = loadConfig();
  const { from, end } = weekRange(week);
  let counts = { sessions: 0, notes: 0, projects: [], scanned: 0 };
  let notes = [];
  let sessions = [];
  let workspaces = [];
  try {
    const activity = activityFor(week, config);
    counts = {
      sessions: activity.sessions.length,
      notes: activity.notes.length,
      projects: activity.projectCounts,
      scanned: activity.scanned,
      filteredByWorkspace: activity.filteredByWorkspace,
    };
    notes = activity.notes;
    sessions = activity.sessions;
  } catch (error) {
    counts = { ...counts, error: describeError(error) };
  }
  try {
    workspaces = workspacesSeen(week, config);
  } catch {
    workspaces = [];
  }
  return {
    ok: true,
    now: Date.now(),
    week,
    weeks: listWeeks(config.weeksBack + 2),
    range: {
      fromText: fmtDate(from),
      toText: fmtDate(new Date(end.getTime() - 86400000)),
      fromMs: from.getTime(),
      toMs: end.getTime(),
    },
    config,
    draft: readDraft(week),
    counts,
    notes,
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      project: session.project,
      cwd: session.cwd,
      title: session.title,
      lastPromptAt: session.lastPromptAt,
      turns: session.turns.length,
    })),
    workspaces,
    wecom: await wecomStatus(),
    storageDir: storageDir(),
  };
}

function handleRequest(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/^\/weekly\/api/, '') || '/';

  const run = async () => {
    if (req.method === 'GET' && (path === '/' || path === '/state')) {
      return sendJson(res, 200, await snapshot(ctx, url.searchParams.get('week')));
    }
    if (req.method === 'POST' && path === '/config') {
      const body = await readJsonBody(req);
      saveConfig(body?.config ?? body);
      return sendJson(res, 200, await snapshot(ctx, body?.week));
    }
    if (req.method === 'POST' && path === '/notes') {
      const body = await readJsonBody(req);
      const text = String(body?.text ?? '').trim();
      if (!text) throw new Error('记录内容不能为空');
      appendNote(text);
      return sendJson(res, 200, await snapshot(ctx, body?.week));
    }
    if (req.method === 'POST' && path === '/notes/delete') {
      const body = await readJsonBody(req);
      const removed = deleteNote(Number(body?.at));
      return sendJson(res, 200, { ...(await snapshot(ctx, body?.week)), removed });
    }
    if (req.method === 'POST' && path === '/notes/update') {
      const body = await readJsonBody(req);
      const text = String(body?.text ?? '').trim();
      if (!text) throw new Error('记录内容不能为空');
      const updated = updateNote(Number(body?.at), text);
      return sendJson(res, 200, { ...(await snapshot(ctx, body?.week)), updated });
    }
    if (req.method === 'POST' && path === '/activity') {
      const body = await readJsonBody(req);
      const activity = activityFor(normalizeWeek(body?.week), loadConfig());
      return sendJson(res, 200, {
        ok: true,
        week: activity.week,
        range: activity.range,
        sessions: activity.sessions.map((session) => ({
          project: session.project,
          title: session.title,
          lastPromptAt: session.lastPromptAt,
          turns: session.turns.length,
        })),
        notes: activity.notes,
        projectCounts: activity.projectCounts,
      });
    }
    if (req.method === 'POST' && path === '/generate') {
      const body = await readJsonBody(req);
      const week = normalizeWeek(body?.week);
      const config = loadConfig();
      const activity = activityFor(week, config);
      if (activity.sessions.length === 0 && activity.notes.length === 0) {
        const scope = config.workspaces.length ? `（限定工作区：${config.workspaces.join('、')}）` : '';
        throw new Error(
          `本周（${activity.range}）没有可用的活动记录：DSH 会话与手工记录都是空的。${scope}`,
        );
      }
      const user = buildUserPrompt(week, activity, config);
      const markdown = await runModel(ctx, config, SYSTEM_PROMPT, user);
      saveDraft(week, markdown);
      return sendJson(res, 200, {
        ...(await snapshot(ctx, week)),
        generated: true,
        stats: { sessions: activity.sessions.length, notes: activity.notes.length },
      });
    }
    if (req.method === 'POST' && path === '/draft') {
      const body = await readJsonBody(req);
      const week = normalizeWeek(body?.week);
      saveDraft(week, body?.markdown ?? '');
      return sendJson(res, 200, await snapshot(ctx, week));
    }
    if (req.method === 'POST' && path === '/preview') {
      const body = await readJsonBody(req);
      const week = normalizeWeek(body?.week);
      const config = loadConfig();
      const markdown = String(body?.markdown ?? readDraft(week));
      if (!markdown.trim()) throw new Error('草稿是空的，先生成或粘贴内容');
      const mail = buildMail(config, week, markdown);
      return sendJson(res, 200, {
        ok: true,
        subject: mail.subject,
        to: mail.to,
        cc: mail.cc,
        range: mail.range,
        body: mail.body,
        chars: mail.body.length,
      });
    }
    if (req.method === 'POST' && path === '/send') {
      const body = await readJsonBody(req);
      const week = normalizeWeek(body?.week);
      const config = loadConfig();
      const markdown = String(body?.markdown ?? readDraft(week));
      if (!markdown.trim()) throw new Error('草稿是空的，不能发送');
      const result = await sendMail(config, week, markdown, { dryRun: body?.dryRun === true });
      wecomCache = { at: 0, value: null };
      return sendJson(res, result.ok ? 200 : 502, result);
    }
    return sendJson(res, 404, { ok: false, error: `未知接口 ${req.method} ${path}` });
  };

  run().catch((error) => {
    console.error(`${LOG_PREFIX} request failed:`, error);
    try {
      sendJson(res, 500, { ok: false, error: describeError(error) });
    } catch {
      /* response already gone */
    }
  });
}

/* ---------------------------------------------------------------------- test */

/** Exposed for smoke tests only; not used by the host. */
export const __weeklyTest = {
  weekKeyOf,
  normalizeWeek,
  weekRange,
  weekRangeText,
  listWeeks,
  buildMail,
  sendMail,
  wecomStatus,
  isEmail,
  clip,
  pathList,
  pathKey,
  inWorkspaces,
  normalizeConfig,
  loadConfig,
  activityFor,
  workspacesSeen,
  updateNote,
  readNotes,
};

/* --------------------------------------------------------------------- apply */

export function apply(ctx) {
  const disposers = [];
  const dispose = () => {
    for (const entry of disposers.splice(0).reverse()) {
      try {
        entry();
      } catch (error) {
        console.warn(`${LOG_PREFIX} dispose failed:`, error);
      }
    }
  };
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: '/weekly/api',
      handler: (req, res) => handleRequest(ctx, req, res),
    }),
  );
  if (typeof ctx.on === 'function') ctx.on('dispose', dispose);
  ensureDir(storageDir());
  console.log(`${LOG_PREFIX} ready (${PLUGIN_ID}); storage ${storageDir()}`);
}
