/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 * - 表的增删改查与整库导入导出
 * - 巡演授权对账：排场次 / 回执导入事务（失败整段回滚额度）、授权更新重核
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie';
import type { Play } from '../types/play';
import type { Scene } from '../types/scene';
import type { ShadowRole } from '../types/role';
import type { Operator } from '../types/operator';
import type { PercussionCue } from '../types/cue';
import type {
  AuthDraft,
  ReceiptLogEntry,
  TourAuthorization,
  TourBatch,
  TourShow,
} from '../types/tour';
import { nowIso, uuid } from './uuid';
import { seedDatabase } from './seed';
import {
  activeAuthOf,
  authBasisOf,
  evaluateSlot,
  matchShowForReceipt,
  planReservedRecheck,
} from './tourReconcile';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据库名 */
export const DB_NAME = 'gbshadowplay';

/** 带结构修订号的持久化实体 */
export interface Revisioned {
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number;
}

export type PlayRow = Play & Revisioned;
export type SceneRow = Scene & Revisioned;
export type RoleRow = ShadowRole & Revisioned;
export type OperatorRow = Operator & Revisioned;
export type CueRow = PercussionCue & Revisioned;
export type AuthRow = TourAuthorization & Revisioned;
export type TourBatchRow = TourBatch & Revisioned;
export type TourShowRow = TourShow & Revisioned;

export const ROW_REVISION = 3;

/** 每次点击「开始导入 / 继续处理」单事务处理的最大行数（0 = 不截断，一次跑完） */
export const IMPORT_CHUNK_LIMIT = 0;

class ShadowPlayDatabase extends Dexie {
  plays!: Table<PlayRow, string>;
  scenes!: Table<SceneRow, string>;
  roles!: Table<RoleRow, string>;
  operators!: Table<OperatorRow, string>;
  cues!: Table<CueRow, string>;
  authorizations!: Table<AuthRow, string>;
  tourBatches!: Table<TourBatchRow, string>;
  tourShows!: Table<TourShowRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（仅基础自增字段，保留历史数据）
    this.version(1).stores({
      plays: 'id, title, genre, status, createdAt',
      scenes: 'id, playId, seq, progress',
      roles: 'id, sceneId, operatorId, roleType',
      operators: 'id, name',
      cues: 'id, sceneId, atSecond, instrument',
    });

    // v2：新增 revision 行修订号；场次补充索引，锣鼓点补充 playId 冗余便于按剧目统计
    this.version(2).stores({
      plays: 'id, title, genre, status, createdAt, updatedAt',
      scenes: 'id, playId, seq, progress, needsShadowScreen',
      roles: 'id, sceneId, operatorId, roleType, name',
      operators: 'id, name, rehearsalHours',
      cues: 'id, sceneId, atSecond, instrument, beatName',
    });

    // v3：巡演授权对账——授权书 / 巡演批次 / 巡演场次三张表
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plays: 'id, title, genre, status, createdAt, updatedAt',
        scenes: 'id, playId, seq, progress, needsShadowScreen',
        roles: 'id, sceneId, operatorId, roleType, name',
        operators: 'id, name, rehearsalHours',
        cues: 'id, sceneId, atSecond, instrument, beatName',
        authorizations: 'id, playId, status, versionNo, docNo',
        tourBatches: 'id, playId, troupe, status, createdAt',
        tourShows: 'id, batchId, playId, authId, status, showDate, receiptNo',
      })
      .upgrade(async (tx) => {
        // v2 → v3：既有表补时间戳兜底；巡演三表为新增空表，无需搬数据
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('plays'),
          tx.table('scenes'),
          tx.table('roles'),
          tx.table('operators'),
          tx.table('cues'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.updatedAt !== 'string') row.updatedAt = nowIso();
            if (typeof row.createdAt !== 'string') row.createdAt = row.updatedAt;
          });
        }
      });
  }
}

export const db = new ShadowPlayDatabase();

/** 打开数据库：首次使用时灌入示例班社数据，保证界面不为空壳 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.plays.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 剧目 ------------------------------ */

export async function listPlays(): Promise<PlayRow[]> {
  return db.plays.orderBy('createdAt').reverse().toArray();
}

export async function getPlay(id: string): Promise<PlayRow | undefined> {
  return db.plays.get(id);
}

export async function putPlay(row: PlayRow): Promise<void> {
  await db.plays.put(row);
}

export async function removePlay(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.plays,
      db.scenes,
      db.roles,
      db.cues,
      db.authorizations,
      db.tourBatches,
      db.tourShows,
    ],
    async () => {
      const scenes = await db.scenes.where('playId').equals(id).toArray();
      const sceneIds = scenes.map((scene) => scene.id);
      if (sceneIds.length > 0) {
        await db.roles.where('sceneId').anyOf(sceneIds).delete();
        await db.cues.where('sceneId').anyOf(sceneIds).delete();
      }
      await db.scenes.where('playId').equals(id).delete();
      const batches = await db.tourBatches.where('playId').equals(id).toArray();
      if (batches.length > 0) {
        await db.tourShows.where('batchId').anyOf(batches.map((batch) => batch.id)).delete();
        await db.tourBatches.where('playId').equals(id).delete();
      }
      await db.authorizations.where('playId').equals(id).delete();
      await db.plays.delete(id);
    },
  );
}

/* ------------------------------ 场次 ------------------------------ */

export async function listScenesByPlay(playId: string): Promise<SceneRow[]> {
  const rows = await db.scenes.where('playId').equals(playId).toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function getScene(id: string): Promise<SceneRow | undefined> {
  return db.scenes.get(id);
}

export async function putScene(row: SceneRow): Promise<void> {
  await db.scenes.put(row);
}

export async function putScenes(rows: SceneRow[]): Promise<void> {
  await db.scenes.bulkPut(rows);
}

export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', db.scenes, db.roles, db.cues, async () => {
    await db.roles.where('sceneId').equals(id).delete();
    await db.cues.where('sceneId').equals(id).delete();
    await db.scenes.delete(id);
  });
}

/* ---------------------------- 影人角色 ---------------------------- */

export async function listRolesByScene(sceneId: string): Promise<RoleRow[]> {
  return db.roles.where('sceneId').equals(sceneId).toArray();
}

export async function listRolesByScenes(sceneIds: string[]): Promise<RoleRow[]> {
  if (sceneIds.length === 0) return [];
  return db.roles.where('sceneId').anyOf(sceneIds).toArray();
}

export async function listAllRoles(): Promise<RoleRow[]> {
  return db.roles.toArray();
}

export async function putRole(row: RoleRow): Promise<void> {
  await db.roles.put(row);
}

export async function removeRole(id: string): Promise<void> {
  await db.roles.delete(id);
}

/* ----------------------------- 操耍人 ----------------------------- */

export async function listOperators(): Promise<OperatorRow[]> {
  const rows = await db.operators.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getOperator(id: string): Promise<OperatorRow | undefined> {
  return db.operators.get(id);
}

export async function putOperator(row: OperatorRow): Promise<void> {
  await db.operators.put(row);
}

export async function putOperators(rows: OperatorRow[]): Promise<void> {
  await db.operators.bulkPut(rows);
}

export async function removeOperator(id: string): Promise<void> {
  await db.transaction('rw', db.operators, db.roles, async () => {
    const bound = await db.roles.where('operatorId').equals(id).toArray();
    if (bound.length > 0) {
      await db.roles.bulkPut(bound.map((role) => ({ ...role, operatorId: null, updatedAt: nowIso() })));
    }
    await db.cues.where('leadOperator').equals(id).modify({ leadOperator: null });
    await db.operators.delete(id);
  });
}

/* ----------------------------- 锣鼓点 ----------------------------- */

export async function listCuesByScene(sceneId: string): Promise<CueRow[]> {
  const rows = await db.cues.where('sceneId').equals(sceneId).toArray();
  return rows.sort((a, b) => a.atSecond - b.atSecond);
}

export async function putCue(row: CueRow): Promise<void> {
  await db.cues.put(row);
}

export async function removeCue(id: string): Promise<void> {
  await db.cues.delete(id);
}

/* --------------------------- 巡演授权书 --------------------------- */

export async function listAuthorizations(): Promise<AuthRow[]> {
  return db.authorizations.toArray();
}

export async function getAuthorization(id: string): Promise<AuthRow | undefined> {
  return db.authorizations.get(id);
}

export async function putAuthorization(row: AuthRow): Promise<void> {
  await db.authorizations.put(row);
}

/**
 * 新建授权书。
 * 同一剧目若已有现行版本，调用方应改走 renewAuthorization（换发新版本）。
 */
export async function createAuthorization(playId: string, draft: AuthDraft): Promise<AuthRow> {
  const stamp = nowIso();
  const history = await db.authorizations.where('playId').equals(playId).toArray();
  if (history.some((auth) => auth.status === 'active')) {
    throw new Error('该剧目已有现行有效授权书，请使用「换发新版」而不是重复新建');
  }
  const row: AuthRow = {
    id: uuid(),
    playId,
    docNo: draft.docNo.trim(),
    versionNo: (history.reduce((max, auth) => Math.max(max, auth.versionNo), 0) || 0) + 1,
    status: 'active',
    regions: draft.regions.map((region) => region.trim()).filter(Boolean),
    dateFrom: draft.dateFrom,
    dateTo: draft.dateTo,
    totalQuota: draft.totalQuota,
    issuedAt: draft.issuedAt,
    note: draft.note.trim(),
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.authorizations.put(row);
  await recheckPlayShows(playId);
  return row;
}

/**
 * 修改现行授权书（文号 / 地区 / 日期 / 额度调整）。
 * 授权更新后：未演场次立即按新范围重新核对，已演批次保留原依据快照不动。
 */
export async function editAuthorization(authId: string, draft: AuthDraft): Promise<void> {
  const existing = await db.authorizations.get(authId);
  if (!existing) throw new Error('授权书不存在或已被删除');
  const next: AuthRow = {
    ...existing,
    docNo: draft.docNo.trim(),
    regions: draft.regions.map((region) => region.trim()).filter(Boolean),
    dateFrom: draft.dateFrom,
    dateTo: draft.dateTo,
    totalQuota: draft.totalQuota,
    issuedAt: draft.issuedAt,
    note: draft.note.trim(),
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.authorizations.put(next);
  await recheckPlayShows(existing.playId);
}

/**
 * 换发新版授权书：旧版置为 superseded（作废留存），新版本号 +1 并生效。
 * 已演场次冻结在旧版上（AuthBasis），待演场次全部按新版范围重核。
 */
export async function renewAuthorization(oldAuthId: string, draft: AuthDraft): Promise<AuthRow> {
  const stamp = nowIso();
  return db.transaction('rw', db.authorizations, db.tourShows, db.plays, async () => {
    const old = await db.authorizations.get(oldAuthId);
    if (!old) throw new Error('原授权书不存在');
    if (old.status !== 'active') throw new Error('只能为现行有效授权书换发新版');
    const playAuths = await db.authorizations.where('playId').equals(old.playId).toArray();
    const nextVersion = playAuths.reduce((max, auth) => Math.max(max, auth.versionNo), 0) + 1;
    await db.authorizations.put({ ...old, status: 'superseded', updatedAt: stamp, revision: ROW_REVISION });
    const row: AuthRow = {
      id: uuid(),
      playId: old.playId,
      docNo: draft.docNo.trim() || old.docNo,
      versionNo: nextVersion,
      status: 'active',
      regions: draft.regions.map((region) => region.trim()).filter(Boolean),
      dateFrom: draft.dateFrom,
      dateTo: draft.dateTo,
      totalQuota: draft.totalQuota,
      issuedAt: draft.issuedAt,
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.authorizations.put(row);
    await recheckWithinTransaction(old.playId);
    return row;
  });
}

/**
 * 删除授权书。
 * 已演场次依据该书时禁止删除（已演批次保留原依据，不可断链）；
 * 删除现行版本后，待演场次按「缺授权书」重新核对并释放预占。
 */
export async function removeAuthorization(authId: string): Promise<void> {
  const existing = await db.authorizations.get(authId);
  if (!existing) return;
  const performed = await db.tourShows
    .where('authId')
    .equals(authId)
    .filter((show) => show.status === 'performed')
    .count();
  if (performed > 0) {
    throw new Error(`已有 ${performed} 场已演场次以该书为依据，不能删除（可换发新版替代）`);
  }
  await db.transaction('rw', db.authorizations, db.tourShows, db.plays, async () => {
    await db.authorizations.delete(authId);
    await recheckWithinTransaction(existing.playId);
  });
}

/** 对某剧目的全部未演场次按现行授权重新核对（事务外便捷封装） */
export async function recheckPlayShows(playId: string): Promise<void> {
  await db.transaction('rw', db.authorizations, db.tourShows, db.plays, async () => {
    await recheckWithinTransaction(playId);
  });
}

/** 对全部巡演场次重新核对（如批量修复待核对） */
export async function recheckAllShows(): Promise<void> {
  await db.transaction('rw', db.authorizations, db.tourShows, db.plays, async () => {
    const [auths, shows, plays] = await Promise.all([
      db.authorizations.toArray(),
      db.tourShows.toArray(),
      db.plays.toArray(),
    ]);
    const playIds = new Set(plays.map((play) => play.id));
    const plan = planReservedRecheck(shows, auths, playIds);
    const stamp = nowIso();
    for (const show of shows) {
      const next = plan.get(show.id);
      if (next) {
        await db.tourShows.put({
          ...show,
          authId: next.authId,
          issues: next.issues,
          updatedAt: stamp,
          revision: ROW_REVISION,
        });
      }
    }
  });
}

/** 事务内重核：只动某剧目未演场次，已演场永远保留冻结依据 */
async function recheckWithinTransaction(playId: string): Promise<void> {
  const [auths, playShows, play] = await Promise.all([
    db.authorizations.toArray(),
    db.tourShows.where('playId').equals(playId).toArray(),
    db.plays.get(playId),
  ]);
  const plan = planReservedRecheck(playShows, auths, new Set(play ? [play.id] : []));
  const stamp = nowIso();
  for (const show of playShows) {
    const next = plan.get(show.id);
    if (next) {
      await db.tourShows.put({
        ...show,
        authId: next.authId,
        issues: next.issues,
        updatedAt: stamp,
        revision: ROW_REVISION,
      });
    }
  }
}

/* ---------------------------- 巡演批次 ---------------------------- */

export async function listTourBatches(): Promise<TourBatchRow[]> {
  const rows = await db.tourBatches.toArray();
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getTourBatch(id: string): Promise<TourBatchRow | undefined> {
  return db.tourBatches.get(id);
}

export async function putTourBatch(row: TourBatchRow): Promise<void> {
  await db.tourBatches.put(row);
}

export async function removeTourBatch(id: string): Promise<void> {
  await db.transaction('rw', db.tourBatches, db.tourShows, async () => {
    await db.tourShows.where('batchId').equals(id).delete();
    await db.tourBatches.delete(id);
  });
}

/* ---------------------------- 巡演场次 ---------------------------- */

export async function listTourShows(): Promise<TourShowRow[]> {
  return db.tourShows.toArray();
}

export async function listTourShowsByBatch(batchId: string): Promise<TourShowRow[]> {
  const rows = await db.tourShows.where('batchId').equals(batchId).toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

/** 撤销待演场次（含未预占的待核对场）：从额度池释放，留撤销痕迹 */
export async function cancelTourShow(showId: string): Promise<void> {
  const show = await db.tourShows.get(showId);
  if (!show) return;
  if (show.status === 'performed') {
    throw new Error('已演场次是历史记录，不能撤销');
  }
  if (show.status === 'cancelled') return;
  await db.tourShows.put({
    ...show,
    status: 'cancelled',
    authId: null,
    issues: [],
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  });
}

/* --------------------- 排场次 / 回执导入（事务） --------------------- */

export interface ScheduleChunkResult {
  /** 本次事务新确认处理的行数（成功建场或业务待核对都计入） */
  processed: number;
  /** 本次新预占额度（核对通过）的场次数 */
  reservedCount: number;
  /** 本次新建但待核对（地区 / 日期 / 额度 / 缺授权）的场次数 */
  pendingIssueCount: number;
  done: boolean;
}

/**
 * 继续处理排场次导入队列：剩余 pending 行单事务跑完。
 * 任一行数据性致命错误 → 整个事务回滚（已预占额度全部恢复），
 * 队列保留为 failed 且 pending 不动，重开批次可继续。
 * 业务性问题（超地区 / 超日期 / 两队合计超额 / 缺授权书）不致命：
 * 建待核对场次、不占额度，游标照常前进。
 */
export async function processScheduleChunk(batchId: string): Promise<ScheduleChunkResult> {
  const before = await db.tourBatches.get(batchId);
  if (!before) throw new Error('巡演批次不存在');
  const queue = before.scheduleQueue;
  if (queue.pending.length === 0) {
    return { processed: 0, reservedCount: 0, pendingIssueCount: 0, done: true };
  }
  await db.tourBatches.put({
    ...before,
    scheduleQueue: { ...queue, state: 'processing', lastError: null, updatedAt: nowIso() },
    revision: ROW_REVISION,
  });

  let errorOffset: number | null = null;

  try {
    return await db.transaction(
      'rw',
      db.tourBatches,
      db.tourShows,
      db.authorizations,
      db.plays,
      async () => {
        const batch = await db.tourBatches.get(batchId);
        if (!batch) throw new Error('巡演批次不存在');
        const rows = IMPORT_CHUNK_LIMIT > 0
          ? batch.scheduleQueue.pending.slice(0, IMPORT_CHUNK_LIMIT)
          : [...batch.scheduleQueue.pending];

        const [plays, auths, allShows] = await Promise.all([
          db.plays.toArray(),
          db.authorizations.toArray(),
          db.tourShows.toArray(),
        ]);
        const playByTitle = new Map(plays.map((play) => [play.title.trim(), play]));
        const heldByAuth = new Map<string, number>();
        for (const show of allShows) {
          if (show.authId && show.status !== 'cancelled') {
            heldByAuth.set(show.authId, (heldByAuth.get(show.authId) ?? 0) + 1);
          }
        }
        let seq = allShows.filter((show) => show.batchId === batchId).length;

        const stamp = nowIso();
        const newShows: TourShowRow[] = [];
        let reservedCount = 0;
        let pendingIssueCount = 0;
        // 错误行号按原始文件行号计（断点续处理 / 丢弃坏行后仍能定位原行）
        const rowNoBase = batch.scheduleQueue.total - batch.scheduleQueue.pending.length;

        rows.forEach((row, index) => {
          const rowNo = rowNoBase + index + 1;
          const fail = (message: string): Error => {
            errorOffset = index;
            return new Error(message);
          };
          // —— 数据性致命错误：抛出 → 整段回滚，额度恢复 ——
          const region = typeof row.region === 'string' ? row.region.trim() : '';
          if (!region) {
            throw fail(`第 ${rowNo} 行缺少演出地区，无法建档`);
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(row.showDate) || Number.isNaN(Date.parse(row.showDate))) {
            throw fail(`第 ${rowNo} 行演出日期格式不正确（应为 YYYY-MM-DD）：${row.showDate}`);
          }
          const titleOverride = typeof row.playTitle === 'string' && row.playTitle.trim() !== ''
            ? row.playTitle.trim()
            : null;
          let playId = batch.playId;
          if (titleOverride) {
            const resolved = playByTitle.get(titleOverride);
            if (!resolved) {
              throw fail(`第 ${rowNo} 行剧目《${titleOverride}》在本地剧目库中找不到，整批回滚`);
            }
            playId = resolved.id;
          }
          if (!playId) {
            throw fail(`批次未关联本地剧目，且第 ${rowNo} 行也未给出可匹配的 playTitle`);
          }

          // —— 业务性核对：地区 / 日期 / 两队一池额度 / 缺授权 ——
          const auth = activeAuthOf(auths, playId);
          const evalResult = evaluateSlot({
            playExists: true,
            auth,
            region,
            showDate: row.showDate,
            heldCount: auth ? heldByAuth.get(auth.id) ?? 0 : 0,
          });

          seq += 1;
          const show: TourShowRow = {
            id: uuid(),
            batchId,
            playId,
            troupe: batch.troupe,
            seq,
            region,
            showDate: row.showDate,
            status: 'reserved',
            authId: evalResult.authId,
            basis: null,
            receiptNo: null,
            issues: evalResult.issues,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          };
          newShows.push(show);
          if (evalResult.ok && auth) {
            heldByAuth.set(auth.id, (heldByAuth.get(auth.id) ?? 0) + 1);
            reservedCount += 1;
          } else {
            pendingIssueCount += 1;
          }
        });

        await db.tourShows.bulkPut(newShows);

        const remaining = batch.scheduleQueue.pending.slice(rows.length);
        const anyIssue =
          pendingIssueCount > 0 ||
          (await db.tourShows
            .where('batchId')
            .equals(batchId)
            .filter((show) => show.status !== 'cancelled' && show.issues.length > 0)
            .count()) > 0;
        const updated: TourBatchRow = {
          ...batch,
          status:
            batch.status === 'closed'
              ? 'closed'
              : remaining.length === 0 && !anyIssue
                ? 'active'
                : 'preparing',
          scheduleQueue: {
            ...batch.scheduleQueue,
            state: remaining.length === 0 ? 'done' : 'idle',
            processed: batch.scheduleQueue.processed + rows.length,
            pending: remaining,
            lastError: null,
            errorOffset: null,
            updatedAt: stamp,
          },
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
        await db.tourBatches.put(updated);

        return {
          processed: rows.length,
          reservedCount,
          pendingIssueCount,
          done: remaining.length === 0,
        };
      },
    );
  } catch (error) {
    // 事务已整体回滚：额度恢复原状；仅记录失败状态与原因，批次（待核对）保留
    const failedAt = nowIso();
    const current = await db.tourBatches.get(batchId);
    if (current) {
      await db.tourBatches.put({
        ...current,
        status: current.status === 'active' ? 'active' : 'preparing',
        scheduleQueue: {
          ...current.scheduleQueue,
          state: 'failed',
          lastError: error instanceof Error ? error.message : '导入失败，已回滚本批预占额度',
          errorOffset,
          updatedAt: failedAt,
        },
        updatedAt: failedAt,
        revision: ROW_REVISION,
      });
    }
    throw error;
  }
}

export interface ReceiptChunkResult {
  processed: number;
  applied: number;
  duplicate: number;
  unmatched: number;
  done: boolean;
}

/**
 * 继续处理回执导入队列：
 * - 回执编号在任意批次已用 / 已留痕 → 重复导入，记 duplicate，不再占用额度；
 * - 能对上本批同地区同日期的待演预占场 → 演完转已用并冻结授权依据；
 * - 对不上 → 记 unmatched 待核，游标前进。
 * 数据性致命错误同样整段回滚、failed 保留、重开继续。
 */
export async function processReceiptChunk(batchId: string): Promise<ReceiptChunkResult> {
  const before = await db.tourBatches.get(batchId);
  if (!before) throw new Error('巡演批次不存在');
  const queue = before.receiptQueue;
  if (queue.pending.length === 0) {
    return { processed: 0, applied: 0, duplicate: 0, unmatched: 0, done: true };
  }
  await db.tourBatches.put({
    ...before,
    receiptQueue: { ...queue, state: 'processing', lastError: null, updatedAt: nowIso() },
    revision: ROW_REVISION,
  });

  let errorOffset: number | null = null;

  try {
    return await db.transaction('rw', db.tourBatches, db.tourShows, db.authorizations, async () => {
      const batch = await db.tourBatches.get(batchId);
      if (!batch) throw new Error('巡演批次不存在');
      const rows = IMPORT_CHUNK_LIMIT > 0
        ? batch.receiptQueue.pending.slice(0, IMPORT_CHUNK_LIMIT)
        : [...batch.receiptQueue.pending];

      const [allShows, auths, allBatches] = await Promise.all([
        db.tourShows.toArray(),
        db.authorizations.toArray(),
        db.tourBatches.toArray(),
      ]);
      const knownReceipts = new Set<string>();
      for (const show of allShows) {
        if (show.receiptNo) knownReceipts.add(show.receiptNo.trim());
      }
      // 回执号全局唯一：任意批次已用 / 已留痕（重复 / 对不上）都算见过，重复导入不再占用
      for (const otherBatch of allBatches) {
        for (const logEntry of otherBatch.receiptLog) knownReceipts.add(logEntry.receiptNo.trim());
      }

      const stamp = nowIso();
      const logs: ReceiptLogEntry[] = [];
      let applied = 0;
      let duplicate = 0;
      let unmatched = 0;
      const mutableShows = new Map(allShows.map((show) => [show.id, show]));
      const rowNoBase = batch.receiptQueue.total - batch.receiptQueue.pending.length;

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const rowNo = rowNoBase + index + 1;
        const fail = (message: string): Error => {
          errorOffset = index;
          return new Error(message);
        };
        const receiptNo = typeof row.receiptNo === 'string' ? row.receiptNo.trim() : '';
        if (!receiptNo) {
          throw fail(`第 ${rowNo} 行缺少回执编号，整批回滚`);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.showDate) || Number.isNaN(Date.parse(row.showDate))) {
          throw fail(`第 ${rowNo} 行演出日期格式不正确（应为 YYYY-MM-DD）`);
        }
        const region = typeof row.region === 'string' ? row.region.trim() : '';
        if (!region) {
          throw fail(`第 ${rowNo} 行缺少演出地区`);
        }

        if (knownReceipts.has(receiptNo)) {
          duplicate += 1;
          logs.push({
            receiptNo,
            showDate: row.showDate,
            region,
            result: 'duplicate',
            showId: null,
            at: stamp,
          });
          continue;
        }

        const liveShows = [...mutableShows.values()];
        const matched = matchShowForReceipt(liveShows, { batchId, region, showDate: row.showDate });
        if (!matched) {
          unmatched += 1;
          knownReceipts.add(receiptNo);
          logs.push({
            receiptNo,
            showDate: row.showDate,
            region,
            result: 'unmatched',
            showId: null,
            at: stamp,
          });
          continue;
        }

        const auth = matched.authId ? auths.find((item) => item.id === matched.authId) : null;
        const updatedShow: TourShowRow = {
          ...matched,
          status: 'performed',
          receiptNo,
          basis: auth ? authBasisOf(auth) : matched.basis,
          issues: [],
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
        mutableShows.set(matched.id, updatedShow);
        await db.tourShows.put(updatedShow);
        knownReceipts.add(receiptNo);
        applied += 1;
        logs.push({
          receiptNo,
          showDate: row.showDate,
          region,
          result: 'applied',
          showId: matched.id,
          at: stamp,
        });
      }

      const remaining = batch.receiptQueue.pending.slice(rows.length);
      const updated: TourBatchRow = {
        ...batch,
        receiptQueue: {
          ...batch.receiptQueue,
          state: remaining.length === 0 ? 'done' : 'idle',
          processed: batch.receiptQueue.processed + rows.length,
          pending: remaining,
          lastError: null,
          errorOffset: null,
          updatedAt: stamp,
        },
        receiptLog: [...batch.receiptLog, ...logs],
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      await db.tourBatches.put(updated);

      return { processed: rows.length, applied, duplicate, unmatched, done: remaining.length === 0 };
    });
  } catch (error) {
    const failedAt = nowIso();
    const current = await db.tourBatches.get(batchId);
    if (current) {
      await db.tourBatches.put({
        ...current,
        receiptQueue: {
          ...current.receiptQueue,
          state: 'failed',
          lastError: error instanceof Error ? error.message : '回执导入失败，已回滚本次处理',
          errorOffset,
          updatedAt: failedAt,
        },
        updatedAt: failedAt,
        revision: ROW_REVISION,
      });
    }
    throw error;
  }
}

/**
 * 丢弃致命错误行（上次失败定位到的那行）：
 * 仅移走该行、确认数 +1，不动任何额度；其前后尚未处理的行原样保留，可继续处理。
 * 没有定位信息时兜底丢弃队首。
 */
export async function discardErrorRow(
  batchId: string,
  kind: 'schedule' | 'receipt',
): Promise<{ discardedIndex: number }> {
  const batch = await db.tourBatches.get(batchId);
  if (!batch) throw new Error('巡演批次不存在');
  const queue = kind === 'schedule' ? batch.scheduleQueue : batch.receiptQueue;
  if (queue.pending.length === 0) throw new Error('队列里没有可丢弃的行');
  const index =
    queue.errorOffset !== null && queue.errorOffset >= 0 && queue.errorOffset < queue.pending.length
      ? queue.errorOffset
      : 0;
  const rest = queue.pending.filter((_, rowIndex) => rowIndex !== index);
  const stamp = nowIso();
  const nextQueue = {
    ...queue,
    state: rest.length === 0 ? ('done' as const) : ('idle' as const),
    processed: queue.processed + 1,
    pending: rest,
    lastError: rest.length === 0 ? null : `已丢弃第 ${index + 1} 条坏行，剩余 ${rest.length} 行可继续处理`,
    errorOffset: null,
    updatedAt: stamp,
  };
  await db.tourBatches.put({
    ...batch,
    ...(kind === 'schedule'
      ? { scheduleQueue: nextQueue as TourBatchRow['scheduleQueue'] }
      : { receiptQueue: nextQueue as TourBatchRow['receiptQueue'] }),
    updatedAt: stamp,
    revision: ROW_REVISION,
  });
  return { discardedIndex: index };
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  /** 快照标识，固定为数据库名 */
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plays: Play[];
  scenes: Scene[];
  roles: ShadowRole[];
  operators: Operator[];
  cues: PercussionCue[];
  authorizations: TourAuthorization[];
  tourBatches: TourBatch[];
  tourShows: TourShow[];
}

/** 导出整库快照（去掉内部 revision 字段） */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plays, scenes, roles, operators, cues, authorizations, tourBatches, tourShows] = await Promise.all([
    db.plays.toArray(),
    db.scenes.toArray(),
    db.roles.toArray(),
    db.operators.toArray(),
    db.cues.toArray(),
    db.authorizations.toArray(),
    db.tourBatches.toArray(),
    db.tourShows.toArray(),
  ]);
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row;
    return rest;
  };
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plays: plays.map(strip),
    scenes: scenes.map(strip),
    roles: roles.map(strip),
    operators: operators.map(strip),
    cues: cues.map(strip),
    authorizations: authorizations.map(strip),
    tourBatches: tourBatches.map(strip),
    tourShows: tourShows.map(strip),
  };
}

/** 用快照覆盖整库（导入存档；兼容不含巡演表的旧快照） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.plays,
      db.scenes,
      db.roles,
      db.operators,
      db.cues,
      db.authorizations,
      db.tourBatches,
      db.tourShows,
    ],
    async () => {
      await Promise.all([
        db.plays.clear(),
        db.scenes.clear(),
        db.roles.clear(),
        db.operators.clear(),
        db.cues.clear(),
        db.authorizations.clear(),
        db.tourBatches.clear(),
        db.tourShows.clear(),
      ]);
      const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION });
      await db.plays.bulkPut(snapshot.plays.map(rev));
      await db.scenes.bulkPut(snapshot.scenes.map(rev));
      await db.roles.bulkPut(snapshot.roles.map(rev));
      await db.operators.bulkPut(snapshot.operators.map(rev));
      await db.cues.bulkPut(snapshot.cues.map(rev));
      await db.authorizations.bulkPut((snapshot.authorizations ?? []).map(rev));
      await db.tourBatches.bulkPut((snapshot.tourBatches ?? []).map(rev));
      await db.tourShows.bulkPut((snapshot.tourShows ?? []).map(rev));
    },
  );
}

/** 清空全部数据并重新灌入示例数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.plays,
      db.scenes,
      db.roles,
      db.operators,
      db.cues,
      db.authorizations,
      db.tourBatches,
      db.tourShows,
    ],
    async () => {
      await Promise.all([
        db.plays.clear(),
        db.scenes.clear(),
        db.roles.clear(),
        db.operators.clear(),
        db.cues.clear(),
        db.authorizations.clear(),
        db.tourBatches.clear(),
        db.tourShows.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 粗略统计各表行数，用于页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [plays, scenes, roles, operators, cues, authorizations, tourBatches, tourShows] = await Promise.all([
    db.plays.count(),
    db.scenes.count(),
    db.roles.count(),
    db.operators.count(),
    db.cues.count(),
    db.authorizations.count(),
    db.tourBatches.count(),
    db.tourShows.count(),
  ]);
  return { plays, scenes, roles, operators, cues, authorizations, tourBatches, tourShows };
}
