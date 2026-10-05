/**
 * 巡演授权对账（Tour Authorization Reconciliation）领域模型
 *
 * 三方数据：
 * - Authorization（授权书）：外部批准范围，按剧目限定地区、起止日期与场次额度；
 *   同一剧目可换发新版（supersedesId），已演批次保留旧版依据，未演场次按最新版核对。
 * - TourBatch（巡演批次）：班社本地排的一批外出场次，属于某个分队。
 * - TourPerformance（巡演场次）：批次里的单场，排场次先「预占」额度，演完转「已用」。
 *
 * 导入（回执 / 授权书）以 ImportBatch 记账：整批要么成功落库，要么失败回滚额度，
 * 原始文件保留为「待核对」，可修正后重开继续处理；回执幂等键去重，重复导入不再占额度。
 */

/** 两个巡演分队：各排一套戏 */
export type TroupeTeam = 'teamA' | 'teamB';

/** 授权书状态：现行有效 / 已被新版换发 / 已废止 */
export type AuthorizationStatus = 'active' | 'superseded' | 'revoked';

/**
 * 巡演场次生命周期：
 * - held       已排场次，额度预占中（尚未演）
 * - performed  已演完，额度转已用（冻结当时依据，不再受授权更新影响）
 * - cancelled  已取消，释放预占额度
 */
export type PerformanceState = 'held' | 'performed' | 'cancelled';

/** 对账结论（仅针对 held 场次；performed/cancelled 不参与重新核对） */
export type ReconVerdict =
  | 'ok' // 在授权范围内，额度充足
  | 'no-auth' // 旧剧目缺授权书（待补）
  | 'out-of-scope-region' // 地区不在批准范围
  | 'out-of-scope-date' // 日期不在批准起止区间
  | 'over-quota'; // 在范围内但场次额度不足（合起来没额度）

/** 导入批次类型 */
export type ImportKind = 'auth' | 'schedule' | 'receipt';

/** 导入批次处理状态 */
export type ImportStatus =
  | 'success' // 整批落库成功
  | 'failed' // 处理失败：已恢复/未落任何额度，原始文件保留待核对
  | 'pending'; // 待核对：修正后可「重开继续处理」

export const TEAM_OPTIONS: ReadonlyArray<{ value: TroupeTeam; label: string }> = [
  { value: 'teamA', label: '甲队' },
  { value: 'teamB', label: '乙队' },
];

export const TEAM_LABEL: Record<TroupeTeam, string> = {
  teamA: '甲队',
  teamB: '乙队',
};

export const AUTH_STATUS_LABEL: Record<AuthorizationStatus, string> = {
  active: '现行',
  superseded: '已换发',
  revoked: '已废止',
};

export const PERFORMANCE_STATE_LABEL: Record<PerformanceState, string> = {
  held: '预占中',
  performed: '已演·已用',
  cancelled: '已取消',
};

export const PERFORMANCE_STATE_COLOR: Record<PerformanceState, string> = {
  held: 'processing',
  performed: 'success',
  cancelled: 'default',
};

export const RECON_VERDICT_LABEL: Record<ReconVerdict, string> = {
  ok: '额度内',
  'no-auth': '待补授权书',
  'out-of-scope-region': '越区',
  'out-of-scope-date': '超期',
  'over-quota': '场次超额',
};

export const RECON_VERDICT_COLOR: Record<ReconVerdict, string> = {
  ok: 'success',
  'no-auth': 'warning',
  'out-of-scope-region': 'error',
  'out-of-scope-date': 'error',
  'over-quota': 'error',
};

export const IMPORT_KIND_LABEL: Record<ImportKind, string> = {
  auth: '授权书导入',
  schedule: '批次排期导入',
  receipt: '演出回执导入',
};

export const IMPORT_STATUS_LABEL: Record<ImportStatus, string> = {
  success: '成功',
  failed: '失败·已回滚',
  pending: '待核对',
};

export const IMPORT_STATUS_COLOR: Record<ImportStatus, string> = {
  success: 'success',
  failed: 'error',
  pending: 'warning',
};

/** 授权书（外部批准范围） */
export interface Authorization {
  /** 主键 */
  id: string;
  /** 授权书编号（外部批准文号） */
  docNo: string;
  /** 剧目 id（与本地剧目库关联；旧剧目可能暂缺） */
  playId: string | null;
  /** 剧目名快照（授权书上写的剧名，用于与本地剧目核对） */
  playTitle: string;
  /** 批准可演地区列表 */
  regions: string[];
  /** 批准起始日期 YYYY-MM-DD（含） */
  validFrom: string;
  /** 批准截止日期 YYYY-MM-DD（含） */
  validTo: string;
  /** 批准总场次额度 */
  quota: number;
  /** 版本号：新建为 1，范围/额度每次更新 +1（已演场次据此保留原依据） */
  versionNo: number;
  /** 现行 / 已换发 / 已废止 */
  status: AuthorizationStatus;
  /** 被哪个新版换发（status=superseded 时） */
  supersededById: string | null;
  /** 换发/废止时间（ISO） */
  statusChangedAt: string | null;
  /** 发证机关/备注 */
  issuer: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** 巡演批次（本地场次安排） */
export interface TourBatch {
  id: string;
  /** 批次名，如「秋后关中巡演」 */
  name: string;
  /** 分队 */
  team: TroupeTeam;
  /** 计划起止（展示用） */
  planFrom: string;
  planTo: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** 冻结在已演场次上的授权依据快照（授权更新后已演批次保留原依据） */
export interface AuthBasis {
  authorizationId: string;
  docNo: string;
  /** 判定时授权书版本号（revision 计数，见 Authorization.versionNo） */
  versionNo: number;
  validFrom: string;
  validTo: string;
  quota: number;
  regions: string[];
  /** 判为已用时的结论，便于事后追溯 */
  verdict: ReconVerdict;
}

/** 巡演场次（批次里的单场） */
export interface TourPerformance {
  id: string;
  batchId: string;
  playId: string | null;
  playTitle: string;
  team: TroupeTeam;
  /** 演出日期 YYYY-MM-DD */
  showDate: string;
  region: string;
  /** 影戏院/戏台名 */
  venue: string;
  state: PerformanceState;
  /** 排期时匹配到的授权书（held 期间会随授权更新重算，可空=无授权） */
  matchedAuthId: string | null;
  /** 已演时冻结的授权依据；held/cancelled 为 null */
  basis: AuthBasis | null;
  /** 已演/取消时间（ISO） */
  performedAt: string | null;
  /** 关联的演出回执号（幂等键来源） */
  receiptNo: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** 导入文件里解析出的原始行（授权书/排期/回执统一为字符串行，逐行报错定位） */
export interface ImportRawRow {
  /** 行号（从 1 起，含表头偏移由解析器决定） */
  line: number;
  /** 原始字段（键已 trim、保持小写英文/中文表头映射后的标准键） */
  fields: Record<string, string>;
}

/** 导入批次（一次文件导入的记账单元，支撑失败回滚与重开续处理） */
export interface ImportBatch {
  id: string;
  kind: ImportKind;
  /** 原始文件名 */
  fileName: string;
  status: ImportStatus;
  /** 收到/导入时间（ISO） */
  importedAt: string;
  /** 成功/失败/重开处理时间（ISO） */
  processedAt: string | null;
  /** 幂等键：回执号 + 场次日期/地区 等，用于整批去重（已成功处理过则整批跳过） */
  idempotencyKey: string;
  /** 解析出的原始行（待核对批次据此重开） */
  rawRows: ImportRawRow[];
  /** 处理结果逐行结论 */
  results: ImportRowResult[];
  /** 失败/汇总原因 */
  message: string;
  /** 已被本批次写入的实体 id（成功行），用于失败回滚与审计 */
  affectedIds: string[];
  note: string;
}

/** 单行导入处理结果 */
export interface ImportRowResult {
  line: number;
  ok: boolean;
  /** 写入的实体 id（成功时） */
  entityId?: string;
  /** 错误信息（失败时） */
  error?: string;
  /** 处理动作描述，如「已预占额度」「重复回执跳过」「已转已用」 */
  action?: string;
}

/** 单个授权书的额度占用汇总 */
export interface QuotaUsage {
  authId: string;
  quota: number;
  held: number;
  used: number;
  /** 已演 + 在预占 */
  committed: number;
  /** committed - quota，>0 即超额 */
  overflow: number;
  remaining: number;
}

/** 单场对账行（给 UI 的核对结果） */
export interface ReconRow {
  performance: TourPerformance;
  verdict: ReconVerdict;
  /** 判定依据的授权书 id（held 用现行，performed 用冻结快照） */
  basisAuthId: string | null;
  basisDocNo: string | null;
  /** 不通过原因（人类可读） */
  reasons: string[];
}

/** 按剧目聚合的对账单 */
export interface PlayRecon {
  playId: string | null;
  playTitle: string;
  /** 该剧名命中的现行授权书（可能为空=旧剧目缺授权书，待补） */
  currentAuth: Authorization | null;
  usage: QuotaUsage | null;
  rows: ReconRow[];
  heldCount: number;
  usedCount: number;
  problemCount: number;
}

/** 授权书表单草稿 */
export type AuthorizationDraft = Pick<
  Authorization,
  'docNo' | 'playId' | 'playTitle' | 'regions' | 'validFrom' | 'validTo' | 'quota' | 'issuer' | 'note'
>;

/** 巡演批次表单草稿 */
export type TourBatchDraft = Pick<TourBatch, 'name' | 'team' | 'planFrom' | 'planTo' | 'note'>;

/** 巡演场次表单草稿 */
export type TourPerformanceDraft = Pick<
  TourPerformance,
  'playId' | 'playTitle' | 'showDate' | 'region' | 'venue' | 'note'
> & { batchId: string };
