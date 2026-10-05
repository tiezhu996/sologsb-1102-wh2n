/**
 * 导入记账列表：成功 / 失败回滚 / 待核对 批次。
 * - 失败 / 待核对批次保留原始行，可「重开继续处理」（已修正的授权/排期会在重开时生效）。
 * - 成功批次可展开查看逐行动作（含重复回执跳过、预占、转已用等）。
 */
import { useState } from 'react';
import { App, Button, Card, Empty, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { RedoOutlined } from '@ant-design/icons';
import type { ImportBatchRow } from '../../utils/db';
import { IMPORT_KIND_LABEL, IMPORT_STATUS_COLOR, IMPORT_STATUS_LABEL } from '../../types/tour';
import { useTourStore } from '../../stores/tourStore';
import { formatStamp } from '../../utils/uuid';

export default function ImportBatchesCard() {
  const { message } = App.useApp();
  const importBatches = useTourStore((state) => state.importBatches);
  const reprocessImport = useTourStore((state) => state.reprocessImport);
  const discardImport = useTourStore((state) => state.discardImport);
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleReprocess = async (batchId: string) => {
    setBusyId(batchId);
    try {
      const outcome = await reprocessImport(batchId);
      if (!outcome) return;
      if (outcome.duplicated) message.warning(outcome.message);
      else if (outcome.status === 'success') message.success(`重开处理成功：${outcome.message}`);
      else message.error(`仍有问题：${outcome.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const columns: ColumnsType<ImportBatchRow> = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 120,
      render: (kind: ImportBatchRow['kind']) => <Tag>{IMPORT_KIND_LABEL[kind]}</Tag>,
    },
    {
      title: '文件 / 状态',
      dataIndex: 'fileName',
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{record.fileName}</Typography.Text>
          <Space size={6}>
            <Tag color={IMPORT_STATUS_COLOR[record.status]}>{IMPORT_STATUS_LABEL[record.status]}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.rawRows.length} 行 · {formatStamp(record.importedAt)}
            </Typography.Text>
          </Space>
        </Space>
      ),
    },
    {
      title: '结果说明',
      dataIndex: 'message',
      render: (text: string, record) => (
        <Typography.Text type={record.status === 'success' ? 'secondary' : 'warning'} style={{ fontSize: 13 }}>
          {text}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, record) => (
        <Space>
          {record.status !== 'success' ? (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<RedoOutlined />}
              loading={busyId === record.id}
              onClick={() => void handleReprocess(record.id)}
            >
              重开继续处理
            </Button>
          ) : null}
          <Popconfirm
            title="丢弃该导入记账？"
            description="仅删除记账记录，不影响已落库的授权/场次。"
            okText="丢弃"
            cancelText="取消"
            onConfirm={async () => {
              await discardImport(record.id);
              message.success('已丢弃该记账记录');
            }}
          >
            <Button size="small" danger type="text">
              丢弃
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const pending = importBatches.filter((batch) => batch.status !== 'success').length;

  return (
    <Card
      size="small"
      title={
        <Space>
          <span>导入记账</span>
          {pending > 0 ? <Tag color="warning">{pending} 批待核对</Tag> : <Tag color="success">无待核对</Tag>}
        </Space>
      }
    >
      {importBatches.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有导入记录。授权书、排期、回执导入后都会在此记账，失败可重开继续处理。"
        />
      ) : (
        <Table<ImportBatchRow>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={importBatches}
          pagination={false}
          expandable={{
            expandedRowRender: (record) => <BatchDetail record={record} />,
            rowExpandable: (record) => record.results.length > 0 || record.rawRows.length > 0,
          }}
        />
      )}
    </Card>
  );
}

function BatchDetail({ record }: { record: ImportBatchRow }) {
  if (record.results.length > 0) {
    return (
      <Table
        rowKey="line"
        size="small"
        pagination={false}
        dataSource={record.results}
        columns={[
          { title: '行号', dataIndex: 'line', width: 70 },
          {
            title: '结果',
            dataIndex: 'ok',
            width: 90,
            render: (ok: boolean) => (ok ? <Tag color="success">通过</Tag> : <Tag color="error">失败</Tag>),
          },
          {
            title: '动作 / 原因',
            render: (_: unknown, row) => (
              <Typography.Text type={row.ok ? undefined : 'danger'} style={{ fontSize: 12 }}>
                {row.ok ? row.action : row.error}
              </Typography.Text>
            ),
          },
        ]}
      />
    );
  }
  return (
    <Table
      rowKey="line"
      size="small"
      pagination={false}
      dataSource={record.rawRows}
      columns={[
        { title: '行号', dataIndex: 'line', width: 70 },
        {
          title: '原始内容',
          render: (_: unknown, row) => (
            <Typography.Text code style={{ fontSize: 12 }}>
              {Object.entries(row.fields)
                .map(([key, value]) => `${key}=${value}`)
                .join(' · ')}
            </Typography.Text>
          ),
        },
      ]}
    />
  );
}
