/**
 * 巡演授权对账状态机端到端测试（Node + fake-indexeddb，不进浏览器）。
 * 直接跑：node --import data:text/javascript,console.log() 不行，故用 esbuild 先打包再执行（见 package 脚本外手动流程）。
 *
 * 覆盖：
 * 1. 授权书限定地区/日期/场次；两队合起来占同一份额度，超额判 over-quota。
 * 2. 排场次预占 held；回执导入转 performed 并冻结依据。
 * 3. 重复回执 / 整批重复文件不重复占额度。
 * 4. 授权更新后未演场次按新范围核对、已演批次保留原依据。
 * 5. 导入失败整批回滚、恢复原额度、保留待核对批次；重开继续处理成功。
 * 6. 旧剧目缺授权书 → no-auth 待补。
 */
import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import { useTourStore } from '../src/stores/tourStore';
import { db } from '../src/utils/db';
import { buildPlayRecons } from '../src/utils/tourRecon';
import { missingHeaders, parseSheet, validateAuthRow, validateReceiptRow, validateScheduleRow } from '../src/utils/tourImport';

let passed = 0;
function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}
const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function verdictOf(playTitle: string, showDate: string): string {
  const { authorizations, performances, playTitleById } = useTourStore.getState();
  const recons = buildPlayRecons(authorizations, performances, playTitleById);
  const recon = recons.find((item) => item.playTitle === playTitle);
  assert.ok(recon, `应存在剧目对账单：${playTitle}`);
  const row = recon.rows.find((item) => item.performance.showDate === showDate);
  assert.ok(row, `应存在场次：${playTitle} ${showDate}`);
  return row.verdict;
}

function countByState(): Record<string, number> {
  const { performances } = useTourStore.getState();
  const acc: Record<string, number> = { held: 0, performed: 0, cancelled: 0 };
  performances.forEach((p) => {
    acc[p.state] += 1;
  });
  return acc;
}

const AUTH_CSV = [
  '授权书号,剧目,地区,开始日期,结束日期,场次额度,发证机关,备注',
  'AUTH-01,借伞,陕西·西安,2026-10-01,2026-12-31,5,管理处,测试',
].join('\n');

const SCHEDULE_CSV = [
  '批次,分队,日期,地区,戏台,剧目',
  '秋巡,甲队,2026-10-08,陕西·西安,易俗社,借伞',
  '秋巡,乙队,2026-10-09,陕西·西安,易俗社,借伞',
  '秋巡,甲队,2026-10-10,陕西·西安,易俗社,借伞',
  '秋巡,乙队,2026-10-11,陕西·西安,易俗社,借伞',
  '秋巡,甲队,2026-10-12,陕西·西安,易俗社,借伞',
  '秋巡,乙队,2026-10-13,陕西·西安,易俗社,借伞',
].join('\n');

test('1. 两队合起来 6 场，额度 5：前 5 场内、第 6 场判超额', async () => {
  const store = useTourStore.getState();
  const authRes = await store.importFile('auth', 'auth.csv', AUTH_CSV);
  assert.equal(authRes.status, 'success' && (authRes as { status: string }).status, '授权书导入成功');
  const schedRes = await store.importFile('schedule', 'sched.csv', SCHEDULE_CSV);
  assert.equal(schedRes.status, 'success', '排期导入成功');

  // 按日期排队：10-08~10-12 在额度内，10-13 超额
  assert.equal(verdictOf('借伞', '2026-10-08'), 'ok');
  assert.equal(verdictOf('借伞', '2026-10-12'), 'ok');
  assert.equal(verdictOf('借伞', '2026-10-13'), 'over-quota');

  const { authorizations, performances } = useTourStore.getState();
  const held = performances.filter((p) => p.state === 'held');
  assert.equal(held.length, 6, '六场均为预占');
  const active = authorizations.filter((a) => a.status === 'active');
  assert.equal(active.length, 1);
});

test('2. 越区 / 超期 判越范围；无授权旧剧目列待补', async () => {
  const store = useTourStore.getState();
  const csv = [
    '批次,分队,日期,地区,戏台,剧目',
    '南行,甲队,2026-11-01,河南·洛阳,洛阳戏楼,借伞',
    '明年,甲队,2027-02-01,陕西·西安,易俗社,借伞',
    '老戏,乙队,2026-11-05,陕西·西安,易俗社,老腔老戏',
  ].join('\n');
  const res = await store.importFile('schedule', 'extra.csv', csv);
  assert.equal(res.status, 'success');
  assert.equal(verdictOf('借伞', '2026-11-01'), 'out-of-scope-region');
  assert.equal(verdictOf('借伞', '2027-02-01'), 'out-of-scope-date');
  assert.equal(verdictOf('老腔老戏', '2026-11-05'), 'no-auth');
});

test('3. 回执转已用并冻结依据；重复回执不重复占；重复文件整批跳过', async () => {
  const store = useTourStore.getState();
  const receiptCsv = [
    '回执号,日期,地区,戏台,剧目',
    'HZ-1,2026-10-08,陕西·西安,易俗社,借伞',
    'HZ-2,2026-10-09,陕西·西安,易俗社,借伞',
  ].join('\n');
  const res = await store.importFile('receipt', 'receipt.csv', receiptCsv);
  assert.equal(res.status, 'success', res.message);

  const states = countByState();
  assert.equal(states.performed, 2, '两场转已用');
  // 已演两场先占额度：剩余 5-2=3 个预占位，10-10/11/12 ok，10-13 仍超额
  assert.equal(verdictOf('借伞', '2026-10-10'), 'ok');
  assert.equal(verdictOf('借伞', '2026-10-13'), 'over-quota');

  // 已演场次冻结依据
  const { performances } = useTourStore.getState();
  const performed = performances.filter((p) => p.state === 'performed');
  assert.ok(performed.every((p) => p.basis && p.basis.docNo === 'AUTH-01'), '冻结 AUTH-01 依据');
  assert.ok(performed.every((p) => p.receiptNo?.startsWith('HZ-')), '回填回执号');

  // 同文件再次导入：整批识别为已成功 → duplicated，不新增已用
  const again = await store.importFile('receipt', 'receipt.csv', receiptCsv);
  assert.equal(again.status, 'success');
  assert.equal((again as { duplicated?: boolean }).duplicated, true, '整批重复被跳过');
  assert.equal(countByState().performed, 2, '已用数量不变');

  // 只重复其中一条回执号（换文件名）：该条跳过，仍不占额度
  const dupOne = await store.importFile(
    'receipt',
    'receipt-copy.csv',
    ['回执号,日期,地区,戏台,剧目', 'HZ-1,2026-10-08,陕西·西安,易俗社,借伞'].join('\n'),
  );
  assert.equal(dupOne.status, 'success');
  assert.match(dupOne.results[0].action ?? '', /重复/);
  assert.equal(countByState().performed, 2);
});

test('4. 授权更新升版：未演场次按新范围核对，已演保留 v1 依据', async () => {
  const store = useTourStore.getState();
  // 同文号再导入：额度从 5 提到 8，地区扩展到河南洛阳 → v2
  const updated = [
    '授权书号,剧目,地区,开始日期,结束日期,场次额度,发证机关,备注',
    'AUTH-01,借伞,陕西·西安、河南·洛阳,2026-10-01,2027-03-31,8,管理处,扩额',
  ].join('\n');
  const res = await store.importFile('auth', 'auth-v2.csv', updated);
  assert.equal(res.status, 'success');

  const { authorizations } = useTourStore.getState();
  const active = authorizations.find((a) => a.docNo === 'AUTH-01' && a.status === 'active');
  assert.ok(active);
  assert.equal(active.versionNo, 2, '同文号更新升 v2');

  // 未演场次按新范围：洛阳越区→ok；10-13 因额度提到 8 而 ok
  assert.equal(verdictOf('借伞', '2026-11-01'), 'ok');
  assert.equal(verdictOf('借伞', '2026-10-13'), 'ok');
  // 2027-02-01 在新截止 2027-03-31 内 → ok
  assert.equal(verdictOf('借伞', '2027-02-01'), 'ok');

  // 已演两场仍冻结 v1（AUTH-01, versionNo=1, quota=5）
  const { performances } = useTourStore.getState();
  const performed = performances.filter((p) => p.state === 'performed');
  assert.ok(performed.every((p) => p.basis?.versionNo === 1), '已演保留 v1 原依据');
  assert.ok(performed.every((p) => p.basis?.quota === 5), '冻结时额度为 5');
});

test('5. 回执找不到排期：整批失败回滚、保留待核对批次；补排期后重开成功', async () => {
  const store = useTourStore.getState();
  const before = countByState();
  const badCsv = [
    '回执号,日期,地区,戏台,剧目',
    'HZ-GOOD,2026-10-10,陕西·西安,易俗社,借伞',
    'HZ-ORPHAN,2026-12-20,陕西·西安,易俗社,借伞',
  ].join('\n');
  const res = await store.importFile('receipt', 'bad.csv', badCsv);
  assert.equal(res.status, 'failed', '应判失败');
  assert.match(res.message, /回滚|未通过/);
  // 事务回滚：GOOD 行也不得落为已演
  assert.deepEqual(countByState(), before, '额度恢复原状（无场次转已用）');

  // 待核对批次留存
  const pending = useTourStore.getState().importBatches.find(
    (b) => b.fileName === 'bad.csv' && b.status === 'failed',
  );
  assert.ok(pending, '保留待核对批次');
  assert.ok(res.results.some((r) => !r.ok && /HZ-ORPHAN/.test(r.error ?? '')), '指出孤儿回执');

  // 补上 12-20 排期（此时额度 8，仍有富余）
  const fixSched = [
    '批次,分队,日期,地区,戏台,剧目',
    '冬巡,甲队,2026-12-20,陕西·西安,易俗社,借伞',
  ].join('\n');
  const fix = await store.importFile('schedule', 'fix.csv', fixSched);
  assert.equal(fix.status, 'success');

  // 重开原待核对批次：两条回执一起成功
  const retry = await store.reprocessImport(pending.id);
  assert.ok(retry);
  assert.equal(retry.status, 'success', retry.message);
  const after = countByState();
  assert.equal(after.performed, before.performed + 2, '重开后两条均转已用');
});

test('6. 旧剧目补登授权书后，已排 held 场次自动按新授权核对', async () => {
  const store = useTourStore.getState();
  // 「老腔老戏」此前 no-auth，补一份额度 2 的授权（含唯一一场 11-05）
  const csv = [
    '授权书号,剧目,地区,开始日期,结束日期,场次额度,发证机关',
    'AUTH-OLD,老腔老戏,陕西·西安,2026-10-01,2026-12-31,2,管理处',
  ].join('\n');
  const res = await store.importFile('auth', 'old-auth.csv', csv);
  assert.equal(res.status, 'success');
  assert.equal(verdictOf('老腔老戏', '2026-11-05'), 'ok', '补授权后预占场次自动在额度内');

  const { authorizations, performances, playTitleById } = useTourStore.getState();
  const usage = buildPlayRecons(authorizations, performances, playTitleById).find(
    (r) => r.playTitle === '老腔老戏',
  )?.usage;
  assert.ok(usage);
  assert.equal(usage.held, 1, '预占 1 场归入新授权');
  assert.equal(usage.remaining, 1);
});

test('7. 表头不符也留待核对，且不写任何数据', async () => {
  const store = useTourStore.getState();
  const beforeAuth = useTourStore.getState().authorizations.length;
  const bad = ['文号,剧名,2026-01-01', 'X,随便,啥'].join('\n');
  const res = await store.importFile('auth', 'bad-header.csv', bad);
  assert.equal('status' in res ? res.status : 'error', 'failed');
  const afterAuth = useTourStore.getState().authorizations.length;
  assert.equal(afterAuth, beforeAuth, '未写入授权书');
  const kept = useTourStore.getState().importBatches.some((b) => b.fileName === 'bad-header.csv');
  assert.ok(kept, '留待核对');
});

test('8. 解析层：表头「地区」按导入类型消歧，行级校验定位错误', () => {
  const auth = parseSheet('授权书号,剧目,地区,开始日期,结束日期,场次额度\nA01,借伞,陕西·西安、河南·洛阳,2026-10-01,2026-12-31,5', 'auth');
  assert.deepEqual(auth.headers.slice(0, 3), ['docNo', 'playTitle', 'regions']);
  assert.equal(missingHeaders('auth', auth.headers).length, 0);
  assert.equal(auth.rawRows[0].fields.regions, '陕西·西安、河南·洛阳');
  const authChecked = validateAuthRow(auth.rawRows[0]);
  assert.ok(authChecked.ok);
  if (authChecked.ok) assert.deepEqual(authChecked.data.draft.regions, ['陕西·西安', '河南·洛阳']);

  const sched = parseSheet('批次,分队,日期,地区,戏台,剧目\n秋巡,甲队,2026-10-08,陕西·西安,易俗社,借伞', 'schedule');
  assert.ok(sched.headers.includes('region'));
  assert.ok(!sched.headers.includes('regions'));
  const schedChecked = validateScheduleRow(sched.rawRows[0]);
  assert.ok(schedChecked.ok);
  if (schedChecked.ok) assert.equal(schedChecked.data.team, 'teamA');

  // 分队非法
  const badTeam = parseSheet('批次,分队,日期,地区,戏台,剧目\n秋巡,丙队,2026-10-08,陕西·西安,易俗社,借伞', 'schedule');
  const badChecked = validateScheduleRow(badTeam.rawRows[0]);
  assert.ok(!badChecked.ok);
  if (!badChecked.ok) assert.match(badChecked.error, /分队/);

  // 回执行缺回执号
  const receipt = parseSheet('回执号,日期,地区,剧目\n,2026-10-08,陕西·西安,借伞', 'receipt');
  const receiptChecked = validateReceiptRow(receipt.rawRows[0]);
  assert.ok(!receiptChecked.ok);
  if (!receiptChecked.ok) assert.match(receiptChecked.error, /回执号/);

  // TSV 与引号包裹
  const tsv = parseSheet('批次\t分队\t日期\t地区\t戏台\t剧目\n秋巡\t乙队\t2026-10-08\t陕西·西安\t"大,戏台"\t借伞', 'schedule');
  const tsvChecked = validateScheduleRow(tsv.rawRows[0]);
  assert.ok(tsvChecked.ok);
  if (tsvChecked.ok) {
    assert.equal(tsvChecked.data.team, 'teamB');
    assert.equal(tsvChecked.data.venue, '大,戏台');
  }
});

async function main(): Promise<void> {
  // 全新内存库
  await db.delete();
  await db.open();
  await useTourStore.getState().loadTour();

  for (const { name, fn } of tests) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n全部 ${passed} 项通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
