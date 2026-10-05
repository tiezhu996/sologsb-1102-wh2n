/**
 * /tour 巡演授权对账
 *
 * - 授权书管外部批准范围（地区 / 日期 / 场次额度），更新走换发版本，已演批次保留原依据；
 * - 巡演批次记本地场次安排，两个分队各排一套，额度合并到同一池核对；
 * - 排场次先预占、回执转已用、重复回执不占用；导入失败整段回滚、断点重开继续；
 * - 旧剧目缺授权书时，顶部先列待补。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  DeleteOutlined,
  EditOutlined,
  FileProtectOutlined,
  PlusOutlined,
  RedoOutlined,
  RetweetOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { useTourStore } from '../stores/tourStore';
import { usePlayStore } from '../stores/playStore';
import type { AuthDraft, TourAuthorization } from '../types/tour';
import {
  AUTH_STATUS_LABEL,
  BATCH_STATUS_COLOR,
  BATCH_STATUS_LABEL,
  QUEUE_STATE_COLOR,
  QUEUE_STATE_LABEL,
  SHOW_ISSUE_COLOR,
  SHOW_ISSUE_LABEL,
  TROUPE_LABEL,
} from '../types/tour';
import type { AuthRow, TourBatchRow, TourShowRow } from '../utils/db';
import {
  activeAuthOf,
  authHistoryOf,
  authScopeText,
  batchStatOf,
  missingAuthPlayIds,
  quotaUsageOf,
  summarizeTour,
} from '../utils/tourReconcile';
import { formatStamp } from '../utils/uuid';
import AuthFormModal, { type AuthFormMode } from '../components/tour/AuthFormModal';
import BatchCreateModal from '../components/tour/BatchCreateModal';
import BatchDrawer from '../components/tour/BatchDrawer';
import { EmptyState } from '../components/common/EmptyState';

interface AuthModalState {
  open: boolean;
  mode: AuthFormMode;
  playId: string;
  source?: AuthRow;
}

export default function TourReconcile() {
  const { message, modal } = App.useApp();
  const {
    auths,
    batches,
    shows,
    loading,
    error,
    loadTour,
    saveNewAuth,
    saveEditAuth,
    renewAuth,
    deleteAuth,
    recheckAll,
    createBatch,
  } = useTourStore();
  const plays = usePlayStore((state) => state.plays);

  const [authModal, setAuthModal] = useState<AuthModalState>({ open: false, mode: 'create', playId: '' });
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void loadTour();
  }, [loadTour]);

  useEffect(() => {
    if (error) message.error(error);
  }, [error, message]);

  const playById = useMemo(() => new Map(plays.map((play) => [play.id, play])), [plays]);
  const playName = (playId: string | null): string => (playId ? playById.get(playId)?.title ?? '（剧目已删除）' : '未关联剧目');

  const authById = useMemo(() => new Map(auths.map((auth) => [auth.id, auth])), [auths]);
  const authLabel = (
    authId: string | null,
  ): { text: string; superseded: boolean } | null => {
    if (!authId) return null;
    const auth = authById.get(authId);
    if (!auth) return { text: '授权书已删除', superseded: true };
    return { text: `v${auth.versionNo} ${auth.docNo}`, superseded: auth.status === 'superseded' };
  };

  const summary = useMemo(() => summarizeTour({ auths, batches, shows }), [auths, batches, shows]);
  const missingPlayIds = useMemo(() => missingAuthPlayIds(batches, auths), [batches, auths]);

  const regionSuggestions = useMemo(() => {
    const set = new Set<string>();
    auths.forEach((auth) => auth.regions.forEach((region) => set.add(region)));
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [auths]);

  const openCreateAuth = (playId: string) => setAuthModal({ open: true, mode: 'create', playId });
  const closeAuthModal = () => setAuthModal((state) => ({ ...state, open: false }));

  const submitAuth = async (draft: AuthDraft) => {
    setSubmitting(true);
    try {
      if (authModal.mode === 'create') {
        await saveNewAuth(authModal.playId, draft);
        message.success('授权书已建档，待核对场次已按新范围重新核对');
      } else if (authModal.mode === 'edit' && authModal.source) {
        await saveEditAuth(authModal.source.id, draft);
        message.success('授权书已更新，未演场次已按新范围重新核对');
      } else if (authModal.mode === 'renew' && authModal.source) {
        await renewAuth(authModal.source.id, draft);
        message.success('新版已生效，旧版作废留存；已演批次保留原依据');
      }
      closeAuthModal();
    } catch (submitError) {
      message.error(submitError instanceof Error ? submitError.message : '授权书保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDeleteAuth = (auth: AuthRow) => {
    modal.confirm({
      title: `删除授权书 v${auth.versionNo}（${auth.docNo}）？`,
      content: '待演场次会退回「缺授权书」待核对；已有已演场次依据该书时不允许删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteAuth(auth.id);
          message.success('授权书已删除，未演场次已重新核对');
        } catch (deleteError) {
          message.error(deleteError instanceof Error ? deleteError.message : '删除失败');
        }
      },
    });
  };

  const openBatch = batches.find((batch) => batch.id === openBatchId) ?? null;
  const openBatchShows = openBatchId ? shows.filter((show) => show.batchId === openBatchId) : [];

  /* ----------------------------- 授权书表 ----------------------------- */

  const authColumns: ColumnsType<AuthRow> = [
    {
      title: '剧目',
      dataIndex: 'playId',
      width: 170,
      render: (playId: string) => <Typography.Text strong>{playName(playId)}</Typography.Text>,
    },
    {
      title: '版本 / 文号',
      key: 'doc',
      width: 240,
      render: (_, record) => (
        <Space size={6}>
          <Tag color={record.status === 'active' ? 'blue' : 'default'}>v{record.versionNo}</Tag>
          <span>{record.docNo}</span>
          {record.status === 'superseded' ? <Tag>{AUTH_STATUS_LABEL.superseded}</Tag> : null}
        </Space>
      ),
    },
    { title: '批准范围', key: 'scope', render: (_, record) => authScopeText(record) },
    {
      title: '额度（已用 / 预占 / 总额）',
      key: 'quota',
      width: 210,
      render: (_, record) => {
        if (record.status !== 'active') return <Typography.Text type="secondary">旧版已冻结，不再占用</Typography.Text>;
        const usage = quotaUsageOf(record, shows);
        const percent = Math.min(100, Math.round((usage.held / Math.max(1, usage.total)) * 100));
        const overbooked = usage.held >= usage.total;
        return (
          <div>
            <Space size={4}>
              <Tag color="success">已用 {usage.used}</Tag>
              <Tag color="processing">预占 {usage.reserved}</Tag>
              <Tag color={overbooked ? 'error' : 'default'}>总额 {usage.total}</Tag>
            </Space>
            <Progress
              percent={percent}
              size="small"
              status={overbooked ? 'exception' : 'normal'}
              style={{ marginTop: 4, marginBottom: 0 }}
            />
          </div>
        );
      },
    },
    { title: '发证日期', dataIndex: 'issuedAt', width: 110 },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_, record) =>
        record.status === 'active' ? (
          <Space size={2}>
            <Tooltip title="修改范围 / 额度后，未演场次立即按新范围核对">
              <Button
                type="link"
                size="small"
                icon={<EditOutlined />}
                onClick={() => setAuthModal({ open: true, mode: 'edit', playId: record.playId, source: record })}
              >
                修改
              </Button>
            </Tooltip>
            <Tooltip title="旧版作废留存，已演批次保留原依据">
              <Button
                type="link"
                size="small"
                icon={<RetweetOutlined />}
                onClick={() => setAuthModal({ open: true, mode: 'renew', playId: record.playId, source: record })}
              >
                换发新版
              </Button>
            </Tooltip>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDeleteAuth(record)} />
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            更新于 {formatStamp(record.updatedAt)}
          </Typography.Text>
        ),
    },
  ];

  // 每个剧目只展开其授权历史（旧版作废留存）
  const activeAuths = useMemo(
    () =>
      [...auths]
        .filter((auth) => auth.status === 'active')
        .sort((a, b) => playName(a.playId).localeCompare(playName(b.playId), 'zh-Hans-CN')),
    [auths, playName],
  );

  /* ----------------------------- 批次表 ----------------------------- */

  const failedCount = batches.filter(
    (batch) => batch.scheduleQueue.state === 'failed' || batch.receiptQueue.state === 'failed',
  ).length;

  const batchColumns: ColumnsType<TourBatchRow> = [
    {
      title: '批次号',
      dataIndex: 'batchNo',
      width: 130,
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          <Tag color={BATCH_STATUS_COLOR[record.status]} style={{ width: 'fit-content' }}>
            {BATCH_STATUS_LABEL[record.status]}
          </Tag>
        </Space>
      ),
    },
    { title: '分队', dataIndex: 'troupe', width: 64, render: (value: TourBatchRow['troupe']) => TROUPE_LABEL[value] },
    {
      title: '剧目 / 授权',
      key: 'play',
      render: (_, record) => {
        const active = record.playId ? activeAuthOf(auths, record.playId) : null;
        return (
          <Space direction="vertical" size={2}>
            <Typography.Text strong>{playName(record.playId) || record.playTitle}</Typography.Text>
            {active ? (
              <Tooltip title={authScopeText(active)}>
                <Tag color="blue">
                  v{active.versionNo} {active.docNo}
                </Tag>
              </Tooltip>
            ) : (
              <Tag color="error">缺授权书 · 待补</Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: '场次（已演 / 待演 / 待核对）',
      key: 'stat',
      width: 200,
      render: (_, record) => {
        const stat = batchStatOf(record.id, shows);
        return (
          <Space size={4} wrap>
            <Tag color="success">已演 {stat.performed}</Tag>
            <Tag color="processing">待演 {stat.reserved - stat.pendingIssue}</Tag>
            {stat.pendingIssue > 0 ? <Tag color="error">待核对 {stat.pendingIssue}</Tag> : null}
            {stat.cancelled > 0 ? <Tag>撤销 {stat.cancelled}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '导入队列',
      key: 'queue',
      width: 230,
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              排场
            </Typography.Text>
            <Tag color={QUEUE_STATE_COLOR[record.scheduleQueue.state]}>
              {QUEUE_STATE_LABEL[record.scheduleQueue.state]}
              {record.scheduleQueue.pending.length > 0 ? ` ${record.scheduleQueue.pending.length}` : ''}
            </Tag>
          </Space>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              回执
            </Typography.Text>
            <Tag color={QUEUE_STATE_COLOR[record.receiptQueue.state]}>
              {QUEUE_STATE_LABEL[record.receiptQueue.state]}
              {record.receiptQueue.pending.length > 0 ? ` ${record.receiptQueue.pending.length}` : ''}
            </Tag>
          </Space>
        </Space>
      ),
    },
    { title: '备注', dataIndex: 'note', ellipsis: true, render: (value: string) => value || '—' },
    {
      title: '操作',
      key: 'op',
      width: 92,
      render: (_, record) => (
        <Button type="link" size="small" onClick={() => setOpenBatchId(record.id)}>
          对账明细
        </Button>
      ),
    },
  ];

  const issueTagsFromShows = (batchShows: TourShowRow[]): ReactNode => {
    const issues = new Set(batchShows.flatMap((show) => show.issues));
    if (issues.size === 0) return null;
    return (
      <Space size={4} wrap>
        {[...issues].map((issue) => (
          <Tag key={issue} color={SHOW_ISSUE_COLOR[issue]}>
            {SHOW_ISSUE_LABEL[issue]}
          </Tag>
        ))}
      </Space>
    );
  };

  const modalPlayTitle = playName(authModal.playId) || '未选择剧目';

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-brand-bar" />
        <div className="gb-panel-title">
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              <SafetyCertificateOutlined /> 巡演授权对账
            </Typography.Title>
            <Typography.Text type="secondary">
              授权书管外部批准范围（地区 / 日期 / 场次），巡演批次记本地安排；排场先预占、演完转已用，
              两队合计对账，重复回执不占用
            </Typography.Text>
          </div>
          <Space wrap>
            <Button icon={<RedoOutlined />} onClick={() => void recheckAll().then(() => message.success('全部未演场次已按现行授权重新核对'))}>
              全部重新核对
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setBatchModalOpen(true)}>
              新建巡演批次
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={4}>
            <Statistic title="授权书" value={summary.authCount} prefix={<FileProtectOutlined />} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="现行版本" value={summary.activeAuthCount} prefix={<AuditOutlined />} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="巡演批次" value={summary.batchCount} prefix={<UnorderedListOutlined />} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="已演场次" value={summary.showPerformed} valueStyle={{ color: '#2f6f4f' }} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="待演预占" value={summary.showReserved} valueStyle={{ color: '#7a1f1f' }} />
          </Col>
          <Col xs={12} md={4}>
            <Badge count={summary.showPendingIssue} showZero color={summary.showPendingIssue > 0 ? '#cf1322' : '#d9d9d9'} title="待核对场次" />
            <Statistic
              title="待核对场次"
              value={summary.showPendingIssue}
              valueStyle={summary.showPendingIssue > 0 ? { color: '#cf1322' } : undefined}
              prefix={<ThunderboltOutlined />}
            />
          </Col>
        </Row>
        {failedCount > 0 ? (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            message={`有 ${failedCount} 个批次上次导入失败：预占额度已整段回滚恢复，批次保留待核对，进入「对账明细」可丢弃坏行或从断点继续处理。`}
          />
        ) : null}
      </div>

      {missingPlayIds.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          icon={<SafetyCertificateOutlined />}
          message="以下旧剧目已排入巡演但缺少授权书，场次暂未占用额度，请先补办"
          description={
            <Space wrap>
              {missingPlayIds.map((playId) => (
                <Tag
                  key={playId}
                  color="warning"
                  style={{ padding: '4px 10px', cursor: 'pointer' }}
                  onClick={() => openCreateAuth(playId)}
                >
                  {playName(playId)} · 点此补办授权书
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}

      <Card>
        <Tabs
          defaultActiveKey="batches"
          items={[
            {
              key: 'batches',
              label: `巡演批次（${batches.length}）`,
              children: batches.length === 0 ? (
                <EmptyState
                  title="还没有巡演批次"
                  description="两个分队各排一套：先建批次，再导入排场次（自动预占额度）与演出回执（演完转已用）。"
                  actionText="新建巡演批次"
                  onAction={() => setBatchModalOpen(true)}
                />
              ) : (
                <Table
                  rowKey="id"
                  size="middle"
                  loading={loading}
                  columns={batchColumns}
                  dataSource={batches}
                  pagination={false}
                  expandable={{
                    expandedRowRender: (record) => {
                      const batchShows = shows
                        .filter((show) => show.batchId === record.id)
                        .sort((a, b) => a.seq - b.seq);
                      if (batchShows.length === 0) {
                        return (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description={
                              record.scheduleQueue.state === 'failed'
                                ? '排场次导入失败已回滚，尚无场次记录；进入明细从断点继续'
                                : '尚未导入排场次'
                            }
                          />
                        );
                      }
                      return (
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          {issueTagsFromShows(batchShows)}
                          <Space size={[8, 6]} wrap>
                            {batchShows.map((show) => (
                              <Tag
                                key={show.id}
                                color={show.issues.length > 0 ? 'error' : show.status === 'performed' ? 'success' : show.status === 'cancelled' ? 'default' : 'processing'}
                              >
                                {show.seq}. {show.showDate} {show.region}
                                {show.status === 'performed' ? '·已演' : show.status === 'cancelled' ? '·撤销' : ''}
                                {show.issues.length > 0 ? `·${SHOW_ISSUE_LABEL[show.issues[0]]}` : ''}
                              </Tag>
                            ))}
                          </Space>
                        </Space>
                      );
                    },
                  }}
                />
              ),
            },
            {
              key: 'auths',
              label: `授权书（${auths.length}）`,
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Alert
                    type="info"
                    showIcon
                    message="授权书是外部批准范围：更新授权后，只有未演场次会按新范围重新核对；已演批次永远保留演完当时的授权依据。"
                  />
                  {activeAuths.length === 0 ? (
                    <EmptyState
                      title="还没有现行有效的授权书"
                      description="从巡演批次里缺授权的剧目开始补办，或在剧目库选定剧目后直接建档。"
                      actionText={plays[0] ? `为《${plays[0].title}》建档` : '暂无剧目可建档'}
                      onAction={() => plays[0] && openCreateAuth(plays[0].id)}
                    />
                  ) : (
                    <Table
                      rowKey="id"
                      size="middle"
                      loading={loading}
                      columns={authColumns}
                      dataSource={activeAuths}
                      pagination={false}
                      expandable={{
                        expandedRowRender: (record) => {
                          const history = authHistoryOf(auths, record.playId).filter((auth) => auth.id !== record.id);
                          if (history.length === 0) {
                            return <Typography.Text type="secondary">该剧目暂无历史版本。</Typography.Text>;
                          }
                          return (
                            <Space direction="vertical" size={6} style={{ width: '100%' }}>
                              <Typography.Text strong>历史版本（已作废留存，供已演批次追溯）</Typography.Text>
                              {history.map((old: TourAuthorization) => {
                                const oldBasisCount = shows.filter(
                                  (show) => show.status === 'performed' && show.basis?.authId === old.id,
                                ).length;
                                return (
                                  <Card key={old.id} size="small" style={{ background: '#faf7f0' }}>
                                    <Space wrap>
                                      <Tag>v{old.versionNo}</Tag>
                                      <Typography.Text delete type="secondary">
                                        {old.docNo}
                                      </Typography.Text>
                                      <Tag color="gold">{authScopeText(old)}</Tag>
                                      <Tag>原额度 {old.totalQuota} 场</Tag>
                                      <Tag color="success">{oldBasisCount} 场已演以此为据</Tag>
                                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                        发证 {old.issuedAt}
                                      </Typography.Text>
                                    </Space>
                                  </Card>
                                );
                              })}
                            </Space>
                          );
                        },
                      }}
                    />
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <AuthFormModal
        open={authModal.open}
        mode={authModal.mode}
        source={authModal.source}
        regionSuggestions={regionSuggestions}
        playTitle={modalPlayTitle}
        submitting={submitting}
        onSubmit={submitAuth}
        onCancel={closeAuthModal}
      />

      <BatchCreateModal
        open={batchModalOpen}
        plays={plays}
        submitting={submitting}
        onCancel={() => setBatchModalOpen(false)}
        onSubmit={async (values) => {
          setSubmitting(true);
          try {
            const created = await createBatch(values);
            message.success('批次已建立，请导入排场次');
            setBatchModalOpen(false);
            setOpenBatchId(created.id);
          } catch (createError) {
            message.error(createError instanceof Error ? createError.message : '批次建立失败');
          } finally {
            setSubmitting(false);
          }
        }}
      />

      {openBatch ? (
        <BatchDrawer
          batch={openBatch}
          shows={openBatchShows}
          playName={playName}
          authLabel={authLabel}
          onClose={() => setOpenBatchId(null)}
        />
      ) : null}
    </Space>
  );
}
