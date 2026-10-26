/**
 * 端到端检查：在临时端口上跑真实路由，验证「记录可见/可改」与「工作区筛选」。
 * 会临时写 ~/.dsh/storages/weekly 下的 config.json 与 notes.jsonl，结束后完整还原。
 * 用法：node --preserve-symlinks <profile 里 junction 下的这个文件>
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const mod = await import('./lib/index.js');
const T = mod.__weeklyTest;

const storage = join(homedir(), '.dsh', 'storages', 'weekly');
const configFile = join(storage, 'config.json');
const notesFile = join(storage, 'notes.jsonl');
const before = {
  config: existsSync(configFile) ? readFileSync(configFile, 'utf8') : null,
  notes: existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : null,
};

let handler = null;
const ctx = {
  webServer: {
    register({ handler: h }) {
      handler = h;
      return () => {};
    },
  },
  on() {},
  onDispose() {},
};
mod.apply(ctx);
assert.equal(typeof handler, 'function', '应注册 /weekly/api 处理器');

const server = http.createServer((req, res) => handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/weekly/api`;

const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const get = async (path) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
};

const week = T.weekKeyOf(new Date());
const all = await get(`/state?week=${week}`);
assert.equal(all.status, 200);
assert.ok(Array.isArray(all.body.notes), '/state 必须返回 notes 数组');
assert.ok(Array.isArray(all.body.workspaces), '/state 必须返回 workspaces 数组');
assert.ok(Array.isArray(all.body.sessions), '/state 必须返回 sessions 数组');
const baseline = all.body.counts.sessions;
console.log(`基线：本周 ${baseline} 个会话 / ${all.body.notes.length} 条记录 / ${all.body.workspaces.length} 个工作区`);

// 1) 添加后立即可见
const added = await post('/notes', { text: '临时检查记录（可删）', week });
assert.equal(added.status, 200);
const created = added.body.notes.find((note) => note.text === '临时检查记录（可删）');
assert.ok(created, '刚添加的记录必须出现在返回的 notes 里');
console.log(`添加后可见：${added.body.notes.length} 条`);

// 2) 可修改
const updated = await post('/notes/update', { at: created.at, text: '临时检查记录（已改）', week });
assert.equal(updated.status, 200);
assert.equal(updated.body.updated, 1);
assert.ok(
  updated.body.notes.some((note) => note.at === created.at && note.text === '临时检查记录（已改）'),
  '修改必须落盘并回显',
);
console.log('修改回显 OK');

// 3) 可删除
const removed = await post('/notes/delete', { at: created.at, week });
assert.equal(removed.status, 200);
assert.equal(removed.body.removed, 1);
assert.ok(!removed.body.notes.some((note) => note.at === created.at), '删除后不应再出现');
console.log('删除回显 OK');

// 4) 工作区筛选
const seen = all.body.workspaces;
if (seen.length >= 2) {
  const target = seen[seen.length - 1].cwd; // 挑一个会话数较少的
  const config = JSON.parse(JSON.stringify(all.body.config));
  config.workspaces = [target];
  const saved = await post('/config', { config, week });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.config.workspaces, [target]);
  assert.ok(saved.body.counts.sessions < baseline, `限定 ${target} 后会话数应下降`);
  const scoped = saved.body.sessions;
  const key = T.pathKey(target);
  assert.ok(
    scoped.every((session) => {
      const cwd = T.pathKey(session.cwd);
      return cwd === key || cwd.startsWith(`${key}/`);
    }),
    '限定工作区后不应混入别的目录',
  );
  console.log(`工作区筛选 OK：${baseline} → ${saved.body.counts.sessions}（限定 ${target}）`);
} else {
  console.log('工作区不足 2 个，跳过筛选断言');
}

// 5) /activity 与 /state 的记录一致
const activity = await post('/activity', { week });
assert.equal(activity.status, 200);
assert.deepEqual(
  activity.body.notes.map((note) => note.at),
  all.body.notes.map((note) => note.at),
  '/activity 与 /state 的记录必须一致',
);
console.log('接口一致性 OK');

await new Promise((resolve) => server.close(resolve));

const restore = (file, content) => {
  if (content === null) {
    if (existsSync(file)) rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, content, 'utf8');
};
restore(configFile, before.config);
restore(notesFile, before.notes);

console.log('api check ok');
