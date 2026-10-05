/**
 * 巡演授权对账数据模型
 *
 * 两条主线：
 * - 授权书（TourAuthorization）：外部批准范围，按剧目限定地区 / 日期 / 场次额度；
 *   更新授权走「换发新版本」，旧版本作废但保留，供已演场次留存原始依据。
 * - 巡演批次（TourBatch）：班社本地的场次安排导入单元，两个分队各自建批次；
 *   排场次导入先预占额度，回执导入后转已用；导入失败整段回滚、断点重开继续。
 */

/** 分队：班社巡演通常拆两队并行 */
export type TroupeCode = 'first' | 'second';

export const TROUPE_LABEL: Record<TroupeCode, string> = {
  first: '头队',
  second: '二队',
};

export const TROUPE_OPTIONS: ReadonlyArray<{ value: TroupeCode; label: string }> = [
  { value: 'first', label: '头队' },
  { value: 'second', label: '二队' },
];

/** 授权书状态：现行有效 / 已被新版替换（作废留存） */
export type AuthStatus = 'active' | 'superseded';

export const AUTH_STATUS_LABEL: Record<AuthStatus, string> = {
  active: '现行有效',
  superseded: '已作废',
};

/** 场次状态：待演（已预占或待核对） / 已演 / 已撤销（释放额度） */
export type ShowStatus = 'reserved' | 'performed' | 'cancelled';

export const SHOW_STATUS_LABEL: Record<ShowStatus, string> = {
  reserved: '待演',
  performed: '已演',
  cancelled: '已撤销',
};

export const SHOW_STATUS_COLOR: Record<ShowStatus, string> = {
  reserved: 'processing',
  performed: 'success',
  cancelled: 'default',
};

/** 一场安排与授权范围核对后可能出现的问题 */
export type ShowIssue =
  | 'NO_AUTH' // 该剧目没有任何授权书
  | 'REGION_OUT' // 演出地区不在授权范围
  | 'DATE_OUT' // 演出日期不在授权有效期
  | 'QUOTA_OVER' // 在范围内，但两队合计场次额度已占满
  | 'PLAY_MISSING'; // 本地剧目库里找不到对应剧目

export const SHOW_ISSUE_LABEL: Record<ShowIssue, string> = {
  NO_AUTH: '缺授权书',
  REGION_OUT: '超出限定地区',
  DATE_OUT: '超出授权日期',
  QUOTA_OVER: '两队合计额度不足',
  PLAY_MISSING: '剧目库中无此剧目',
};

export const SHOW_ISSUE_COLOR: Record<ShowIssue, string> = {
  NO_AUTH: 'error',
  REGION_OUT: 'warning',
  DATE_OUT: 'warning',
  QUOTA_OVER: 'error',
  PLAY_MISSING: 'error',
};

/**
 * 已演场次冻结的授权依据快照。
 * 换发新授权后只重核未演场次，已演场次永远以演完那一刻的授权书版本为准。
 */
export interface AuthBasis {
  authId: string;
  docNo: string;
  versionNo: number;
  regions: string[];
  dateFrom: string;
  dateTo: string;
  totalQuota: number;
}

/** 授权书（外部批准范围） */
export interface TourAuthorization {
  id: string;
  /** 所属剧目 */
  playId: string;
  /** 授权书文号 */
  docNo: string;
  /** 同一剧目的版本序号，从 1 起 */
  versionNo: number;
  status: AuthStatus;
  /** 批准的演出地区（精确到地市，精确匹配） */
  regions: string[];
  /** 有效期起 YYYY-MM-DD */
  dateFrom: string;
  /** 有效期止 YYYY-MM-DD */
  dateTo: string;
  /** 批准场次总额度（两队共用一池） */
  totalQuota: number;
  /** 发证日期 YYYY-MM-DD */
  issuedAt: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 换发授权书的表单草稿 */
export type AuthDraft = Pick<
  TourAuthorization,
  'docNo' | 'regions' | 'dateFrom' | 'dateTo' | 'totalQuota' | 'issuedAt' | 'note'
>;

/** 一场巡演安排（两个分队的场次合到同一池额度里对账） */
export interface TourShow {
  id: string;
  batchId: string;
  playId: string;
  troupe: TroupeCode;
  /** 场序（同批次内从 1 起） */
  seq: number;
  region: string;
  showDate: string;
  status: ShowStatus;
  /**
   * 额度所挂的授权书：
   * - 待演场：挂在现行有效版本上，授权更新 / 换发后按新范围重新核对，可能被释放改挂；
   * - 已演场：演完即冻结，永远保留当时的授权书（即使该书已作废）。
   */
  authId: string | null;
  /** 演完时冻结的授权依据；未演 / 待核对场为 null */
  basis: AuthBasis | null;
  /** 演出回执编号（全局唯一，重复导入据此识别） */
  receiptNo: string | null;
  /** 核对问题；无问题为空数组，表示已正常预占 */
  issues: ShowIssue[];
  createdAt: string;
  updatedAt: string;
}

/** 导入队列状态：未开始 / 处理中 / 失败待恢复 / 已处理完 */
export type QueueState = 'idle' | 'processing' | 'failed' | 'done';

export const QUEUE_STATE_LABEL: Record<QueueState, string> = {
  idle: '未开始',
  processing: '处理中',
  failed: '导入失败',
  done: '已处理完',
};

export const QUEUE_STATE_COLOR: Record<QueueState, string> = {
  idle: 'default',
  processing: 'processing',
  failed: 'error',
  done: 'success',
};

/** 排场次导入的一行原始数据 */
export interface ScheduleRowPayload {
  /** 不填默认用批次所属剧目；填了可在一个文件里夹带别的剧目 */
  playTitle?: string;
  region: string;
  showDate: string;
}

/** 回执导入的一行原始数据 */
export interface ReceiptRowPayload {
  receiptNo: string;
  region: string;
  showDate: string;
}

/**
 * 导入队列（断点续处理）。
 * pending 保存尚未确认的原始行：任何一段处理失败都会整段回滚额度，
 * pending 原样保留，重开批次后从队首继续。
 */
export interface ImportQueue<Row> {
  state: QueueState;
  /** 原始总行数 */
  total: number;
  /** 已确认处理的行数（含业务上跳过 / 重复的行） */
  processed: number;
  /** 尚未处理的原始行 */
  pending: Row[];
  /** 最近一次失败原因 */
  lastError: string | null;
  /** 最近一次致命错误行在 pending 中的下标（用于「丢弃坏行」精确定位） */
  errorOffset: number | null;
  /** 原始文件名，便于批次明细里追溯 */
  sourceFileName: string | null;
  updatedAt: string | null;
}

/** 回执处理留痕：applied 转已用 / duplicate 重复跳过 / unmatched 对不上场次 */
export type ReceiptLogResult = 'applied' | 'duplicate' | 'unmatched';

export const RECEIPT_LOG_RESULT_LABEL: Record<ReceiptLogResult, string> = {
  applied: '已转已用',
  duplicate: '重复回执，已跳过',
  unmatched: '对不上本地场次',
};

export interface ReceiptLogEntry {
  receiptNo: string;
  showDate: string;
  region: string;
  result: ReceiptLogResult;
  /** applied 时关联上的场次 id */
  showId: string | null;
  at: string;
}

/** 批次状态：待核对（还在排 / 有问题场次） / 巡演中 / 已结项 */
export type BatchStatus = 'preparing' | 'active' | 'closed';

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  preparing: '待核对',
  active: '巡演中',
  closed: '已结项',
};

export const BATCH_STATUS_COLOR: Record<BatchStatus, string> = {
  preparing: 'warning',
  active: 'processing',
  closed: 'default',
};

/** 巡演批次：一个分队一套本地场次安排，排场次与回执各一条导入队列 */
export interface TourBatch {
  id: string;
  /** 批次号，如 B2026-101 */
  batchNo: string;
  troupe: TroupeCode;
  /** 关联本地剧目；导入行里剧目始终对不上时允许为 null，批次列入待核对 */
  playId: string | null;
  /** 建批次时录入的剧目标题，剧目缺失时也能展示 */
  playTitle: string;
  note: string;
  status: BatchStatus;
  scheduleQueue: ImportQueue<ScheduleRowPayload>;
  receiptQueue: ImportQueue<ReceiptRowPayload>;
  /** 回执处理留痕（重复回执也在此留一条，方便对账解释） */
  receiptLog: ReceiptLogEntry[];
  createdAt: string;
  updatedAt: string;
}

export function emptyScheduleQueue(): ImportQueue<ScheduleRowPayload> {
  return { state: 'idle', total: 0, processed: 0, pending: [], lastError: null, errorOffset: null, sourceFileName: null, updatedAt: null };
}

export function emptyReceiptQueue(): ImportQueue<ReceiptRowPayload> {
  return { state: 'idle', total: 0, processed: 0, pending: [], lastError: null, errorOffset: null, sourceFileName: null, updatedAt: null };
}
