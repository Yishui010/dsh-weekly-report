/**
 * 冒烟测试：验证宿主入口能在 profile 的 node_modules 下解析依赖、周区间计算正确。
 * 用法（必须走 junction 路径 + --preserve-symlinks，让 bare import 解析到 profile 的依赖）：
 *   node --preserve-symlinks "%USERPROFILE%\.dsh\profiles\tauri\node_modules\dsh-plugin-weekly\smoke.mjs"
 */
import assert from 'node:assert/strict';

const mod = await import('./lib/index.js');
const T = mod.__weeklyTest;

assert.equal(mod.name, 'weekly');
assert.deepEqual(mod.inject, ['webServer', 'llm', 'agentDefaultModel']);
assert.equal(typeof mod.apply, 'function');

// 独立实现（基于 UTC 的 ISO 周）作为对照
function isoWeekOracle(date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const isoDay = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  day.setUTCDate(day.getUTCDate() + 4 - isoDay);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const samples = [
  new Date(2026, 9, 26),
  new Date(2026, 0, 1),
  new Date(2026, 0, 4),
  new Date(2026, 11, 31),
  new Date(2025, 11, 29),
  new Date(2026, 6, 4),
];

for (const sample of samples) {
  const week = T.weekKeyOf(sample);
  assert.equal(week, isoWeekOracle(sample), `weekKeyOf(${sample.toDateString()})`);

  const { from, end } = T.weekRange(week);
  assert.equal(from.getDay(), 1, `${week} 起点必须是周一`);
  assert.equal(from.getHours(), 0, `${week} 起点必须是 00:00`);
  assert.equal(from.getMinutes(), 0);
  assert.equal(end - from, 7 * 86400000, `${week} 区间必须是 7 天`);
  assert.equal(T.weekKeyOf(from), week, `${week} 起点自洽`);
  assert.equal(T.weekKeyOf(new Date(end - 1)), week, `${week} 终点自洽`);
  assert.match(T.weekRangeText(week), /^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/);
}

const weeks = T.listWeeks(4);
assert.equal(weeks.length, 4, '列表长度');
assert.equal(weeks[0].week, T.weekKeyOf(new Date()), '第一条是本周');
for (const entry of weeks) {
  assert.match(entry.label, /^\d{4}-W\d{2}（\d{2}-\d{2} ~ \d{2}-\d{2}）$/);
  assert.match(entry.fromText, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(entry.toText, /^\d{4}-\d{2}-\d{2}$/);
}
assert.equal(new Set(weeks.map((entry) => entry.week)).size, 4, '周 key 不重复');

assert.equal(T.normalizeWeek('2026-W44'), '2026-W44');
assert.equal(T.normalizeWeek(' 2026-W7 '), '2026-W07', '补零');
assert.equal(T.normalizeWeek('乱七八糟'), T.weekKeyOf(new Date()), '非法输入回退本周');

const mail = T.buildMail(
  {
    to: ['lead@example.com'],
    cc: ['me@example.com'],
    subjectTemplate: '周报｜{name}｜{week}（{range}）',
    signature: '张三',
  },
  '2026-W43',
  '## 本周完成\n- 做了点事',
);
assert.equal(mail.subject, '周报｜张三｜2026-W43（2026-10-19 ~ 2026-10-25）');
assert.ok(mail.body.startsWith('## 本周完成'));
assert.ok(mail.body.trimEnd().endsWith('张三'), '正文结尾必须是署名');
assert.deepEqual(mail.to, ['lead@example.com']);
assert.deepEqual(mail.cc, ['me@example.com']);

const emptyTemplate = T.buildMail({ to: ['a@b.com'], cc: [], subjectTemplate: '', signature: '张三' }, '2026-W43', 'x');
assert.equal(emptyTemplate.subject, '周报（2026-10-19 ~ 2026-10-25）', '主题模板为空时的兜底');

assert.ok(T.isEmail('lead@example.com'));
assert.ok(!T.isEmail('jamie@xupai'));
assert.ok(!T.isEmail('jamie at xupai.com'));

// 工作区筛选：空列表 = 全部；否则按目录前缀大小写不敏感匹配
assert.deepEqual(T.pathList(['E:\\a', 'E:\\a\\', 'e:/A', ' ', 'E:\\b']), ['E:\\a', 'E:\\b']);
assert.equal(T.inWorkspaces('D:\\work\\demo', []), true, '空配置 = 全部工作区');
assert.equal(T.inWorkspaces('D:\\work\\demo\\src', ['D:\\work\\demo']), true, '大小写与分隔符不敏感');
assert.equal(T.inWorkspaces('D:\\work\\demo2', ['D:\\work\\demo']), false, '不能把前缀相同的邻居算进来');
assert.equal(T.inWorkspaces('', ['D:\\work\\demo']), false, '没有 cwd 的会话被排除');

const normalized = T.normalizeConfig({ workspaces: ['D:\\work\\demo', 'D:\\work\\demo\\'], to: 'a@b.com' });
assert.deepEqual(normalized.workspaces, ['D:\\work\\demo']);
assert.deepEqual(normalized.to, ['a@b.com']);
assert.deepEqual(T.normalizeConfig({}).workspaces, [], '默认全部工作区');

const onDisk = T.loadConfig();
assert.ok(Array.isArray(onDisk.workspaces), 'config.json 里的 workspaces 必须是数组');

console.log(`smoke ok — 周区间/周序列/邮件封装/工作区筛选均通过（当前周 ${T.weekKeyOf(new Date())}）`);
