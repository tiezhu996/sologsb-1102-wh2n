/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 * - 表的增删改查与整库导入导出
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie';
import type { Play } from '../types/play';
import type { Scene } from '../types/scene';
import type { ShadowRole } from '../types/role';
import type { Operator } from '../types/operator';
import type { PercussionCue } from '../types/cue';
import type { Authorization, ImportBatch, TourBatch, TourPerformance } from '../types/tour';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';

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
export type AuthorizationRow = Authorization & Revisioned;
export type TourBatchRow = TourBatch & Revisioned;
export type TourPerformanceRow = TourPerformance & Revisioned;
export type ImportBatchRow = ImportBatch & Revisioned;

export const ROW_REVISION = 3;

class ShadowPlayDatabase extends Dexie {
  plays!: Table<PlayRow, string>;
  scenes!: Table<SceneRow, string>;
  roles!: Table<RoleRow, string>;
  operators!: Table<OperatorRow, string>;
  cues!: Table<CueRow, string>;
  authorizations!: Table<AuthorizationRow, string>;
  tourBatches!: Table<TourBatchRow, string>;
  tourPerformances!: Table<TourPerformanceRow, string>;
  importBatches!: Table<ImportBatchRow, string>;

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
    this.version(2)
      .stores({
        plays: 'id, title, genre, status, createdAt, updatedAt',
        scenes: 'id, playId, seq, progress, needsShadowScreen',
        roles: 'id, sceneId, operatorId, roleType, name',
        operators: 'id, name, rehearsalHours',
        cues: 'id, sceneId, atSecond, instrument, beatName',
      })
      .upgrade(async (tx) => {
        // 迁移：补齐 revision，并兜底历史数据里缺失的字段
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('plays'),
          tx.table('scenes'),
          tx.table('roles'),
          tx.table('operators'),
          tx.table('cues'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            // v2 迁移固定写入修订号 2（ROW_REVISION 会随结构继续提升，此处不可随之漂移）
            row.revision = 2;
            if (typeof row.updatedAt !== 'string') row.updatedAt = nowIso();
            if (typeof row.createdAt !== 'string') row.createdAt = row.updatedAt;
          });
        }
      });

    // v3：新增巡演授权对账四表（授权书 / 巡演批次 / 巡演场次 / 导入记账）。
    // 巡演表均为全新数据，历史行无需迁移；旧五表结构不变。
    this.version(DB_SCHEMA_VERSION).stores({
      plays: 'id, title, genre, status, createdAt, updatedAt',
      scenes: 'id, playId, seq, progress, needsShadowScreen',
      roles: 'id, sceneId, operatorId, roleType, name',
      operators: 'id, name, rehearsalHours',
      cues: 'id, sceneId, atSecond, instrument, beatName',
      authorizations: 'id, docNo, playId, status, createdAt',
      tourBatches: 'id, team, createdAt',
      tourPerformances: 'id, batchId, playId, team, state, showDate, matchedAuthId, receiptNo',
      importBatches: 'id, kind, status, idempotencyKey, importedAt',
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
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.cues, async () => {
    const scenes = await db.scenes.where('playId').equals(id).toArray();
    const sceneIds = scenes.map((scene) => scene.id);
    if (sceneIds.length > 0) {
      await db.roles.where('sceneId').anyOf(sceneIds).delete();
      await db.cues.where('sceneId').anyOf(sceneIds).delete();
    }
    await db.scenes.where('playId').equals(id).delete();
    await db.plays.delete(id);
  });
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

/* ----------------------------- 授权书 ----------------------------- */

export async function listAuthorizations(): Promise<AuthorizationRow[]> {
  const rows = await db.authorizations.toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getAuthorization(id: string): Promise<AuthorizationRow | undefined> {
  return db.authorizations.get(id);
}

export async function putAuthorization(row: AuthorizationRow): Promise<void> {
  await db.authorizations.put(row);
}

export async function putAuthorizations(rows: AuthorizationRow[]): Promise<void> {
  await db.authorizations.bulkPut(rows);
}

export async function removeAuthorization(id: string): Promise<void> {
  await db.authorizations.delete(id);
}

/* ---------------------------- 巡演批次/场次 ---------------------------- */

export async function listTourBatches(): Promise<TourBatchRow[]> {
  const rows = await db.tourBatches.toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTourBatch(id: string): Promise<TourBatchRow | undefined> {
  return db.tourBatches.get(id);
}

export async function putTourBatch(row: TourBatchRow): Promise<void> {
  await db.tourBatches.put(row);
}

export async function removeTourBatch(id: string): Promise<void> {
  await db.transaction('rw', db.tourBatches, db.tourPerformances, async () => {
    await db.tourPerformances.where('batchId').equals(id).delete();
    await db.tourBatches.delete(id);
  });
}

export async function listAllTourPerformances(): Promise<TourPerformanceRow[]> {
  return db.tourPerformances.toArray();
}

export async function listPerformancesByBatch(batchId: string): Promise<TourPerformanceRow[]> {
  const rows = await db.tourPerformances.where('batchId').equals(batchId).toArray();
  return rows.sort((a, b) => a.showDate.localeCompare(b.showDate));
}

export async function putTourPerformance(row: TourPerformanceRow): Promise<void> {
  await db.tourPerformances.put(row);
}

export async function putTourPerformances(rows: TourPerformanceRow[]): Promise<void> {
  await db.tourPerformances.bulkPut(rows);
}

export async function removeTourPerformance(id: string): Promise<void> {
  await db.tourPerformances.delete(id);
}

/* ----------------------------- 导入记账 ----------------------------- */

export async function listImportBatches(): Promise<ImportBatchRow[]> {
  const rows = await db.importBatches.toArray();
  return rows.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function getImportBatch(id: string): Promise<ImportBatchRow | undefined> {
  return db.importBatches.get(id);
}

/** 按幂等键查已成功处理过的导入批次（回执重复导入据此跳过） */
export async function findSuccessfulImportByKey(idempotencyKey: string): Promise<ImportBatchRow | undefined> {
  return db.importBatches.where('idempotencyKey').equals(idempotencyKey).first();
}

export async function putImportBatch(row: ImportBatchRow): Promise<void> {
  await db.importBatches.put(row);
}

export async function removeImportBatch(id: string): Promise<void> {
  await db.importBatches.delete(id);
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
  authorizations: Authorization[];
  tourBatches: TourBatch[];
  tourPerformances: TourPerformance[];
  importBatches: ImportBatch[];
}

/** 导出整库快照（去掉内部 revision 字段） */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plays, scenes, roles, operators, cues, authorizations, tourBatches, tourPerformances, importBatches] =
    await Promise.all([
      db.plays.toArray(),
      db.scenes.toArray(),
      db.roles.toArray(),
      db.operators.toArray(),
      db.cues.toArray(),
      db.authorizations.toArray(),
      db.tourBatches.toArray(),
      db.tourPerformances.toArray(),
      db.importBatches.toArray(),
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
    tourPerformances: tourPerformances.map(strip),
    importBatches: importBatches.map(strip),
  };
}

/** 用快照覆盖整库（导入存档）；旧存档缺少巡演表时按空表处理 */
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
      db.tourPerformances,
      db.importBatches,
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
        db.tourPerformances.clear(),
        db.importBatches.clear(),
      ]);
      const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION });
      await db.plays.bulkPut(snapshot.plays.map(rev));
      await db.scenes.bulkPut(snapshot.scenes.map(rev));
      await db.roles.bulkPut(snapshot.roles.map(rev));
      await db.operators.bulkPut(snapshot.operators.map(rev));
      await db.cues.bulkPut(snapshot.cues.map(rev));
      await db.authorizations.bulkPut((snapshot.authorizations ?? []).map(rev));
      await db.tourBatches.bulkPut((snapshot.tourBatches ?? []).map(rev));
      await db.tourPerformances.bulkPut((snapshot.tourPerformances ?? []).map(rev));
      await db.importBatches.bulkPut((snapshot.importBatches ?? []).map(rev));
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
      db.tourPerformances,
      db.importBatches,
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
        db.tourPerformances.clear(),
        db.importBatches.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 粗略统计各表行数，用于页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [plays, scenes, roles, operators, cues, authorizations, tourBatches, tourPerformances, importBatches] =
    await Promise.all([
      db.plays.count(),
      db.scenes.count(),
      db.roles.count(),
      db.operators.count(),
      db.cues.count(),
      db.authorizations.count(),
      db.tourBatches.count(),
      db.tourPerformances.count(),
      db.importBatches.count(),
    ]);
  return { plays, scenes, roles, operators, cues, authorizations, tourBatches, tourPerformances, importBatches };
}
