/**
 * 巡演批次明细抽屉：
 * - 排场次导入（先预占额度）/ 演出回执导入（演完转已用，重复回执跳过）；
 * - 导入失败：整段已回滚、额度恢复，可丢弃定位到的坏行，其余行继续处理；
 * - 场次表展示预占 / 已用 / 待核对问题与已演场次的冻结授权依据。
 */
import { useRef, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CaretRightOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileDoneOutlined,
  FileSyncOutlined,
  StopOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { TourBatchRow, TourShowRow } from '../../utils/db';
import {
  QUEUE_STATE_COLOR,
  QUEUE_STATE_LABEL,
  RECEIPT_LOG_RESULT_LABEL,
  SHOW_ISSUE_COLOR,
  SHOW_ISSUE_LABEL,
  SHOW_STATUS_COLOR,
  SHOW_STATUS_LABEL,
  TROUPE_LABEL,
  type ReceiptRowPayload,
  type ScheduleRowPayload,
} from '../../types/tour';
import { useTourStore } from '../../stores/tourStore';
import {
  downloadReceiptTemplate,
  downloadScheduleTemplate,
  parseReceiptFile,
  parseScheduleFile,
} from '../../utils/tourImport';

interface Props {
  batch: TourBatchRow;
  shows: TourShowRow[];
  /** 剧目名称映射 */
  playName: (playId: string | null) => string;
  /** 授权书号映射 */
  authLabel: (authId: string | null) => { text: string; superseded: boolean } | null;
  onClose: () => void;
}

type BusyKey = 'schedule' | 'receipt' | 'show' | 'status' | null;

export default function BatchDrawer(props: Props) {
  const { batch, shows, playName, authLabel, onClose } = props;
  const { message } = App.useApp();
  const scheduleInputRef = useRef<HTMLInputElement | null>(null);
  const receiptInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<BusyKey>(null);

  const enqueueSchedule = useTourStore((state) => state.enqueueSchedule);
  const enqueueReceipts = useTourStore((state) => state.enqueueReceipts);
  const continueSchedule = useTourStore((state) => state.continueSchedule);
  const continueReceipts = useTourStore((state) => state.continueReceipts);
  const discardScheduleError = useTourStore((state) => state.discardScheduleError);
  const discardReceiptError = useTourStore((state) => state.discardReceiptError);
  const cancelShow = useTourStore((state) => state.cancelShow);
  const updateBatchStatus = useTourStore((state) => state.updateBatchStatus);
  const deleteBatch = useTourStore((state) => state.deleteBatch);

  const run = async (key: BusyKey, action: () => Promise<void>, success?: string) => {
    setBusy(key);
    try {
      await action();
      if (success) message.success(success);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(null);
    }
  };

  const handleScheduleFile = (file: File) => {
    void (async () => {
      try {
        const rows = await parseScheduleFile(file);
        const payload: Array<ScheduleRowPayload> = rows.map((row) => ({
          playTitle: row.playTitle,
          region: row.region,
          showDate: row.showDate,
        }));
        await run('schedule', async () => {
          await enqueueSchedule(batch.id, { fileName: file.name, rows: payload });
        });
        message.success(`排场次 ${payload.length} 行已导入并完成核对`);
      } catch (error) {
        message.error(`排场次文件无法读取：${error instanceof Error ? error.message : '解析失败'}`);
      }
    })();
  };

  const handleReceiptFile = (file: File) => {
    void (async () => {
      try {
        const rows: ReceiptRowPayload[] = await parseReceiptFile(file);
        await run('receipt', async () => {
          await enqueueReceipts(batch.id, { fileName: file.name, rows });
        });
        message.success(`回执 ${rows.length} 行已导入`);
      } catch (error) {
        message.error(`回执文件无法读取：${error instanceof Error ? error.message : '解析失败'}`);
      }
    })();
  };

  const percentOf = (done: number, total: number): number => (total === 0 ? 0 : Math.round((done / total) * 100));
  const sq = batch.scheduleQueue;
  const rq = batch.receiptQueue;
  /** 上次失败定位到的坏行（errorOffset 精确指向 pending 中的位置） */
  const badScheduleRow =
    sq.errorOffset !== null && sq.errorOffset >= 0 && sq.errorOffset < sq.pending.length
      ? sq.pending[sq.errorOffset]
      : null;
  const badReceiptRow =
    rq.errorOffset !== null && rq.errorOffset >= 0 && rq.errorOffset < rq.pending.length
      ? rq.pending[rq.errorOffset]
      : null;

  const showColumns: ColumnsType<TourShowRow> = [
    { title: '序', dataIndex: 'seq', width: 52 },
    { title: '日期', dataIndex: 'showDate', width: 112 },
    { title: '地区', dataIndex: 'region', width: 100 },
    {
      title: '分队',
      dataIndex: 'troupe',
      width: 64,
      render: (value: TourShowRow['troupe']) => TROUPE_LABEL[value],
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 82,
      render: (value: TourShowRow['status']) => (
        <Tag color={SHOW_STATUS_COLOR[value]}>{SHOW_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '额度依据',
      dataIndex: 'authId',
      render: (_, record) => {
        // 已演场优先展示冻结快照（即使旧版已作废）
        if (record.status === 'performed' && record.basis) {
          return (
            <Tooltip
              title={`${record.basis.regions.join('、')}｜${record.basis.dateFrom} 至 ${record.basis.dateTo}｜额度 ${record.basis.totalQuota}`}
            >
              <Tag color="success">
                v{record.basis.versionNo} {record.basis.docNo}（演时依据）
              </Tag>
            </Tooltip>
          );
        }
        const label = authLabel(record.authId);
        if (label) {
          return <Tag color={label.superseded ? 'warning' : 'blue'}>{label.text}</Tag>;
        }
        return <Tag>未预占</Tag>;
      },
    },
    {
      title: '核对问题',
      dataIndex: 'issues',
      render: (issues: TourShowRow['issues']) =>
        issues.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {issues.map((issue) => (
              <Tag key={issue} color={SHOW_ISSUE_COLOR[issue]}>
                {SHOW_ISSUE_LABEL[issue]}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '回执号',
      dataIndex: 'receiptNo',
      width: 160,
      render: (value: string | null) => value ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 88,
      render: (_, record) =>
        record.status === 'reserved' ? (
          <Popconfirm
            title="撤销该场？"
            description="未演场次撤销后释放预占额度，本批额度恢复。"
            okText="撤销场次"
            cancelText="取消"
            onConfirm={() => void run('show', async () => cancelShow(record.id), '场次已撤销，额度已释放')}
          >
            <Button type="link" size="small" danger icon={<StopOutlined />}>
              撤销
            </Button>
          </Popconfirm>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.status === 'performed' ? '历史记录' : '已撤销'}
          </Typography.Text>
        ),
    },
  ];

  const logColumns: ColumnsType<(typeof batch.receiptLog)[number]> = [
    { title: '回执号', dataIndex: 'receiptNo', width: 170 },
    { title: '日期', dataIndex: 'showDate', width: 110 },
    { title: '地区', dataIndex: 'region', width: 90 },
    {
      title: '处理结果',
      dataIndex: 'result',
      render: (value: keyof typeof RECEIPT_LOG_RESULT_LABEL) => {
        const colorMap = { applied: 'success', duplicate: 'default', unmatched: 'warning' } as const;
        return <Tag color={colorMap[value]}>{RECEIPT_LOG_RESULT_LABEL[value]}</Tag>;
      },
    },
  ];

  const failedSchedule = sq.state === 'failed';
  const failedReceipt = rq.state === 'failed';
  const hasPendingSchedule = sq.pending.length > 0;
  const hasPendingReceipt = rq.pending.length > 0;

  return (
    <Drawer
      width={960}
      open
      onClose={onClose}
      title={
        <Space>
          <span>{batch.batchNo}</span>
          <Tag color="gold">{TROUPE_LABEL[batch.troupe]}</Tag>
          <Tag>{playName(batch.playId) || batch.playTitle}</Tag>
        </Space>
      }
      extra={
        <Space>
          {batch.status !== 'closed' ? (
            <Button size="small" onClick={() => void run('status', async () => updateBatchStatus(batch.id, 'closed'), '批次已结项')}>
              结项
            </Button>
          ) : (
            <Button size="small" onClick={() => void run('status', async () => updateBatchStatus(batch.id, 'active'), '已重新打开批次')}>
              重新打开
            </Button>
          )}
          <Popconfirm
            title={`删除批次 ${batch.batchNo}？`}
            description="批次下全部场次记录一并删除，额度占用随之清空。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() =>
              void run(
                'status',
                async () => {
                  await deleteBatch(batch.id);
                  onClose();
                },
                '批次已删除',
              )
            }
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除批次
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label="备注" span={2}>
            {batch.note || '—'}
          </Descriptions.Item>
          <Descriptions.Item label="排场次文件">{sq.sourceFileName ?? '未导入'}</Descriptions.Item>
          <Descriptions.Item label="回执文件">{rq.sourceFileName ?? '未导入'}</Descriptions.Item>
        </Descriptions>

        {/* 排场次导入 */}
        <div className="gb-panel" style={{ padding: 14 }}>
          <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
            <Space>
              <FileSyncOutlined />
              <Typography.Text strong>排场次导入（先预占额度）</Typography.Text>
              <Tag color={QUEUE_STATE_COLOR[sq.state]}>{QUEUE_STATE_LABEL[sq.state]}</Tag>
            </Space>
            <Space wrap>
              <Button size="small" icon={<DownloadOutlined />} onClick={() => message.success(`模板已下载：${downloadScheduleTemplate()}`)}>
                模板
              </Button>
              <Button size="small" type="primary" icon={<UploadOutlined />} onClick={() => scheduleInputRef.current?.click()}>
                {sq.total > 0 ? '重新导入排场次' : '导入排场次'}
              </Button>
              {hasPendingSchedule ? (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<CaretRightOutlined />}
                  loading={busy === 'schedule'}
                  onClick={() =>
                    void run(
                      'schedule',
                      async () => continueSchedule(batch.id),
                      `已继续处理 ${sq.pending.length} 行`,
                    )
                  }
                >
                  继续处理（剩 {sq.pending.length} 行）
                </Button>
              ) : null}
              {failedSchedule && badScheduleRow ? (
                <Popconfirm
                  title="丢弃定位到的坏行？"
                  description={`将丢弃「${badScheduleRow.region || '缺地区'} · ${badScheduleRow.showDate || '缺日期'}」一行，不动额度；其前后待处理行保留，可继续。`}
                  okText="丢弃坏行"
                  cancelText="取消"
                  onConfirm={() => void run('schedule', async () => discardScheduleError(batch.id), '坏行已丢弃')}
                >
                  <Button size="small" danger>
                    丢弃坏行
                  </Button>
                </Popconfirm>
              ) : null}
            </Space>
          </Space>
          <Progress percent={percentOf(sq.processed, sq.total)} size="small" style={{ marginTop: 10, marginBottom: 0 }} />
          {failedSchedule && sq.lastError ? (
            <Alert
              style={{ marginTop: 10 }}
              type="error"
              showIcon
              message="上次导入失败，本批预占额度已整段回滚恢复"
              description={
                <Space direction="vertical" size={4}>
                  <span>{sq.lastError}</span>
                  <span>批次与已核对行已保留，修正文件后点「继续处理」即可从断点接着跑。</span>
                </Space>
              }
            />
          ) : null}
        </div>

        {/* 回执导入 */}
        <div className="gb-panel" style={{ padding: 14 }}>
          <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
            <Space>
              <FileDoneOutlined />
              <Typography.Text strong>演出回执导入（演完转已用）</Typography.Text>
              <Tag color={QUEUE_STATE_COLOR[rq.state]}>{QUEUE_STATE_LABEL[rq.state]}</Tag>
            </Space>
            <Space wrap>
              <Button size="small" icon={<DownloadOutlined />} onClick={() => message.success(`模板已下载：${downloadReceiptTemplate()}`)}>
                模板
              </Button>
              <Button size="small" icon={<UploadOutlined />} onClick={() => receiptInputRef.current?.click()} disabled={shows.filter((s) => s.status !== 'cancelled').length === 0}>
                导入回执
              </Button>
              {hasPendingReceipt ? (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<CaretRightOutlined />}
                  loading={busy === 'receipt'}
                  onClick={() =>
                    void run('receipt', async () => continueReceipts(batch.id), `已继续处理 ${rq.pending.length} 行`)
                  }
                >
                  继续处理（剩 {rq.pending.length} 行）
                </Button>
              ) : null}
              {failedReceipt && badReceiptRow ? (
                <Popconfirm
                  title="丢弃定位到的坏行？"
                  description={`将丢弃回执「${badReceiptRow.receiptNo || '缺编号'}」一行，其余行保留。`}
                  okText="丢弃坏行"
                  cancelText="取消"
                  onConfirm={() => void run('receipt', async () => discardReceiptError(batch.id), '坏行已丢弃')}
                >
                  <Button size="small" danger>
                    丢弃坏行
                  </Button>
                </Popconfirm>
              ) : null}
            </Space>
          </Space>
          <Progress percent={percentOf(rq.processed, rq.total)} size="small" style={{ marginTop: 10, marginBottom: 0 }} />
          {failedReceipt && rq.lastError ? (
            <Alert style={{ marginTop: 10 }} type="error" showIcon message="回执导入失败，本次处理已回滚" description={rq.lastError} />
          ) : null}
        </div>

        {/* 场次表 */}
        <div>
          <Typography.Title level={5} style={{ marginTop: 4 }}>
            场次安排（{shows.length}）
          </Typography.Title>
          {shows.length === 0 ? (
            <Empty description="还没有导入排场次" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Table
              rowKey="id"
              size="small"
              columns={showColumns}
              dataSource={shows}
              pagination={false}
              scroll={{ x: 860 }}
            />
          )}
        </div>

        {/* 回执留痕 */}
        {batch.receiptLog.length > 0 ? (
          <div>
            <Typography.Title level={5}>
              <Badge color="#2f6f4f" /> 回执处理留痕（{batch.receiptLog.length}）
            </Typography.Title>
            <Table
              rowKey={(record) => `${record.receiptNo}-${record.at}`}
              size="small"
              columns={logColumns}
              dataSource={batch.receiptLog}
              pagination={false}
            />
          </div>
        ) : null}
      </Space>

      <input
        ref={scheduleInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) handleScheduleFile(file);
        }}
      />
      <input
        ref={receiptInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) handleReceiptFile(file);
        }}
      />
    </Drawer>
  );
}
