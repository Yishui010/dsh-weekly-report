/** 一次性检查：工作区筛选与记录读写（不启动服务）。走 junction 路径运行。 */
const mod = await import('./lib/index.js');
const T = mod.__weeklyTest;
const week = T.weekKeyOf(new Date());
const config = T.loadConfig();

const all = T.activityFor(week, { ...config, workspaces: [] });
const seen = T.workspacesSeen(week, config);
console.log(`周 ${week}（${all.range}）`);
console.log(`全部工作区：${all.sessions.length} 个会话，${seen.length} 个工作区`);
for (const item of seen.slice(0, 8)) console.log(`  - ${item.project}  ${item.cwd}  ${item.sessions}`);

const target = seen[0]?.cwd;
if (target) {
  const scoped = T.activityFor(week, { ...config, workspaces: [target] });
  const key = T.pathKey(target);
  const bad = scoped.sessions.filter((s) => {
    const cwd = T.pathKey(s.cwd);
    return !(cwd === key || cwd.startsWith(`${key}/`));
  });
  console.log(`限定 ${target}：${scoped.sessions.length} 个会话（全部工作区 ${all.sessions.length}）`);
  console.log(`越界会话：${bad.length}（应为 0）`);
  if (bad.length) process.exitCode = 1;
  if (scoped.sessions.length > all.sessions.length) process.exitCode = 1;
}

console.log(`notes 字段：${Array.isArray(all.notes) ? `数组（${all.notes.length} 条）` : '不是数组'}`);
if (!Array.isArray(all.notes)) process.exitCode = 1;
