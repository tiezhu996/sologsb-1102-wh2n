/**
 * 巡演授权对账端到端不变量验证（Node + fake-indexeddb）。
 * 用 esbuild 临时打包运行，不进入产品构建。
 */
import 'fake-indexeddb/auto';
import {
  db,
  initDatabase,
  listAuthorizations,
  listTourBatches,
  listTourShows,
  processScheduleChunk,
  processReceiptChunk,
  discardErrorRow,
  renewAuthorization,
  cancelTourShow,
  recheckPlayShows,
  getTourBatch,
} from '../src/utils/db';
import { activeAuthOf, quotaUsageOf, missingAuthPlayIds, summarizeTour } from '../src/utils/tourReconcile';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

async function main() {
  await initDatabase();
  const snakePlays = await db.plays.where('title').equals('白蛇传·借伞').toArray();
  const monkeyPlays = await db.plays.where('title').equals('大闹天宫·借扇').toArray();
  const snakeId = snakePlays[0].id;
  const monkeyId = monkeyPlays[0].id;

  const auths = await listAuthorizations();
  const batches = await listTourBatches();
  const shows = await listTourShows();

  console.log('① 种子数据核对');
  const v2 = activeAuthOf(auths, snakeId)!;
  const usage = quotaUsageOf(v2, shows);
  check('v2 已用 2（回执转已用）', usage.used === 2, usage);
  check('v2 预占 3（正常地区待演）', usage.reserved === 3, usage);
  check('v2 剩余额度 1', usage.remaining === 1, usage);
  const beijing = shows.find((s) => s.region === '北京市');
  check('北京场未预占且 REGION_OUT', !!beijing && beijing.authId === null && beijing.issues.includes('REGION_OUT'), beijing);
  const monkeyShows = shows.filter((s) => s.playId === monkeyId);
  check('旧剧目场次 NO_AUTH 待补', monkeyShows.every((s) => s.issues.includes('NO_AUTH')), monkeyShows);
  check('缺授权待补列表含大闹天宫', missingAuthPlayIds(batches, auths).includes(monkeyId));
  const v1 = auths.find((a) => a.status === 'superseded')!;
  const batchA = batches.find((b) => b.batchNo === 'B2026-051')!;
  const performedA = shows.filter((s) => s.batchId === batchA.id);
  check(
    '已演批次 A 的两场冻结在旧版 v1 依据',
    performedA.length === 2 && performedA.every((s) => s.status === 'performed' && s.basis?.authId === v1.id),
    performedA.map((s) => s.basis?.versionNo),
  );

  console.log('② 失败导入：整段回滚、额度恢复、断点保留');
  const failedBatch = (await listTourBatches()).find((b) => b.batchNo === 'B2026-102')!;
  check('失败批次状态 failed 且 4 行待处理', failedBatch.scheduleQueue.state === 'failed' && failedBatch.scheduleQueue.pending.length === 4);
  let before = await listTourShows();
  const showsBeforeRetry = before.filter((s) => s.batchId === failedBatch.id).length;
  let threw = false;
  try {
    await processScheduleChunk(failedBatch.id);
  } catch {
    threw = true;
  }
  check('继续处理仍在第 3 行抛错', threw);
  let after = await listTourShows();
  check('回滚后未留下任何本批场次', after.filter((s) => s.batchId === failedBatch.id).length === showsBeforeRetry);
  const failedBatch2 = await getTourBatch(failedBatch.id);
  check('队列仍是 failed、4 行完整保留', failedBatch2!.scheduleQueue.state === 'failed' && failedBatch2!.scheduleQueue.pending.length === 4);

  console.log('③ 丢弃坏行后继续：成功行预占、超额/超地区转待核对');
  await discardErrorRow(failedBatch.id, 'schedule');
  let dropped = await getTourBatch(failedBatch.id);
  check('丢弃第 3 行坏数据后剩 3 行、processed=1', dropped!.scheduleQueue.pending.length === 3 && dropped!.scheduleQueue.processed === 1);
  await processScheduleChunk(failedBatch.id);
  after = await listTourShows();
  const bShows = after.filter((s) => s.batchId === failedBatch.id).sort((a, b) => a.seq - b.seq);
  check('建成 3 场', bShows.length === 3, bShows.map((s) => `${s.region}/${s.issues.join()}`));
  check('第 1 场唐山预占 v2（占用最后 1 额度）', bShows[0].region === '唐山市' && bShows[0].authId === v2.id);
  const usageAfter = quotaUsageOf(v2, after);
  check('v2 预占变为 4、剩余 0（两队合计）', usageAfter.reserved === 4 && usageAfter.remaining === 0, usageAfter);
  check('第 2 场天津两队合计超额 QUOTA_OVER', bShows[1].region === '天津市' && bShows[1].authId === null && bShows[1].issues.includes('QUOTA_OVER'));
  check('第 3 场北京 REGION_OUT', bShows[2].issues.includes('REGION_OUT') && bShows[2].authId === null);
  const doneBatch = await getTourBatch(failedBatch.id);
  check('队列处理完 done', doneBatch!.scheduleQueue.state === 'done');

  console.log('④ 撤销待核对场不影响额度；撤销预占场释放额度');
  await cancelTourShow(bShows[2].id);
  await cancelTourShow(bShows[0].id);
  after = await listTourShows();
  const usageAfterCancel = quotaUsageOf(v2, after);
  check('撤销预占场后预占回到 3、剩余 1', usageAfterCancel.reserved === 3 && usageAfterCancel.remaining === 1, usageAfterCancel);

  console.log('⑤ 回执导入：转已用 + 重复幂等不占用 + 跨批次全局去重');
  // C 批次：秦皇岛 10-12 是 reserved 预占场；幽灵回执对不上；
  // 再用 A 批次已用过的回执号 HZ-2026-0516-01 验证跨批次重复导入不占用。
  const batchC = (await listTourBatches()).find((b) => b.batchNo === 'B2026-101')!;
  await db.tourBatches.put({
    ...batchC,
    receiptQueue: {
      state: 'idle', total: 3, processed: 0,
      pending: [
        { receiptNo: 'HZ-NEW-001', region: '秦皇岛市', showDate: '2026-10-12' },
        { receiptNo: 'HZ-NEW-001', region: '秦皇岛市', showDate: '2026-10-12' },
        { receiptNo: 'HZ-2026-0516-01', region: '唐山市', showDate: '2026-05-16' },
      ],
      lastError: null, sourceFileName: 'test.json', updatedAt: new Date().toISOString(),
    },
    revision: 3,
  });
  const r = await processReceiptChunk(batchC.id);
  check('回执：1 applied / 2 duplicate（含跨批次重复）', r.applied === 1 && r.duplicate === 2 && r.unmatched === 0, r);
  after = await listTourShows();
  const qhd = after.find((s) => s.batchId === batchC.id && s.region === '秦皇岛市')!;
  check('秦皇岛场已演且冻结 v2 依据', qhd.status === 'performed' && qhd.receiptNo === 'HZ-NEW-001' && qhd.basis?.authId === v2.id);
  const finalUsage = quotaUsageOf(v2, after);
  check('重复回执未多占用（v2 已用 3、预占 2：天津两场）', finalUsage.used === 3 && finalUsage.reserved === 2, finalUsage);
  const log = (await getTourBatch(batchC.id))!.receiptLog;
  const newDupReceipts = log.filter((l) => l.result === 'duplicate').map((l) => l.receiptNo);
  check(
    '本次留痕含两条 duplicate（其中一条跨批次）',
    newDupReceipts.includes('HZ-NEW-001') && newDupReceipts.includes('HZ-2026-0516-01'),
    newDupReceipts,
  );

  console.log('⑥ 换发新版：已演保留旧依据，未演按新范围重核（地区收紧 + 额度调整）');
  // 新版只保留唐山、秦皇岛（天津移出），额度 2
  const newV = await renewAuthorization(v2.id, {
    docNo: '滦文演准〔2026〕第 201 号',
    regions: ['唐山市', '秦皇岛市'],
    dateFrom: '2026-10-01',
    dateTo: '2027-03-31',
    totalQuota: 2,
    issuedAt: '2026-10-01',
    note: '测试换发',
  });
  after = await listTourShows();
  const performedAfter = after.filter((s) => s.status === 'performed');
  check(
    '5 场已演仍冻结在原版本（2 个 v1 + 3 个 v2），换发不改已演依据',
    performedAfter.filter((s) => s.basis?.versionNo === 1).length === 2
      && performedAfter.filter((s) => s.basis?.versionNo === 2).length === 3,
    performedAfter.map((s) => s.basis?.versionNo),
  );
  const tianjinLive = after.find((s) => s.region === '天津市' && s.status === 'reserved');
  check('天津待演场新版范围外 → 释放预占 REGION_OUT', !!tianjinLive && tianjinLive.authId === null && tianjinLive.issues.includes('REGION_OUT'), tianjinLive);
  const tangshanLive = after.filter((s) => s.status === 'reserved' && s.region === '唐山市');
  check('唐山待演场在新版额度内则保持预占', tangshanLive.every((s) => s.authId === newV.id || s.issues.includes('QUOTA_OVER')));
  const newUsage = quotaUsageOf(newV, after);
  check(
    '新版池没有承接旧版已演依据；本轮无符合新版范围的待演场时预占为 0、额度全额可用',
    newUsage.used === 0 && newUsage.remaining === 2,
    newUsage,
  );
  // 没有任何待演场错误地挂到已冻结的旧版本上
  const orphanReserved = after.some((s) => s.status === 'reserved' && s.authId === v2.id);
  check('旧 v2 作废后不再有新预占挂在其上', !orphanReserved);
  const oldV2Row = await listAuthorizations().then((rows) => rows.find((a) => a.id === v2.id)!);
  check('旧 v2 已 superseded 但记录保留', oldV2Row.status === 'superseded');

  console.log('⑦ 给旧剧目补授权后，未演场次重核预占');
  const beforeMonkey = (await listTourShows()).filter((s) => s.playId === monkeyId && s.status === 'reserved');
  check('补授权前沧州/廊坊均无预占', beforeMonkey.every((s) => s.authId === null));
  await db.authorizations.put({
    id: 'auth-monkey-1', playId: monkeyId, docNo: '测试-猴', versionNo: 1, status: 'active',
    regions: ['沧州市', '廊坊市'], dateFrom: '2026-01-01', dateTo: '2026-12-31', totalQuota: 10,
    issuedAt: '2026-10-01', note: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 3,
  });
  await recheckPlayShows(monkeyId);
  const afterMonkey = (await listTourShows()).filter((s) => s.playId === monkeyId && s.status === 'reserved');
  check('补授权后两场全部预占、问题清空', afterMonkey.length === 2 && afterMonkey.every((s) => s.authId === 'auth-monkey-1' && s.issues.length === 0), afterMonkey);
  const summary = summarizeTour({ auths: await listAuthorizations(), batches: await listTourBatches(), shows: await listTourShows() });
  check('汇总：已演 5（v1 两 + v2 三），且仍有待核对场', summary.showPerformed === 5 && summary.showPendingIssue >= 1, summary);

  await db.close();
  if (failures > 0) {
    console.error(`\n${failures} 项校验失败`);
    process.exit(1);
  }
  console.log('\n全部校验通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
