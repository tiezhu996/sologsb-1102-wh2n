/**
 * 巡演授权对账状态管理（Zustand）
 * 授权书（外部范围）/ 巡演批次（本地安排）/ 巡演场次三表的读模型与动作，
 * 事务性导入逻辑见 utils/db.ts。
 */
import { create } from 'zustand';
import {
  cancelTourShow,
  createAuthorization,
  discardErrorRow,
  editAuthorization,
  listAuthorizations,
  listTourBatches,
  listTourShows,
  putTourBatch,
  removeAuthorization,
  removeTourBatch,
  renewAuthorization,
  recheckAllShows,
  getTourBatch,
  processReceiptChunk,
  processScheduleChunk,
  type AuthRow,
  type TourBatchRow,
  type TourShowRow,
} from '../utils/db';
import type {
  AuthDraft,
  BatchStatus,
  ReceiptRowPayload,
  ScheduleRowPayload,
  TroupeCode,
} from '../types/tour';
import { emptyReceiptQueue, emptyScheduleQueue } from '../types/tour';
import { nowIso, uuid } from '../utils/uuid';
import { ROW_REVISION } from '../utils/db';

/** 解析后的导入文件 */
export interface ParsedImportFile<Row> {
  fileName: string;
  rows: Row[];
}

interface TourStoreState {
  auths: AuthRow[];
  batches: TourBatchRow[];
  shows: TourShowRow[];
  loading: boolean;
  error: string;
  loadTour: () => Promise<void>;

  // 授权书
  saveNewAuth: (playId: string, draft: AuthDraft) => Promise<void>;
  saveEditAuth: (authId: string, draft: AuthDraft) => Promise<void>;
  renewAuth: (oldAuthId: string, draft: AuthDraft) => Promise<void>;
  deleteAuth: (authId: string) => Promise<void>;
  recheckAll: () => Promise<void>;

  // 批次
  createBatch: (draft: {
    batchNo: string;
    troupe: TroupeCode;
    playId: string | null;
    playTitle: string;
    note: string;
  }) => Promise<TourBatchRow>;
  updateBatchStatus: (batchId: string, status: BatchStatus) => Promise<void>;
  deleteBatch: (batchId: string) => Promise<void>;
  enqueueSchedule: (batchId: string, file: ParsedImportFile<ScheduleRowPayload>) => Promise<void>;
  enqueueReceipts: (batchId: string, file: ParsedImportFile<ReceiptRowPayload>) => Promise<void>;
  continueSchedule: (batchId: string) => Promise<void>;
  continueReceipts: (batchId: string) => Promise<void>;
  discardScheduleError: (batchId: string) => Promise<void>;
  discardReceiptError: (batchId: string) => Promise<void>;
  cancelShow: (showId: string) => Promise<void>;
  showsOfBatch: (batchId: string) => TourShowRow[];
}

export const useTourStore = create<TourStoreState>((set, get) => ({
  auths: [],
  batches: [],
  shows: [],
  loading: false,
  error: '',

  async loadTour() {
    set({ loading: true, error: '' });
    try {
      const [auths, batches, shows] = await Promise.all([
        listAuthorizations(),
        listTourBatches(),
        listTourShows(),
      ]);
      set({ auths, batches, shows, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '巡演数据读取失败' });
    }
  },

  async saveNewAuth(playId, draft) {
    await createAuthorization(playId, draft);
    await get().loadTour();
  },

  async saveEditAuth(authId, draft) {
    await editAuthorization(authId, draft);
    await get().loadTour();
  },

  async renewAuth(oldAuthId, draft) {
    await renewAuthorization(oldAuthId, draft);
    await get().loadTour();
  },

  async deleteAuth(authId) {
    await removeAuthorization(authId);
    await get().loadTour();
  },

  async recheckAll() {
    await recheckAllShows();
    await get().loadTour();
  },

  async createBatch(draft) {
    const stamp = nowIso();
    const row: TourBatchRow = {
      id: uuid(),
      batchNo: draft.batchNo.trim() || `B-${stamp.slice(0, 10)}-${uuid().slice(0, 4)}`,
      troupe: draft.troupe,
      playId: draft.playId,
      playTitle: draft.playTitle.trim() || '未关联剧目',
      note: draft.note.trim(),
      status: 'preparing',
      scheduleQueue: emptyScheduleQueue(),
      receiptQueue: emptyReceiptQueue(),
      receiptLog: [],
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putTourBatch(row);
    await get().loadTour();
    return row;
  },

  async updateBatchStatus(batchId, status) {
    const batch = await getTourBatch(batchId);
    if (!batch) return;
    await putTourBatch({ ...batch, status, updatedAt: nowIso(), revision: ROW_REVISION });
    await get().loadTour();
  },

  async deleteBatch(batchId) {
    await removeTourBatch(batchId);
    await get().loadTour();
  },

  async enqueueSchedule(batchId, file) {
    const batch = await getTourBatch(batchId);
    if (!batch) throw new Error('巡演批次不存在');
    const stamp = nowIso();
    await putTourBatch({
      ...batch,
      scheduleQueue: {
        state: 'idle',
        total: file.rows.length,
        processed: 0,
        pending: file.rows.map((row) => ({ ...row })),
        lastError: null,
        errorOffset: null,
        sourceFileName: file.fileName,
        updatedAt: stamp,
      },
      status: batch.status === 'closed' ? 'closed' : 'preparing',
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    await get().loadTour();
    await get().continueSchedule(batchId);
  },

  async enqueueReceipts(batchId, file) {
    const batch = await getTourBatch(batchId);
    if (!batch) throw new Error('巡演批次不存在');
    const stamp = nowIso();
    await putTourBatch({
      ...batch,
      receiptQueue: {
        state: 'idle',
        total: file.rows.length,
        processed: 0,
        pending: file.rows.map((row) => ({ ...row })),
        lastError: null,
        errorOffset: null,
        sourceFileName: file.fileName,
        updatedAt: stamp,
      },
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    await get().loadTour();
    await get().continueReceipts(batchId);
  },

  async continueSchedule(batchId) {
    await processScheduleChunk(batchId);
    await get().loadTour();
  },

  async continueReceipts(batchId) {
    await processReceiptChunk(batchId);
    await get().loadTour();
  },

  async discardScheduleError(batchId) {
    await discardErrorRow(batchId, 'schedule');
    await get().loadTour();
  },

  async discardReceiptError(batchId) {
    await discardErrorRow(batchId, 'receipt');
    await get().loadTour();
  },

  async cancelShow(showId) {
    await cancelTourShow(showId);
    await get().loadTour();
  },

  showsOfBatch(batchId) {
    return get()
      .shows.filter((show) => show.batchId === batchId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
