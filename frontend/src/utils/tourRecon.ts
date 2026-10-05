/**
 * 巡演授权对账引擎（纯函数）
 *
 * 规则：
 * - 授权书管「外部批准范围」：剧目 + 地区 + 起止日期 + 场次额度；仅 status=active 参与核对。
 * - 已演（performed）场次冻结当时依据（performance.basis），授权更新后保留原依据、不重算。
 * - 预占（held）场次每次都按最新授权范围核对：无授权→待补；越区/超期→越范围；范围内但额度不足→超额。
 * - 额度占用：已演先占额度，预占按演出日期先后在剩余额度内排队，排不进的判「场次超额」。
 * - 已取消（cancelled）不占额度、不进对账单。
 */
import type {
  Authorization,
  PlayRecon,
  QuotaUsage,
  ReconRow,
  ReconVerdict,
  TourPerformance,
} from '../types/tour';

/** YYYY-MM-DD 合法且可按字符串比较 */
export function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 日期是否落在 [from, to]（含端点）；任一日期非法视为不在范围内 */
export function isDateInRange(date: string, from: string, to: string): boolean {
  if (!isDateString(date) || !isDateString(from) || !isDateString(to)) return false;
  return date >= from && date <= to;
}

/** 地区归一：去空白、转小写，便于「陕西·西安」与「陕西 西安」之外的精确匹配 */
function normalizeRegion(region: string): string {
  return region.trim().replace(/\s+/g, '').toLowerCase();
}

export function isRegionAllowed(region: string, regions: string[]): boolean {
  const target = normalizeRegion(region);
  if (target === '') return false;
  return regions.some((item) => normalizeRegion(item) === target);
}

/** 剧名归一：去空白与书名号，便于授权书旧剧名与本地剧目名互相认领 */
export function normalizePlayTitle(title: string): string {
  return title.trim().replace(/[《》\s]/g, '').toLowerCase();
}

function titlesEqual(a: string, b: string): boolean {
  const na = normalizePlayTitle(a);
  const nb = normalizePlayTitle(b);
  return na !== '' && na === nb;
}

/**
 * 为一场预占场次找现行授权书：优先按 playId 精确命中，其次按剧名认领（旧剧目无 id 关联时）。
 * 多份命中时取版本号最新、最近更新的一份。
 */
export function matchActiveAuth(
  performance: Pick<TourPerformance, 'playId' | 'playTitle'>,
  activeAuths: Authorization[],
): Authorization | null {
  const candidates = activeAuths.filter((auth) => {
    if (performance.playId && auth.playId === performance.playId) return true;
    return titlesEqual(auth.playTitle, performance.playTitle);
  });
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (b.versionNo !== a.versionNo) return b.versionNo - a.versionNo;
    return b.updatedAt.localeCompare(a.updatedAt);
  })[0];
}

/** 一份授权的额度占用（已演 + 在范围预占）。预占场次按现行授权实时归属，不依赖排期当时缓存的 matchedAuthId */
export function buildQuotaUsage(
  auth: Authorization,
  performances: TourPerformance[],
  activeAuths: Authorization[],
): QuotaUsage {
  let used = 0;
  let held = 0;
  for (const p of performances) {
    if (p.state === 'performed') {
      if (p.basis?.authorizationId === auth.id) used += 1;
      continue;
    }
    if (p.state !== 'held') continue;
    // 补登/换发授权后，未演场次按最新授权重新认领
    const matched = matchActiveAuth({ playId: p.playId, playTitle: p.playTitle }, activeAuths);
    if (!matched || matched.id !== auth.id) continue;
    if (
      isRegionAllowed(p.region, auth.regions) &&
      isDateInRange(p.showDate, auth.validFrom, auth.validTo)
    ) {
      held += 1;
    }
  }
  const committed = used + held;
  return {
    authId: auth.id,
    quota: auth.quota,
    held,
    used,
    committed,
    overflow: Math.max(0, committed - auth.quota),
    remaining: Math.max(0, auth.quota - committed),
  };
}

/** 全部授权额度占用，按超额最严重在前排序 */
export function buildQuotaUsages(
  auths: Authorization[],
  performances: TourPerformance[],
): QuotaUsage[] {
  const active = auths.filter((auth) => auth.status === 'active');
  return active
    .map((auth) => buildQuotaUsage(auth, performances, active))
    .sort((a, b) => b.overflow - a.overflow || b.committed - a.committed);
}

interface HeldEval {
  performance: TourPerformance;
  auth: Authorization | null;
  inRegion: boolean;
  inDate: boolean;
  /** 额度排队名次（0 起），排在剩余额度之外即为超额 */
  capacityIndex: number;
  capacity: number;
}

/**
 * 生成全部预占场次的对账行。
 * 已演场次单独走冻结依据，两者合并为 ReconRow[] 返回。
 */
export function reconcilePerformances(
  auths: Authorization[],
  performances: TourPerformance[],
): ReconRow[] {
  const active = auths.filter((auth) => auth.status === 'active');
  const activeById = new Map(active.map((auth) => [auth.id, auth]));

  // 已演：保留原依据，不随授权更新重算
  const performedRows: ReconRow[] = performances
    .filter((p) => p.state === 'performed')
    .map((p) => {
      const basis = p.basis;
      return {
        performance: p,
        verdict: (basis?.verdict ?? 'ok') as ReconVerdict,
        basisAuthId: basis?.authorizationId ?? p.matchedAuthId,
        basisDocNo: basis?.docNo ?? null,
        reasons: basis
          ? [`已演保留 ${basis.versionNo ? `v${basis.versionNo} ` : ''}原依据${basis.docNo ? `（${basis.docNo}）` : ''}`]
          : ['已演（未登记授权依据）'],
      };
    });

  // 预占：按授权分组，先判范围，再按演出日期排额度
  const heldEvals: HeldEval[] = performances
    .filter((p) => p.state === 'held')
    .map((performance) => {
      const auth = matchActiveAuth(performance, active);
      return {
        performance,
        auth,
        inRegion: auth ? isRegionAllowed(performance.region, auth.regions) : false,
        inDate: auth ? isDateInRange(performance.showDate, auth.validFrom, auth.validTo) : false,
        capacityIndex: 0,
        capacity: 0,
      };
    });

  // 每个授权：已演先扣额度，范围内预占按日期/创建时间排队
  const usedByAuth = new Map<string, number>();
  for (const p of performances) {
    if (p.state === 'performed' && p.basis) {
      usedByAuth.set(p.basis.authorizationId, (usedByAuth.get(p.basis.authorizationId) ?? 0) + 1);
    }
  }
  const evalsByAuth = new Map<string, HeldEval[]>();
  for (const evalItem of heldEvals) {
    if (!evalItem.auth || !evalItem.inRegion || !evalItem.inDate) continue;
    const list = evalsByAuth.get(evalItem.auth.id) ?? [];
    list.push(evalItem);
    evalsByAuth.set(evalItem.auth.id, list);
  }
  for (const [authId, list] of evalsByAuth) {
    const auth = activeById.get(authId);
    if (!auth) continue;
    const capacity = Math.max(0, auth.quota - (usedByAuth.get(authId) ?? 0));
    list
      .sort((a, b) =>
        a.performance.showDate.localeCompare(b.performance.showDate) ||
        a.performance.createdAt.localeCompare(b.performance.createdAt),
      )
      .forEach((evalItem, index) => {
        evalItem.capacityIndex = index;
        evalItem.capacity = capacity;
      });
  }

  const heldRows: ReconRow[] = heldEvals.map((evalItem) => {
    const { performance: p, auth } = evalItem;
    const reasons: string[] = [];
    let verdict: ReconVerdict;
    if (!auth) {
      verdict = 'no-auth';
      reasons.push('旧剧目缺现行授权书，先列待补');
    } else if (!evalItem.inRegion) {
      verdict = 'out-of-scope-region';
      reasons.push(`演出地区「${p.region}」不在批准范围：${auth.regions.join('、') || '未列地区'}`);
    } else if (!evalItem.inDate) {
      verdict = 'out-of-scope-date';
      reasons.push(`演出日期 ${p.showDate} 不在批准期 ${auth.validFrom} ~ ${auth.validTo}`);
    } else if (evalItem.capacityIndex >= evalItem.capacity) {
      verdict = 'over-quota';
      reasons.push(
        `场次额度 ${auth.quota}（已演 ${usedByAuth.get(auth.id) ?? 0}、预占顺位 ${evalItem.capacityIndex + 1}），合起来没有额度`,
      );
    } else {
      verdict = 'ok';
      reasons.push(`在批准范围内，占用第 ${usedByAuth.get(auth.id)! + evalItem.capacityIndex + 1} 场额度`);
    }
    return {
      performance: p,
      verdict,
      basisAuthId: auth?.id ?? null,
      basisDocNo: auth?.docNo ?? null,
      reasons,
    };
  });

  // 日期靠前的排前面，便于逐场对账
  return [...performedRows, ...heldRows].sort(
    (a, b) =>
      a.performance.showDate.localeCompare(b.performance.showDate) ||
      a.performance.createdAt.localeCompare(b.performance.createdAt),
  );
}

/** 剧组分组键：有关联剧目按 playId，否则按归一剧名 */
function groupKeyOf(p: TourPerformance): string {
  return p.playId ? `id:${p.playId}` : `title:${normalizePlayTitle(p.playTitle)}`;
}

/**
 * 按剧目聚合对账单。
 * @param playTitleById 本地剧目库 id → 剧名，用于把授权书/旧场次认领回现存剧目
 */
export function buildPlayRecons(
  auths: Authorization[],
  performances: TourPerformance[],
  playTitleById: ReadonlyMap<string, string>,
): PlayRecon[] {
  const rows = reconcilePerformances(auths, performances);
  const groups = new Map<string, ReconRow[]>();
  for (const row of rows) {
    const key = groupKeyOf(row.performance);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const active = auths.filter((auth) => auth.status === 'active');

  const result: PlayRecon[] = [];
  for (const [key, groupRows] of groups) {
    const first = groupRows[0].performance;
    const playId = key.startsWith('id:') ? first.playId : groupRows.find((r) => r.performance.playId)?.performance.playId ?? null;
    const playTitle =
      (playId && playTitleById.get(playId)) || first.playTitle || '未命名剧目';

    // 该剧目当前命中的现行授权书
    const currentAuth =
      (playId
        ? active.find((auth) => auth.playId === playId)
        : undefined) ?? matchActiveAuth({ playId, playTitle }, active);

    const heldCount = groupRows.filter((r) => r.performance.state === 'held').length;
    const usedCount = groupRows.filter((r) => r.performance.state === 'performed').length;
    const problemCount = groupRows.filter(
      (r) => r.performance.state === 'held' && r.verdict !== 'ok',
    ).length;

    result.push({
      playId,
      playTitle,
      currentAuth,
      usage: currentAuth ? buildQuotaUsage(currentAuth, performances, active) : null,
      rows: groupRows,
      heldCount,
      usedCount,
      problemCount,
    });
  }

  // 有待补/越范围/超额问题的剧目排最前，其次剧名
  return result.sort(
    (a, b) =>
      b.problemCount - a.problemCount ||
      a.playTitle.localeCompare(b.playTitle, 'zh-Hans-CN'),
  );
}
