/**
 * 巡演授权对账：纯逻辑函数（无 IndexedDB / DOM 依赖，便于单测与事务内复用）
 *
 * 核对规则：
 * 1. 授权书管外部批准范围：地区精确匹配、日期闭区间、场次额度按剧目一池两队共用；
 * 2. 排场次先预占额度：核对通过的待演场 authId 挂到现行授权书并计数；
 * 3. 演完转已用：已演场冻结 AuthBasis，之后任何授权更新都不再动它；
 * 4. 授权更新 / 换发后，只对未演（reserved）场次按新范围重新核对；
 * 5. 核对不通过的场次不占额度（authId=null + issues），列入待核对。
 */
import type {
  AuthBasis,
  ShowIssue,
  TourAuthorization,
  TourBatch,
  TourShow,
} from '../types/tour';

/** 日期格式 YYYY-MM-DD 校验（允许词法比较） */
export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** 地区是否在授权范围内（trim 后精确匹配） */
export function regionAllowed(region: string, auth: TourAuthorization): boolean {
  const target = region.trim();
  return auth.regions.some((item) => item.trim() === target);
}

/** 演出日期是否在授权有效期闭区间内 */
export function dateAllowed(showDate: string, auth: TourAuthorization): boolean {
  if (!isIsoDate(showDate) || !isIsoDate(auth.dateFrom) || !isIsoDate(auth.dateTo)) return false;
  return showDate >= auth.dateFrom && showDate <= auth.dateTo;
}

/** 从授权书生成已演场次的依据快照 */
export function authBasisOf(auth: TourAuthorization): AuthBasis {
  return {
    authId: auth.id,
    docNo: auth.docNo,
    versionNo: auth.versionNo,
    regions: [...auth.regions],
    dateFrom: auth.dateFrom,
    dateTo: auth.dateTo,
    totalQuota: auth.totalQuota,
  };
}

/** 取某剧目的现行有效授权（按版本号取最大） */
export function activeAuthOf(
  auths: TourAuthorization[],
  playId: string,
): TourAuthorization | null {
  const candidates = auths
    .filter((auth) => auth.playId === playId && auth.status === 'active')
    .sort((a, b) => b.versionNo - a.versionNo);
  return candidates[0] ?? null;
}

/** 取某剧目全部授权书，版本号倒序（旧版已作废但保留可查） */
export function authHistoryOf(auths: TourAuthorization[], playId: string): TourAuthorization[] {
  return auths
    .filter((auth) => auth.playId === playId)
    .sort((a, b) => b.versionNo - a.versionNo);
}

/** 额度占用统计：已用（已演）+ 预占（待演）= 已占，待核对场不计数 */
export interface QuotaUsage {
  total: number;
  used: number;
  reserved: number;
  held: number;
  remaining: number;
}

export function quotaUsageOf(
  auth: TourAuthorization,
  shows: TourShow[],
): QuotaUsage {
  let used = 0;
  let reserved = 0;
  for (const show of shows) {
    if (show.authId !== auth.id || show.status === 'cancelled') continue;
    if (show.status === 'performed') used += 1;
    else if (show.status === 'reserved') reserved += 1;
  }
  const held = used + reserved;
  return {
    total: auth.totalQuota,
    used,
    reserved,
    held,
    remaining: Math.max(0, auth.totalQuota - held),
  };
}

export interface SlotEval {
  ok: boolean;
  authId: string | null;
  issues: ShowIssue[];
}

/**
 * 核对单场是否可以预占某授权书的额度。
 * heldCount 为调用方按到场顺序统计的「在该授权上已占用场次数」。
 */
export function evaluateSlot(params: {
  playExists: boolean;
  auth: TourAuthorization | null;
  region: string;
  showDate: string;
  heldCount: number;
}): SlotEval {
  const { playExists, auth, region, showDate, heldCount } = params;
  if (!playExists) return { ok: false, authId: null, issues: ['PLAY_MISSING'] };
  if (!auth) return { ok: false, authId: null, issues: ['NO_AUTH'] };
  const issues: ShowIssue[] = [];
  if (!regionAllowed(region, auth)) issues.push('REGION_OUT');
  if (!dateAllowed(showDate, auth)) issues.push('DATE_OUT');
  if (heldCount >= auth.totalQuota) issues.push('QUOTA_OVER');
  if (issues.length > 0) return { ok: false, authId: null, issues };
  return { ok: true, authId: auth.id, issues: [] };
}

/**
 * 授权更新 / 换发后，对全部未演场次按新范围重新核对，生成落库计划。
 * - 已演（performed）场次跳过：保留原依据快照，旧版作废也不动；
 * - 已撤销（cancelled）场次跳过；
 * - 待演（reserved）场按 剧目 → 演出日期 → 创建顺序 逐场重新分配额度，
 *   先核对通过的先预占，后面两队合计超额的场次退为待核对（QUOTA_OVER）。
 */
export function planReservedRecheck(
  shows: TourShow[],
  auths: TourAuthorization[],
  playIds: Set<string>,
): Map<string, { authId: string | null; issues: ShowIssue[] }> {
  const plan = new Map<string, { authId: string | null; issues: ShowIssue[] }>();
  // 每个授权书当前已占用的场次数（含已演冻结场——已演依据即使挂旧版也不参与新版池）
  const heldByAuth = new Map<string, number>();
  for (const show of shows) {
    if (show.authId && show.status !== 'cancelled') {
      heldByAuth.set(show.authId, (heldByAuth.get(show.authId) ?? 0) + 1);
    }
  }

  const pending = shows
    .filter((show) => show.status === 'reserved')
    .sort((a, b) => {
      if (a.showDate !== b.showDate) return a.showDate < b.showDate ? -1 : 1;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.createdAt < b.createdAt ? -1 : 1;
    });

  for (const show of pending) {
    // 先把它旧的预占释放，再重新核对
    if (show.authId) {
      const prev = heldByAuth.get(show.authId) ?? 0;
      heldByAuth.set(show.authId, Math.max(0, prev - 1));
    }
    const auth = activeAuthOf(auths, show.playId);
    const evalResult = evaluateSlot({
      playExists: playIds.has(show.playId),
      auth,
      region: show.region,
      showDate: show.showDate,
      heldCount: auth ? heldByAuth.get(auth.id) ?? 0 : 0,
    });
    plan.set(show.id, { authId: evalResult.authId, issues: evalResult.issues });
    if (evalResult.ok && auth) {
      heldByAuth.set(auth.id, (heldByAuth.get(auth.id) ?? 0) + 1);
    }
  }
  return plan;
}

/** 场次上的问题是否仍未消化（待核对） */
export function showPending(show: TourShow): boolean {
  return show.status !== 'cancelled' && show.issues.length > 0;
}

export interface BatchStat {
  batchId: string;
  total: number;
  reserved: number;
  performed: number;
  cancelled: number;
  pendingIssue: number;
}

export function batchStatOf(batchId: string, shows: TourShow[]): BatchStat {
  const own = shows.filter((show) => show.batchId === batchId && show.status !== 'cancelled');
  return {
    batchId,
    total: own.length,
    reserved: own.filter((show) => show.status === 'reserved').length,
    performed: own.filter((show) => show.status === 'performed').length,
    cancelled: shows.filter((show) => show.batchId === batchId && show.status === 'cancelled').length,
    pendingIssue: own.filter((show) => show.issues.length > 0).length,
  };
}

/** 缺授权书待补的剧目：已在巡演批次中出现，但一份授权书都没有 */
export function missingAuthPlayIds(
  batches: TourBatch[],
  auths: TourAuthorization[],
): string[] {
  const arranged = new Set<string>();
  for (const batch of batches) {
    if (batch.playId) arranged.add(batch.playId);
  }
  return [...arranged]
    .filter((playId) => !auths.some((auth) => auth.playId === playId))
    .sort();
}

/** 全局额度汇总，供对账页顶部概览 */
export interface TourSummary {
  authCount: number;
  activeAuthCount: number;
  batchCount: number;
  showTotal: number;
  showPerformed: number;
  showReserved: number;
  showPendingIssue: number;
}

export function summarizeTour(params: {
  auths: TourAuthorization[];
  batches: TourBatch[];
  shows: TourShow[];
}): TourSummary {
  const live = params.shows.filter((show) => show.status !== 'cancelled');
  return {
    authCount: params.auths.length,
    activeAuthCount: params.auths.filter((auth) => auth.status === 'active').length,
    batchCount: params.batches.length,
    showTotal: live.length,
    showPerformed: live.filter((show) => show.status === 'performed').length,
    showReserved: live.filter((show) => show.status === 'reserved').length,
    showPendingIssue: live.filter((show) => show.issues.length > 0).length,
  };
}

/** 回执匹配：同剧目、同地区、同日期、仍是待演且已预占额度的场次 */
export function matchShowForReceipt(
  shows: TourShow[],
  params: { batchId: string; region: string; showDate: string },
): TourShow | null {
  const region = params.region.trim();
  return (
    shows.find(
      (show) =>
        show.batchId === params.batchId &&
        show.status === 'reserved' &&
        show.authId !== null &&
        show.region.trim() === region &&
        show.showDate === params.showDate,
    ) ?? null
  );
}

/** 授权书展示用范围文案 */
export function authScopeText(auth: TourAuthorization): string {
  return `${auth.regions.join('、') || '未填地区'}｜${auth.dateFrom} 至 ${auth.dateTo}`;
}
