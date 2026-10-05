/**
 * 巡演导入文件解析（排场次 / 演出回执，JSON）
 * 解析阶段只做结构校验并明确报错；业务核对与事务在 store / db 层完成。
 */
import type { ReceiptRowPayload, ScheduleRowPayload } from '../types/tour';

/** 触发浏览器下载（与 export.ts 保持一致的本地下载方式） */
function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export const SCHEDULE_TEMPLATE = {
  kind: 'tour-schedule',
  description: '巡演排场次导入模板：playTitle 可省略（默认批次所属剧目），地区须与授权书一致，日期 YYYY-MM-DD',
  rows: [
    { playTitle: '白蛇传·借伞', region: '唐山市', showDate: '2026-10-06' },
    { region: '天津市', showDate: '2026-10-20' },
  ],
} as const;

export const RECEIPT_TEMPLATE = {
  kind: 'tour-receipt',
  description: '演出回执导入模板：receiptNo 全局唯一，重复导入自动识别且不再占用额度',
  rows: [
    { receiptNo: 'HZ-2026-1006-01', region: '唐山市', showDate: '2026-10-06' },
  ],
} as const;

export function downloadScheduleTemplate(): string {
  const filename = '巡演排场次-导入模板.json';
  download(filename, JSON.stringify(SCHEDULE_TEMPLATE, null, 2));
  return filename;
}

export function downloadReceiptTemplate(): string {
  const filename = '演出回执-导入模板.json';
  download(filename, JSON.stringify(RECEIPT_TEMPLATE, null, 2));
  return filename;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('文件应为 JSON 对象，且包含 rows 数组');
  }
  return value as Record<string, unknown>;
}

/** 解析排场次文件 */
export async function parseScheduleFile(file: File): Promise<ScheduleRowPayload[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('文件不是合法 JSON');
  }
  const root = asRecord(parsed);
  const rows = root.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('缺少 rows 列表或列表为空');
  }
  return rows.map((raw, index) => {
    const item = asRecord(raw);
    const region = typeof item.region === 'string' ? item.region.trim() : '';
    const showDate = typeof item.showDate === 'string' ? item.showDate.trim() : '';
    if (!region) throw new Error(`第 ${index + 1} 行缺少演出地区 region`);
    if (!showDate) throw new Error(`第 ${index + 1} 行缺少演出日期 showDate`);
    return {
      playTitle: typeof item.playTitle === 'string' && item.playTitle.trim() !== '' ? item.playTitle.trim() : undefined,
      region,
      showDate,
    };
  });
}

/** 解析演出回执文件 */
export async function parseReceiptFile(file: File): Promise<ReceiptRowPayload[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('文件不是合法 JSON');
  }
  const root = asRecord(parsed);
  const rows = root.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('缺少 rows 列表或列表为空');
  }
  return rows.map((raw, index) => {
    const item = asRecord(raw);
    const receiptNo = typeof item.receiptNo === 'string' ? item.receiptNo.trim() : '';
    const region = typeof item.region === 'string' ? item.region.trim() : '';
    const showDate = typeof item.showDate === 'string' ? item.showDate.trim() : '';
    if (!receiptNo) throw new Error(`第 ${index + 1} 行缺少回执编号 receiptNo`);
    if (!region) throw new Error(`第 ${index + 1} 行缺少演出地区 region`);
    if (!showDate) throw new Error(`第 ${index + 1} 行缺少演出日期 showDate`);
    return { receiptNo, region, showDate };
  });
}
