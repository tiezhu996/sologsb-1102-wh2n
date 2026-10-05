/**
 * 巡演授权对账状态管理（Zustand）
 *
 * 关键不变量：
 * - 排场次 → held（预占额度）；演完 → performed（冻结当时授权依据，转已用）；取消 → 释放预占。
 * - 已演场次的 basis 永久保留，授权更新/换发后不重算；held 每次按最新授权范围核对（见 tourRecon）。
 * - 导入整批在一个 Dexie 事务里提交：任一行失败则整体回滚，额度恢复原状；
 *   原始文件留存为 failed/pending 导入批次，可「重开继续处理」。
 * - 回执按幂等键与回执号去重：重复导入不重复占用额度。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  db,
  getAuthorization,
  listAllTourPerformances,
  listAuthorizations,
  listImportBatches,
  listPlays,
  listTourBatches,
  putAuthorization,
  putImportBatch,
  putTourBatch,
  putTourPerformance,
  removeImportBatch,
  removeTourBatch,
  removeTourPerformance,
  type AuthorizationRow,
  type ImportBatchRow,
  type TourBatchRow,
  type TourPerformanceRow,
} from '../utils/db';
import type {
  AuthorizationDraft,
  AuthBasis,
  ImportKind,
  ImportRowResult,
  ImportStatus,
  ReconVerdict,
  TroupeTeam,
  TourBatchDraft,
  TourPerformanceDraft,
} from '../types/tour';
import { nowIso, uuid } from '../utils/uuid';
import { matchActiveAuth, normalizePlayTitle, reconcilePerformances } from '../utils/tourRecon';
import {
  buildIdempotencyKey,
  missingHeaders,
  parseSheet,
  validateAuthRow,
  validateReceiptRow,
  validateScheduleRow,
  type ParsedSheet,
  type ReceiptLineData,
  type ScheduleLineData,
} from '../utils/tourImport';

type ValidatedScheduleLine = { line: number; data: ScheduleLineData };
type ValidatedReceiptLine = { line: number; data: ReceiptLineData };

export interface ProcessOutcome {
  batchId: string;
  status: ImportStatus;
  message: string;
  results: ImportRowResult[];
  /** 整批因重复导入被跳过（不占额度） */
  duplicated: boolean;
}

interface TourStoreState {
  ready: boolean;
  loading: boolean;
  authorizations: AuthorizationRow[];
  batches: TourBatchRow[];
  performances: TourPerformanceRow[];
  importBatches: ImportBatchRow[];
  /** 本地剧目 id → 剧名 */
  playTitleById: Map<string, string>;
  loadTour: () => Promise<void>;

  createAuthorization: (draft: AuthorizationDraft) => Promise<AuthorizationRow>;
  updateAuthorization: (id: string, patch: Partial<AuthorizationDraft>) => Promise<void>;
  supersedeAuthorization: (oldId: string, draft: AuthorizationDraft) => Promise<AuthorizationRow>;
  revokeAuthorization: (id: string) => Promise<void>;
  removeAuthorization: (id: string) => Promise<void>;

  createBatch: (draft: TourBatchDraft) => Promise<TourBatchRow>;
  updateBatch: (id: string, patch: Partial<TourBatchDraft>) => Promise<void>;
  deleteBatch: (id: string) => Promise<void>;

  addPerformance: (draft: TourPerformanceDraft) => Promise<TourPerformanceRow>;
  performPerformance: (id: string, receiptNo?: string) => Promise<void>;
  cancelPerformance: (id: string) => Promise<void>;
  reopenPerformance: (id: string) => Promise<void>;
  removePerformance: (id: string) => Promise<void>;

  importFile: (kind: ImportKind, fileName: string, text: string) => Promise<ProcessOutcome | { error: string }>;
  reprocessImport: (batchId: string) => Promise<ProcessOutcome | null>;
  discardImport: (batchId: string) => Promise<void>;
}

/** 手动预占 / 导入排期共用：剧名认领本地剧目 id */
function resolvePlayId(
  playId: string | null,
  playTitle: string,
  plays: ReadonlyArray<{ id: string; title: string }>,
): string | null {
  if (playId && plays.some((play) => play.id === playId)) return playId;
  const wanted = normalizePlayTitle(playTitle);
  const hit = plays.find((play) => normalizePlayTitle(play.title) === wanted);
  return hit ? hit.id : null;
}

function withTimestamps<T extends object>(partial: T, stamp: string): T & { createdAt: string; updatedAt: string; revision: number } {
  return { ...partial, createdAt: stamp, updatedAt: stamp, revision: ROW_REVISION };
}

/** 预占场次行构造（held，匹配现行授权） */
function buildHeldRow(params: {
  batchId: string;
  team: TroupeTeam;
  playId: string | null;
  playTitle: string;
  showDate: string;
  region: string;
  venue: string;
  note?: string;
  auths: AuthorizationRow[];
  stamp: string;
}): TourPerformanceRow {
  const active = params.auths.filter((auth) => auth.status === 'active');
  const matched = matchActiveAuth({ playId: params.playId, playTitle: params.playTitle }, active);
  return {
    id: uuid(),
    batchId: params.batchId,
    playId: params.playId,
    playTitle: params.playTitle,
    team: params.team,
    showDate: params.showDate,
    region: params.region,
    venue: params.venue,
    state: 'held',
    matchedAuthId: matched ? matched.id : null,
    basis: null,
    performedAt: null,
    receiptNo: null,
    note: params.note ?? '',
    createdAt: params.stamp,
    updatedAt: params.stamp,
    revision: ROW_REVISION,
  };
}

/** 演完转已用：冻结当时授权依据 */
function freezeBasis(performance: TourPerformanceRow, auths: AuthorizationRow[]): AuthBasis | null {
  const active = auths.filter((auth) => auth.status === 'active');
  const matched =
    (performance.matchedAuthId ? auths.find((auth) => auth.id === performance.matchedAuthId) : undefined) ??
    matchActiveAuth({ playId: performance.playId, playTitle: performance.playTitle }, active);
  // 以当前最新核对结论冻结（即便当时超额/越范围也如实记录，已演批次保留原依据）
  const verdictRow = reconcilePerformances(auths, [{ ...performance, state: 'held' }])[0];
  if (!matched) {
    return {
      authorizationId: '',
      docNo: '',
      versionNo: 0,
      validFrom: '',
      validTo: '',
      quota: 0,
      regions: [],
      verdict: verdictRow ? (verdictRow.verdict as ReconVerdict) : 'no-auth',
    };
  }
  return {
    authorizationId: matched.id,
    docNo: matched.docNo,
    versionNo: matched.versionNo,
    validFrom: matched.validFrom,
    validTo: matched.validTo,
    quota: matched.quota,
    regions: [...matched.regions],
    verdict: verdictRow ? (verdictRow.verdict as ReconVerdict) : 'ok',
  };
}

export const useTourStore = create<TourStoreState>((set, get) => ({
  ready: false,
  loading: false,
  authorizations: [],
  batches: [],
  performances: [],
  importBatches: [],
  playTitleById: new Map(),

  async loadTour() {
    set({ loading: true });
    try {
      const [authorizations, batches, performances, importBatches, plays] = await Promise.all([
        listAuthorizations(),
        listTourBatches(),
        listAllTourPerformances(),
        listImportBatches(),
        listPlays(),
      ]);
      set({
        authorizations,
        batches,
        performances,
        importBatches,
        playTitleById: new Map(plays.map((play) => [play.id, play.title])),
        ready: true,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, ready: true });
      throw error;
    }
  },

  /* ------------------------------ 授权书 ------------------------------ */

  async createAuthorization(draft) {
    const stamp = nowIso();
    const row: AuthorizationRow = withTimestamps(
      {
        id: uuid(),
        docNo: draft.docNo.trim(),
        playId: draft.playId,
        playTitle: draft.playTitle.trim(),
        regions: [...draft.regions],
        validFrom: draft.validFrom,
        validTo: draft.validTo,
        quota: draft.quota,
        versionNo: 1,
        status: 'active',
        supersededById: null,
        statusChangedAt: null,
        issuer: draft.issuer.trim(),
        note: draft.note.trim(),
      },
      stamp,
    );
    await putAuthorization(row);
    await get().loadTour();
    return row;
  },

  async updateAuthorization(id, patch) {
    const existing = await getAuthorization(id);
    if (!existing) return;
    const next: AuthorizationRow = {
      ...existing,
      ...patch,
      regions: patch.regions ? [...patch.regions] : existing.regions,
      // 范围 / 额度任何变更都升一个版本号；未演场次据此按新范围核对
      versionNo: existing.versionNo + 1,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    await putAuthorization(next);
    await get().loadTour();
  },

  async supersedeAuthorization(oldId, draft) {
    const existing = await getAuthorization(oldId);
    if (!existing) throw new Error('原授权书不存在');
    const stamp = nowIso();
    const newRow: AuthorizationRow = withTimestamps(
      {
        id: uuid(),
        docNo: draft.docNo.trim(),
        playId: draft.playId ?? existing.playId,
        playTitle: draft.playTitle.trim() || existing.playTitle,
        regions: [...draft.regions],
        validFrom: draft.validFrom,
        validTo: draft.validTo,
        quota: draft.quota,
        versionNo: existing.versionNo + 1,
        status: 'active',
        supersededById: null,
        statusChangedAt: null,
        issuer: draft.issuer.trim(),
        note: draft.note.trim(),
      },
      stamp,
    );
    const oldRow: AuthorizationRow = {
      ...existing,
      status: 'superseded',
      supersededById: newRow.id,
      statusChangedAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await db.transaction('rw', db.authorizations, async () => {
      await db.authorizations.bulkPut([oldRow, newRow]);
    });
    await get().loadTour();
    return newRow;
  },

  async revokeAuthorization(id) {
    const existing = await getAuthorization(id);
    if (!existing) return;
    const stamp = nowIso();
    await putAuthorization({
      ...existing,
      status: 'revoked',
      statusChangedAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    await get().loadTour();
  },

  async removeAuthorization(id) {
    await db.authorizations.delete(id);
    await get().loadTour();
  },

  /* ------------------------------ 巡演批次 ------------------------------ */

  async createBatch(draft) {
    const stamp = nowIso();
    const row: TourBatchRow = withTimestamps(
      {
        id: uuid(),
        name: draft.name.trim() || '未命名批次',
        team: draft.team,
        planFrom: draft.planFrom,
        planTo: draft.planTo,
        note: draft.note.trim(),
      },
      stamp,
    );
    await putTourBatch(row);
    await get().loadTour();
    return row;
  },

  async updateBatch(id, patch) {
    const existing = get().batches.find((batch) => batch.id === id);
    if (!existing) return;
    await putTourBatch({ ...existing, ...patch, updatedAt: nowIso(), revision: ROW_REVISION });
    await get().loadTour();
  },

  async deleteBatch(id) {
    await removeTourBatch(id);
    await get().loadTour();
  },

  /* ------------------------------ 巡演场次 ------------------------------ */

  async addPerformance(draft) {
    const { authorizations, playTitleById } = get();
    const plays = [...playTitleById.entries()].map(([id, title]) => ({ id, title }));
    const playId = resolvePlayId(draft.playId, draft.playTitle, plays);
    const batch = get().batches.find((item) => item.id === draft.batchId);
    const stamp = nowIso();
    const row = buildHeldRow({
      batchId: draft.batchId,
      team: batch ? batch.team : 'teamA',
      playId,
      playTitle: draft.playTitle.trim(),
      showDate: draft.showDate,
      region: draft.region.trim(),
      venue: draft.venue.trim(),
      note: draft.note.trim(),
      auths: authorizations,
      stamp,
    });
    await putTourPerformance(row);
    await get().loadTour();
    return row;
  },

  async performPerformance(id, receiptNo) {
    const performance = get().performances.find((item) => item.id === id);
    if (!performance || performance.state !== 'held') return;
    const stamp = nowIso();
    const basis = freezeBasis(performance, get().authorizations);
    const next: TourPerformanceRow = {
      ...performance,
      state: 'performed',
      basis,
      performedAt: stamp,
      receiptNo: receiptNo?.trim() || performance.receiptNo,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putTourPerformance(next);
    await get().loadTour();
  },

  async cancelPerformance(id) {
    const performance = get().performances.find((item) => item.id === id);
    if (!performance || performance.state !== 'held') return;
    const stamp = nowIso();
    // 取消即释放预占额度：matchedAuthId 保留作审计，但不参与额度计算
    await putTourPerformance({
      ...performance,
      state: 'cancelled',
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    await get().loadTour();
  },

  async reopenPerformance(id) {
    const performance = get().performances.find((item) => item.id === id);
    if (!performance || performance.state !== 'cancelled') return;
    const { authorizations } = get();
    const active = authorizations.filter((auth) => auth.status === 'active');
    const matched = matchActiveAuth({ playId: performance.playId, playTitle: performance.playTitle }, active);
    const stamp = nowIso();
    // 重开 = 重新预占额度，按当前授权重新核对
    await putTourPerformance({
      ...performance,
      state: 'held',
      matchedAuthId: matched ? matched.id : null,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    await get().loadTour();
  },

  async removePerformance(id) {
    await removeTourPerformance(id);
    await get().loadTour();
  },

  /* ------------------------------ 导入流程 ------------------------------ */

  async importFile(kind, fileName, text) {
    const sheet = parseSheet(text, kind);
    const missing = missingHeaders(kind, sheet.headers);
    if (sheet.rawRows.length === 0) {
      return { error: '文件没有可导入的数据行' };
    }
    if (missing.length > 0) {
      // 表头不符：留存待核对批次（不占额度），用户修正文件后可重开
      const outcome = await persistUnprocessable(kind, fileName, sheet, `表头缺少必需列：${missing.join('、')}`);
      await get().loadTour();
      return outcome;
    }

    // 整批幂等：同一文件已成功导入则整批跳过（回执重复导入不再占用）
    const key = buildIdempotencyKey(kind, fileName, sheet.rawRows);
    const succeeded = get().importBatches.find(
      (batch) => batch.idempotencyKey === key && batch.status === 'success',
    );
    if (succeeded) {
      return {
        batchId: succeeded.id,
        status: 'success',
        message: '该文件已成功导入过，整批重复内容已跳过，未重复占用额度',
        results: succeeded.results,
        duplicated: true,
      };
    }

    const batchId = uuid();
    const stamp = nowIso();
    const outcome = await runImport(kind, batchId, sheet, stamp);
    await persistOutcome(batchId, kind, fileName, key, sheet, outcome, stamp);
    await get().loadTour();
    return outcome;
  },

  async reprocessImport(batchId) {
    const batch = get().importBatches.find((item) => item.id === batchId);
    if (!batch) return null;
    const sheet: ParsedSheet = { headers: inferHeaders(batch.kind), rawRows: batch.rawRows };
    const stamp = nowIso();
    const outcome = await runImport(batch.kind, batchId, sheet, stamp);
    await persistOutcome(batchId, batch.kind, batch.fileName, batch.idempotencyKey, sheet, outcome, stamp);
    await get().loadTour();
    return outcome;
  },

  async discardImport(batchId) {
    await removeImportBatch(batchId);
    await get().loadTour();
  },
}));

/** 表头不符时留存一条 failed 记账（无任何额度变动） */
async function persistUnprocessable(
  kind: ImportKind,
  fileName: string,
  sheet: ParsedSheet,
  message: string,
): Promise<ProcessOutcome> {
  const batchId = uuid();
  const stamp = nowIso();
  const key = buildIdempotencyKey(kind, fileName, sheet.rawRows);
  const row: ImportBatchRow = {
    id: batchId,
    kind,
    fileName,
    status: 'failed',
    importedAt: stamp,
    processedAt: stamp,
    idempotencyKey: key,
    rawRows: sheet.rawRows,
    results: [],
    message,
    affectedIds: [],
    note: '表头未通过，未写入任何数据',
    revision: ROW_REVISION,
  };
  await putImportBatch(row);
  return { batchId, status: 'failed', message, results: [], duplicated: false };
}

/** 把处理结果（成功/失败）落为导入记账行 */
async function persistOutcome(
  batchId: string,
  kind: ImportKind,
  fileName: string,
  key: string,
  sheet: ParsedSheet,
  outcome: ProcessOutcome,
  stamp: string,
): Promise<void> {
  const existing = await getImportBatchSafe(batchId);
  const row: ImportBatchRow = {
    id: batchId,
    kind,
    fileName,
    status: outcome.status,
    importedAt: existing?.importedAt ?? stamp,
    processedAt: stamp,
    idempotencyKey: existing?.idempotencyKey ?? key,
    rawRows: sheet.rawRows,
    results: outcome.results,
    message: outcome.message,
    affectedIds: outcome.status === 'success' ? outcome.results.filter((r) => r.ok).map((r) => r.entityId ?? '') : [],
    note:
      outcome.status === 'failed'
        ? '整批已回滚、额度恢复原状；修正后可「重开继续处理」'
        : existing?.note ?? '',
    revision: ROW_REVISION,
  };
  await putImportBatch(row);
}

async function getImportBatchSafe(id: string): Promise<ImportBatchRow | undefined> {
  return db.importBatches.get(id);
}

/** 由导入类型反推必需表头，重开时按原始字段直接重新校验 */
function inferHeaders(kind: ImportKind): ParsedSheet['headers'] {
  if (kind === 'auth') return ['docNo', 'playTitle', 'regions', 'validFrom', 'validTo', 'quota', 'issuer', 'note'];
  if (kind === 'schedule') return ['batchName', 'team', 'showDate', 'region', 'venue', 'playTitle', 'note'];
  return ['receiptNo', 'showDate', 'region', 'venue', 'playTitle'];
}

/**
 * 在单个事务里处理整批：
 * - 先逐行校验，任一行不过 → 直接判 failed，不开写事务（额度原样不动）。
 * - 校验全过后开 rw 事务顺序应用；一旦写入阶段抛错，Dexie 自动回滚全部已写额度。
 */
async function runImport(
  kind: ImportKind,
  batchId: string,
  sheet: ParsedSheet,
  stamp: string,
): Promise<ProcessOutcome> {
  const results: ImportRowResult[] = [];
  try {
    if (kind === 'auth') {
      await processAuth(sheet, results, stamp);
    } else if (kind === 'schedule') {
      await processSchedule(sheet, results, stamp);
    } else {
      await processReceipt(sheet, results, stamp);
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      return {
        batchId,
        status: 'failed',
        message: `${failed.length} 行未通过，整批已回滚、额度恢复原状（共 ${results.length} 行）`,
        results,
        duplicated: false,
      };
    }
    return {
      batchId,
      status: 'success',
      message: `全部 ${results.length} 行处理成功`,
      results,
      duplicated: false,
    };
  } catch (error) {
    // 事务异常：Dexie 已回滚，这里只如实记账
    return {
      batchId,
      status: 'failed',
      message: `处理中断，已回滚全部写入：${error instanceof Error ? error.message : '未知错误'}`,
      results,
      duplicated: false,
    };
  }
}

/* ------------------------------ 三类处理器 ------------------------------ */

async function processAuth(sheet: ParsedSheet, results: ImportRowResult[], stamp: string): Promise<void> {
  const rowsToPut: AuthorizationRow[] = [];
  for (const raw of sheet.rawRows) {
    const checked = validateAuthRow(raw);
    if (!checked.ok) {
      results.push({ line: raw.line, ok: false, error: checked.error });
      continue;
    }
    const { draft } = checked.data;
    // 同文号已存在 → 视为授权更新：升版本号就地改（未演场次按新范围核对）
    const existing = await db.authorizations.where('docNo').equals(draft.docNo).first();
    if (existing) {
      const next: AuthorizationRow = {
        ...existing,
        playId: draft.playId ?? existing.playId,
        playTitle: draft.playTitle,
        regions: draft.regions,
        validFrom: draft.validFrom,
        validTo: draft.validTo,
        quota: draft.quota,
        issuer: draft.issuer || existing.issuer,
        note: draft.note || existing.note,
        versionNo: existing.versionNo + 1,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      rowsToPut.push(next);
      results.push({ line: raw.line, ok: true, entityId: existing.id, action: `授权书 ${draft.docNo} 更新至 v${next.versionNo}，未演场次将按新范围核对` });
    } else {
      const row: AuthorizationRow = {
        id: uuid(),
        docNo: draft.docNo,
        playId: draft.playId,
        playTitle: draft.playTitle,
        regions: draft.regions,
        validFrom: draft.validFrom,
        validTo: draft.validTo,
        quota: draft.quota,
        versionNo: 1,
        status: 'active',
        supersededById: null,
        statusChangedAt: null,
        issuer: draft.issuer,
        note: draft.note,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      rowsToPut.push(row);
      results.push({ line: raw.line, ok: true, entityId: row.id, action: `新增授权书 ${draft.docNo}（${draft.regions.join('、')}，${draft.quota} 场）` });
    }
  }
  if (results.some((r) => !r.ok)) return; // 有坏行：不进写事务，额度/授权原样不动
  await db.transaction('rw', db.authorizations, async () => {
    await db.authorizations.bulkPut(rowsToPut);
  });
}

async function processSchedule(sheet: ParsedSheet, results: ImportRowResult[], stamp: string): Promise<void> {
  const parsed: ValidatedScheduleLine[] = [];
  for (const raw of sheet.rawRows) {
    const checked = validateScheduleRow(raw);
    if (!checked.ok) {
      results.push({ line: raw.line, ok: false, error: checked.error });
    } else {
      parsed.push({ line: raw.line, data: checked.data });
    }
  }
  if (results.some((r) => !r.ok)) return;

  const plays = await db.plays.toArray();
  const playRefs = plays.map((play) => ({ id: play.id, title: play.title }));

  await db.transaction('rw', db.tourBatches, db.tourPerformances, db.authorizations, async () => {
    const auths = await db.authorizations.toArray();
    const existingBatches = await db.tourBatches.toArray();
    const existingPerformances = await db.tourPerformances.toArray();

    const batchByName = new Map(existingBatches.map((batch) => [`${batch.team}|${batch.name}`, batch]));
    const heldKeys = new Set(
      existingPerformances
        .filter((p) => p.state === 'held')
        .map((p) => `${p.batchId}|${p.showDate}|${normalizePlayTitle(p.region)}|${normalizePlayTitle(p.venue)}|${p.playId ?? normalizePlayTitle(p.playTitle)}`),
    );

    for (const item of parsed) {
      const { data, line } = item;
      let batch = batchByName.get(`${data.team}|${data.batchName}`);
      if (!batch) {
        batch = {
          id: uuid(),
          name: data.batchName,
          team: data.team,
          planFrom: data.showDate,
          planTo: data.showDate,
          note: '排期导入自动建批',
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
        batchByName.set(`${data.team}|${data.batchName}`, batch);
        await db.tourBatches.put(batch);
      }
      const playId = resolvePlayId(data.playId, data.playTitle, playRefs);
      const playKey = playId ?? normalizePlayTitle(data.playTitle);
      const dedupeKey = `${batch.id}|${data.showDate}|${normalizePlayTitle(data.region)}|${normalizePlayTitle(data.venue)}|${playKey}`;
      if (heldKeys.has(dedupeKey)) {
        results.push({ line, ok: true, action: '排期重复行已跳过，未重复预占' });
        continue;
      }
      heldKeys.add(dedupeKey);
      const row = buildHeldRow({
        batchId: batch.id,
        team: data.team,
        playId,
        playTitle: data.playTitle,
        showDate: data.showDate,
        region: data.region,
        venue: data.venue,
        note: data.note,
        auths,
        stamp,
      });
      await db.tourPerformances.put(row);
      results.push({
        line,
        ok: true,
        entityId: row.id,
        action: row.matchedAuthId
          ? `${TEAM_OF(data.team)}「${data.playTitle}」${data.showDate} ${data.region} 已预占额度`
          : `${TEAM_OF(data.team)}「${data.playTitle}」${data.showDate} ${data.region} 已排场次（缺现行授权书，待补）`,
      });
    }
  });
}

function TEAM_OF(team: TroupeTeam): string {
  return team === 'teamA' ? '甲队' : '乙队';
}

async function processReceipt(sheet: ParsedSheet, results: ImportRowResult[], stamp: string): Promise<void> {
  const parsed: ValidatedReceiptLine[] = [];
  for (const raw of sheet.rawRows) {
    const checked = validateReceiptRow(raw);
    if (!checked.ok) {
      results.push({ line: raw.line, ok: false, error: checked.error });
    } else {
      parsed.push({ line: raw.line, data: checked.data });
    }
  }
  if (results.some((r) => !r.ok)) return;

  const plays = await db.plays.toArray();
  const playRefs = plays.map((play) => ({ id: play.id, title: play.title }));

  await db.transaction('rw', db.tourPerformances, db.authorizations, db.importBatches, async () => {
    const auths = await db.authorizations.toArray();
    const all = await db.tourPerformances.toArray();
    const usedReceiptNos = new Set(
      all.filter((p) => p.state === 'performed' && p.receiptNo).map((p) => p.receiptNo as string),
    );

    for (const item of parsed) {
      const { data, line } = item;
      // 回执号已用于已演场次 → 重复回执，不再占用
      if (usedReceiptNos.has(data.receiptNo)) {
        results.push({ line, ok: true, action: `回执 ${data.receiptNo} 重复导入，已跳过，未重复占用额度` });
        continue;
      }
      const playId = resolvePlayId(data.playId, data.playTitle, playRefs);
      const titleKey = normalizePlayTitle(data.playTitle);
      // 找对应的本地预占场次：同剧目 + 同日期 + 同地区（戏台可缺省）
      const candidate = all
        .filter(
          (p) =>
            p.state === 'held' &&
            (playId ? p.playId === playId : normalizePlayTitle(p.playTitle) === titleKey) &&
            p.showDate === data.showDate &&
            normalizePlayTitle(p.region) === normalizePlayTitle(data.region) &&
            (data.venue === '' || normalizePlayTitle(p.venue) === normalizePlayTitle(data.venue)),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

      if (!candidate) {
        // 回执找不到对应预占场次：判失败 → 整批回滚，留存待核对，先补排期后重开
        results.push({
          line,
          ok: false,
          error: `回执 ${data.receiptNo}：找不到 ${data.showDate} ${data.region}《${data.playTitle}》的预占场次，请先补排期后重开`,
        });
        continue;
      }
      const basis = freezeBasis(candidate, auths);
      const next: TourPerformanceRow = {
        ...candidate,
        state: 'performed',
        basis,
        performedAt: stamp,
        receiptNo: data.receiptNo,
        updatedAt: stamp,
        revision: ROW_REVISION,
      };
      await db.tourPerformances.put(next);
      // 同步内存视图，保证同一批后续回执不会再次匹配到已转已用的场次
      const index = all.findIndex((p) => p.id === candidate.id);
      if (index >= 0) all[index] = next;
      usedReceiptNos.add(data.receiptNo);
      results.push({
        line,
        ok: true,
        entityId: candidate.id,
        action: `回执 ${data.receiptNo}：${TEAM_OF(candidate.team)}《${candidate.playTitle}》预占转已用，依据已冻结`,
      });
    }
    if (results.some((r) => !r.ok)) {
      // 抛错触发 Dexie 回滚：本批已转已用的场次全部恢复为预占，额度恢复原状
      throw new Error('存在无法匹配排期的回执');
    }
  });
}
