/**
 * 巡演授权对账 · 导入解析层（纯函数）
 *
 * 支持三类文件（CSV / TSV 均可，自动按逗号或制表符切分，兼容引号包裹）：
 * 1. 授权书导入：授权书号,剧目,地区,开始日期,结束日期,场次额度,发证机关,备注
 * 2. 排期导入：  批次,分队,日期,地区,戏台,剧目,备注
 * 3. 回执导入：  回执号,日期,地区,戏台,剧目
 *
 * 解析器只做「文本 → 结构化行 + 行级校验」，不落库；
 * 真正的预占 / 转已用 / 回滚在 tourStore 的事务里完成，失败可保留原始行重开续处理。
 */
import type {
  AuthorizationDraft,
  ImportKind,
  ImportRawRow,
  TroupeTeam,
} from '../types/tour';
import { TEAM_LABEL } from '../types/tour';
import { isDateString } from './tourRecon';

/** 解析后的列：表头别名 → 标准键 */
export type HeaderKey =
  | 'docNo'
  | 'playTitle'
  | 'playId'
  | 'regions'
  | 'validFrom'
  | 'validTo'
  | 'quota'
  | 'issuer'
  | 'batchName'
  | 'team'
  | 'showDate'
  | 'region'
  | 'venue'
  | 'receiptNo'
  | 'note';

const HEADER_ALIASES: Array<{ key: HeaderKey; aliases: string[] }> = [
  { key: 'docNo', aliases: ['授权书号', '授权书', '文号', '批准文号', 'docno', 'doc'] },
  { key: 'playTitle', aliases: ['剧目', '剧目名', '剧名', 'play', 'playtitle', 'title'] },
  { key: 'playId', aliases: ['剧目id', 'playid', 'play_id'] },
  { key: 'regions', aliases: ['地区', '演出地区', '批准地区', 'regions', 'region'] },
  { key: 'validFrom', aliases: ['开始日期', '起始日期', '生效日期', 'validfrom', 'from'] },
  { key: 'validTo', aliases: ['结束日期', '截止日期', '失效日期', 'validto', 'to'] },
  { key: 'quota', aliases: ['场次额度', '额度', '场次数', '批准场次', 'quota'] },
  { key: 'issuer', aliases: ['发证机关', '批准单位', '机关', 'issuer'] },
  { key: 'batchName', aliases: ['批次', '巡演批次', '批次名', 'batch', 'batchname'] },
  { key: 'team', aliases: ['分队', '队伍', '队', 'team'] },
  { key: 'showDate', aliases: ['日期', '演出日期', '场日期', 'showdate', 'date'] },
  { key: 'region', aliases: ['地区', '演出地区', '巡演地区', 'region', 'city'] },
  { key: 'venue', aliases: ['戏台', '戏院', '场馆', '场地', 'venue', 'theater'] },
  { key: 'receiptNo', aliases: ['回执号', '回执', '凭证号', 'receiptno', 'receipt'] },
  { key: 'note', aliases: ['备注', '说明', 'note', 'memo'] },
];

/** 去 BOM、统一换行 */
function normalizeText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** 切分单行：支持双引号包裹与转义 "" */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/** 解析整份文本为二维数组（CSV 或 TSV，自动识别分隔符） */
function parseGrid(text: string): string[][] {
  const normalized = normalizeText(text);
  if (normalized.trim() === '') return [];
  const firstLine = normalized.split('\n', 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') && (firstLine.match(/\t/g) ?? []).length >= 1 ? '\t' : ',';
  return normalized
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => splitLine(line, delimiter));
}

function lookupHeaderKey(headerName: string, kind: ImportKind): HeaderKey | null {
  const normalized = headerName.trim().replace(/\s+/g, '').toLowerCase();
  for (const { key, aliases } of HEADER_ALIASES) {
    // 「地区」在授权书里是批准地区列表（regions），在排期/回执里是单场演出地区（region）
    if (key === 'regions' && kind !== 'auth') continue;
    if (key === 'region' && kind === 'auth') continue;
    if (aliases.some((alias) => alias.replace(/\s+/g, '').toLowerCase() === normalized)) return key;
  }
  return null;
}

export interface ParsedSheet {
  /** 表头标准键顺序（未知表头被丢弃） */
  headers: HeaderKey[];
  rawRows: ImportRawRow[];
}

/** 通用解析：第一行表头，其余为数据行。kind 决定「地区」等同义表头的归属 */
export function parseSheet(text: string, kind: ImportKind = 'schedule'): ParsedSheet {
  const grid = parseGrid(text);
  if (grid.length === 0) return { headers: [], rawRows: [] };
  const headerCells = grid[0];
  const headers: HeaderKey[] = [];
  headerCells.forEach((cell) => {
    const key = lookupHeaderKey(cell, kind);
    if (key && !headers.includes(key)) headers.push(key);
  });
  const rawRows: ImportRawRow[] = [];
  for (let i = 1; i < grid.length; i += 1) {
    const cells = grid[i];
    const fields: Record<string, string> = {};
    headers.forEach((key, index) => {
      fields[key] = (cells[index] ?? '').trim();
    });
    rawRows.push({ line: i + 1, fields });
  }
  return { headers, rawRows };
}

/** 该导入类型必需的列 */
const REQUIRED_HEADERS: Record<ImportKind, HeaderKey[]> = {
  auth: ['docNo', 'playTitle', 'regions', 'validFrom', 'validTo', 'quota'],
  schedule: ['batchName', 'team', 'showDate', 'region', 'playTitle'],
  receipt: ['receiptNo', 'showDate', 'region', 'playTitle'],
};

/** 表头检查，返回缺失列（空数组表示通过） */
export function missingHeaders(kind: ImportKind, headers: HeaderKey[]): HeaderKey[] {
  return REQUIRED_HEADERS[kind].filter((required) => !headers.includes(required));
}

/* ----------------------------- 行级校验 ----------------------------- */

/** 地区串拆为列表（支持 、，,/ 空格 分隔） */
export function splitRegions(value: string): string[] {
  return value
    .split(/[、，,\/；;\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 分队文本 → team（支持 甲/甲队/teamA/A） */
export function parseTeam(value: string): TroupeTeam | null {
  const text = value.trim().toLowerCase();
  if (['甲', '甲队', 'a', 'teama', 'team a', '一队'].includes(text)) return 'teamA';
  if (['乙', '乙队', 'b', 'teamb', 'team b', '二队'].includes(text)) return 'teamB';
  return null;
}

export interface AuthLineData {
  draft: AuthorizationDraft;
}

/** 授权书行校验 */
export function validateAuthRow(row: ImportRawRow): { ok: true; data: AuthLineData } | { ok: false; error: string } {
  const f = row.fields;
  const docNo = (f.docNo ?? '').trim();
  const playTitle = (f.playTitle ?? '').trim();
  const regions = splitRegions(f.regions ?? '');
  const validFrom = (f.validFrom ?? '').trim();
  const validTo = (f.validTo ?? '').trim();
  const quotaText = (f.quota ?? '').trim();

  if (!docNo) return { ok: false, error: '缺少授权书号' };
  if (!playTitle) return { ok: false, error: '缺少剧目名' };
  if (regions.length === 0) return { ok: false, error: '缺少批准地区' };
  if (!isDateString(validFrom)) return { ok: false, error: `开始日期非法：${validFrom || '空'}` };
  if (!isDateString(validTo)) return { ok: false, error: `结束日期非法：${validTo || '空'}` };
  if (validFrom > validTo) return { ok: false, error: `开始日期晚于结束日期（${validFrom} > ${validTo}）` };
  const quota = Number(quotaText);
  if (!Number.isInteger(quota) || quota <= 0) return { ok: false, error: `场次额度须为正整数：${quotaText || '空'}` };

  const playId = (f.playId ?? '').trim() || null;
  return {
    ok: true,
    data: {
      draft: {
        docNo,
        playId,
        playTitle,
        regions,
        validFrom,
        validTo,
        quota,
        issuer: (f.issuer ?? '').trim(),
        note: (f.note ?? '').trim(),
      },
    },
  };
}

export interface ScheduleLineData {
  batchName: string;
  team: TroupeTeam;
  showDate: string;
  region: string;
  venue: string;
  playId: string | null;
  playTitle: string;
  note: string;
}

/** 排期行校验 */
export function validateScheduleRow(
  row: ImportRawRow,
): { ok: true; data: ScheduleLineData } | { ok: false; error: string } {
  const f = row.fields;
  const batchName = (f.batchName ?? '').trim();
  const team = parseTeam(f.team ?? '');
  const showDate = (f.showDate ?? '').trim();
  const region = (f.region ?? '').trim();
  const venue = (f.venue ?? '').trim();
  const playTitle = (f.playTitle ?? '').trim();

  if (!batchName) return { ok: false, error: '缺少巡演批次名' };
  if (!team) return { ok: false, error: `分队无法识别：${(f.team ?? '').trim() || '空'}（应为 ${TEAM_LABEL.teamA}/${TEAM_LABEL.teamB}）` };
  if (!isDateString(showDate)) return { ok: false, error: `演出日期非法：${showDate || '空'}` };
  if (!region) return { ok: false, error: '缺少演出地区' };
  if (!playTitle) return { ok: false, error: '缺少剧目名' };

  return {
    ok: true,
    data: {
      batchName,
      team,
      showDate,
      region,
      venue,
      playId: (f.playId ?? '').trim() || null,
      playTitle,
      note: (f.note ?? '').trim(),
    },
  };
}

export interface ReceiptLineData {
  receiptNo: string;
  showDate: string;
  region: string;
  venue: string;
  playId: string | null;
  playTitle: string;
}

/** 回执行校验 */
export function validateReceiptRow(
  row: ImportRawRow,
): { ok: true; data: ReceiptLineData } | { ok: false; error: string } {
  const f = row.fields;
  const receiptNo = (f.receiptNo ?? '').trim();
  const showDate = (f.showDate ?? '').trim();
  const region = (f.region ?? '').trim();
  const venue = (f.venue ?? '').trim();
  const playTitle = (f.playTitle ?? '').trim();

  if (!receiptNo) return { ok: false, error: '缺少回执号' };
  if (!isDateString(showDate)) return { ok: false, error: `演出日期非法：${showDate || '空'}` };
  if (!region) return { ok: false, error: '缺少演出地区' };
  if (!playTitle) return { ok: false, error: '缺少剧目名' };

  return {
    ok: true,
    data: {
      receiptNo,
      showDate,
      region,
      venue,
      playId: (f.playId ?? '').trim() || null,
      playTitle,
    },
  };
}

/** 整批幂等键：类型 + 文件名 + 每行关键值，保证同一文件重复导入可整批识别 */
export function buildIdempotencyKey(kind: ImportKind, fileName: string, rows: ImportRawRow[]): string {
  const payload = `${kind}|${fileName}|` + rows.map((r) => Object.values(r.fields).join('~')).join('||');
  let hash = 0;
  for (let i = 0; i < payload.length; i += 1) {
    hash = (hash * 31 + payload.charCodeAt(i)) | 0;
  }
  return `${kind}:${(hash >>> 0).toString(36)}:${rows.length}`;
}
