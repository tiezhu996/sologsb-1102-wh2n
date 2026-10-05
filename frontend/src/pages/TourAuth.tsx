/**
 * /tour 巡演授权对账
 *
 * 四个页签：
 * 1. 对账总览：按剧目列出「待补授权书 / 越区 / 超期 / 场次超额」，未演场次按现行授权核对，已演场次显示冻结依据。
 * 2. 授权书管理：外部批准范围（剧目/地区/日期/场次额度），支持更新升版、换发、废止。
 * 3. 巡演批次：本地场次安排，两个分队各排一套；排场次预占额度，演完转已用，可取消/重开。
 * 4. 导入记账：授权书/排期/回执导入结果，失败回滚留待核对，可重开继续处理。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Row,
  Select,
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
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useTourStore } from '../stores/tourStore';
import { usePlayStore } from '../stores/playStore';
import { buildPlayRecons, buildQuotaUsages } from '../utils/tourRecon';
import { formatStamp } from '../utils/uuid';
import type {
  AuthorizationDraft,
  PlayRecon,
  ReconRow,
  TourPerformanceDraft,
  TroupeTeam,
} from '../types/tour';
import {
  AUTH_STATUS_LABEL,
  PERFORMANCE_STATE_COLOR,
  PERFORMANCE_STATE_LABEL,
  RECON_VERDICT_COLOR,
  RECON_VERDICT_LABEL,
  TEAM_LABEL,
  TEAM_OPTIONS,
} from '../types/tour';
import type { AuthorizationRow, TourBatchRow, TourPerformanceRow } from '../utils/db';
import AuthorizationFormModal from '../components/tour/AuthorizationFormModal';
import ImportPanel from '../components/tour/ImportPanel';
import ImportBatchesCard from '../components/tour/ImportBatchesCard';

export default function TourAuth() {
  const { message } = App.useApp();
  const loadTour = useTourStore((state) => state.loadTour);
  const ready = useTourStore((state) => state.ready);
  const loading = useTourStore((state) => state.loading);
  const authorizations = useTourStore((state) => state.authorizations);
  const performances = useTourStore((state) => state.performances);
  const batches = useTourStore((state) => state.batches);
  const playTitleById = useTourStore((state) => state.playTitleById);
  const plays = usePlayStore((state) => state.plays);

  const [error, setError] = useState('');

  useEffect(() => {
    if (ready) return;
    void loadTour().catch((err: unknown) => setError(err instanceof Error ? err.message : '巡演数据读取失败'));
  }, [ready, loadTour]);

  useEffect(() => {
    if (error) message.error(error);
  }, [error, message]);

  const recons = useMemo(
    () => buildPlayRecons(authorizations, performances, playTitleById),
    [authorizations, performances, playTitleById],
  );
  const usages = useMemo(() => buildQuotaUsages(authorizations, performances), [authorizations, performances]);

  const heldCount = performances.filter((p) => p.state === 'held').length;
  const usedCount = performances.filter((p) => p.state === 'performed').length;
  const problemPerfs = recons.reduce((acc, recon) => acc + recon.problemCount, 0);
  const missingAuthTitles = recons.filter((recon) => !recon.currentAuth).map((recon) => recon.playTitle);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-brand-bar" />
        <div className="gb-panel-title">
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              巡演授权对账
            </Typography.Title>
            <Typography.Text type="secondary">
              授权书管外部批准范围（地区 / 日期 / 场次额度），巡演批次记本地场次安排；排场次先预占额度，演完转已用并冻结依据。
            </Typography.Text>
          </div>
          <Space>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadTour()}>
              重新核对
            </Button>
          </Space>
        </div>
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="现行授权书" value={authorizations.filter((a) => a.status === 'active').length} prefix={<SafetyCertificateOutlined />} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="预占中场次" value={heldCount} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="已演 · 已用" value={usedCount} prefix={<CheckCircleOutlined />} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="待核对问题场次"
              value={problemPerfs}
              valueStyle={{ color: problemPerfs > 0 ? '#cf1322' : undefined }}
              prefix={problemPerfs > 0 ? <WarningOutlined /> : undefined}
            />
          </Col>
        </Row>
        {missingAuthTitles.length > 0 ? (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            icon={<ExclamationCircleOutlined />}
            message="以下旧剧目缺授权书，先列待补"
            description={
              <Space wrap>
                {missingAuthTitles.map((title) => (
                  <Tag key={title} color="warning">
                    {title}
                  </Tag>
                ))}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  可在「授权书管理」补登，或导入授权书；补齐后未演场次自动按新范围核对。
                </Typography.Text>
              </Space>
            }
          />
        ) : null}
      </div>

      <div className="gb-panel" style={{ padding: 12 }}>
        <Tabs
          defaultActiveKey="recon"
          items={[
            {
              key: 'recon',
              label: '对账总览',
              children: <ReconTab recons={recons} usages={usages} />,
            },
            {
              key: 'auth',
              label: `授权书管理${authorizations.filter((a) => a.status === 'active').length ? '' : ''}`,
              children: <AuthTab plays={plays} />,
            },
            {
              key: 'batch',
              label: '巡演批次',
              children: <BatchTab plays={plays} batches={batches} performances={performances} />,
            },
            {
              key: 'import',
              label: '导入与记账',
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <ImportPanel />
                  <ImportBatchesCard />
                </Space>
              ),
            },
          ]}
        />
      </div>
    </Space>
  );
}

/* ============================ 对账总览 ============================ */

function ReconTab({ recons, usages }: { recons: PlayRecon[]; usages: ReturnType<typeof buildQuotaUsages> }) {
  const authorizationsById = useTourStore((state) =>
    new Map(state.authorizations.map((auth) => [auth.id, auth])),
  );
  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Card size="small" title="各授权书额度占用（已演先占额度，预占按日期排队）">
        {usages.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有现行授权书" />
        ) : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {usages.map((usage) => {
              const auth = authorizationsById.get(usage.authId);
              const percent = usage.quota === 0 ? 0 : Math.min(100, Math.round((usage.committed / usage.quota) * 100));
              const status = usage.overflow > 0 ? 'exception' : usage.remaining === 0 ? 'active' : 'normal';
              return (
                <div key={usage.authId}>
                  <Space size={8} wrap style={{ marginBottom: 2 }}>
                    <Typography.Text strong>{auth ? `《${auth.playTitle}》${auth.docNo}` : usage.authId}</Typography.Text>
                    <Tag color={usage.overflow > 0 ? 'error' : usage.remaining === 0 ? 'warning' : 'success'}>
                      {usage.overflow > 0 ? `超 ${usage.overflow} 场` : usage.remaining === 0 ? '额度用尽' : `余 ${usage.remaining} 场`}
                    </Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      已用 {usage.used} · 预占 {usage.held} / 额度 {usage.quota}
                    </Typography.Text>
                  </Space>
                  <Progress percent={percent} size="small" status={status} showInfo={false} />
                </div>
              );
            })}
          </Space>
        )}
      </Card>

      {recons.length === 0 ? (
        <Empty description="还没有巡演场次。到「巡演批次」排场次，或导入排期 CSV。" />
      ) : (
        recons.map((recon) => <PlayReconCard key={`${recon.playId ?? recon.playTitle}`} recon={recon} />)
      )}
    </Space>
  );
}

function PlayReconCard({ recon }: { recon: PlayRecon }) {
  const columns: ColumnsType<ReconRow> = [
    {
      title: '日期',
      dataIndex: ['performance', 'showDate'],
      width: 110,
      sorter: (a, b) => a.performance.showDate.localeCompare(b.performance.showDate),
    },
    {
      title: '分队',
      dataIndex: ['performance', 'team'],
      width: 70,
      render: (team: TroupeTeam) => <Tag>{TEAM_LABEL[team]}</Tag>,
    },
    {
      title: '地区 / 戏台',
      width: 200,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.performance.region}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.performance.venue || '—'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: ['performance', 'state'],
      width: 100,
      render: (state: TourPerformanceRow['state']) => (
        <Tag color={PERFORMANCE_STATE_COLOR[state]}>{PERFORMANCE_STATE_LABEL[state]}</Tag>
      ),
    },
    {
      title: '核对结论',
      dataIndex: 'verdict',
      width: 120,
      render: (verdict: ReconRow['verdict']) => (
        <Tag color={RECON_VERDICT_COLOR[verdict]}>{RECON_VERDICT_LABEL[verdict]}</Tag>
      ),
    },
    {
      title: '依据 / 原因',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          {row.basisDocNo ? <Typography.Text style={{ fontSize: 12 }}>依据：{row.basisDocNo}</Typography.Text> : null}
          {row.reasons.map((reason, index) => (
            <Typography.Text
              key={index}
              type={row.verdict === 'ok' ? 'secondary' : row.verdict === 'no-auth' ? 'warning' : 'danger'}
              style={{ fontSize: 12 }}
            >
              {reason}
            </Typography.Text>
          ))}
        </Space>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <Typography.Text strong>《{recon.playTitle}》</Typography.Text>
          {recon.currentAuth ? (
            <Tooltip
              title={`${recon.currentAuth.regions.join('、')}｜${recon.currentAuth.validFrom} ~ ${recon.currentAuth.validTo}`}
            >
              <Tag color="success">
                {recon.currentAuth.docNo} · v{recon.currentAuth.versionNo} · 额度 {recon.currentAuth.quota}
              </Tag>
            </Tooltip>
          ) : (
            <Tag color="warning">缺现行授权书 · 待补</Tag>
          )}
          <Tag>已演 {recon.usedCount}</Tag>
          <Tag>预占 {recon.heldCount}</Tag>
          {recon.problemCount > 0 ? <Tag color="error">问题 {recon.problemCount}</Tag> : null}
        </Space>
      }
    >
      <Table<ReconRow> rowKey={(row) => row.performance.id} columns={columns} dataSource={recon.rows} pagination={false} size="small" />
    </Card>
  );
}

/* ============================ 授权书管理 ============================ */

function AuthTab({ plays }: { plays: PlayRowLike[] }) {
  const { message, modal } = App.useApp();
  const authorizations = useTourStore((state) => state.authorizations);
  const createAuthorization = useTourStore((state) => state.createAuthorization);
  const updateAuthorization = useTourStore((state) => state.updateAuthorization);
  const supersedeAuthorization = useTourStore((state) => state.supersedeAuthorization);
  const revokeAuthorization = useTourStore((state) => state.revokeAuthorization);
  const removeAuthorization = useTourStore((state) => state.removeAuthorization);

  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState<'create' | 'edit' | 'supersede'>('create');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [initialDraft, setInitialDraft] = useState<AuthorizationDraft | null>(null);

  const openCreate = () => {
    setMode('create');
    setTargetId(null);
    setInitialDraft(null);
    setModalOpen(true);
  };

  const openEdit = (auth: AuthorizationRow) => {
    setMode('edit');
    setTargetId(auth.id);
    setInitialDraft({
      docNo: auth.docNo,
      playId: auth.playId,
      playTitle: auth.playTitle,
      regions: [...auth.regions],
      validFrom: auth.validFrom,
      validTo: auth.validTo,
      quota: auth.quota,
      issuer: auth.issuer,
      note: auth.note,
    });
    setModalOpen(true);
  };

  const openSupersede = (auth: AuthorizationRow) => {
    setMode('supersede');
    setTargetId(auth.id);
    setInitialDraft({
      docNo: `${auth.docNo}-换发`,
      playId: auth.playId,
      playTitle: auth.playTitle,
      regions: [...auth.regions],
      validFrom: auth.validFrom,
      validTo: auth.validTo,
      quota: auth.quota,
      issuer: auth.issuer,
      note: auth.note,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (draft: AuthorizationDraft) => {
    if (mode === 'create') {
      await createAuthorization(draft);
      message.success('授权书已登记，未演场次将据此核对');
    } else if (mode === 'edit' && targetId) {
      await updateAuthorization(targetId, draft);
      message.success('授权范围已更新并升版；未演场次按新范围核对，已演场次保留原依据');
    } else if (mode === 'supersede' && targetId) {
      await supersedeAuthorization(targetId, draft);
      message.success('已换发新版，旧版标记为已换发；已演批次保留旧版依据');
    }
    setModalOpen(false);
  };

  const confirmRevoke = (auth: AuthorizationRow) => {
    modal.confirm({
      title: `废止授权书 ${auth.docNo}？`,
      content: '废止后未演场次将按「缺授权书」列待补；已演场次仍保留原依据。',
      okText: '废止',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await revokeAuthorization(auth.id);
        message.success('授权书已废止');
      },
    });
  };

  const columns: ColumnsType<AuthorizationRow> = [
    { title: '授权书号', dataIndex: 'docNo', width: 200, render: (text: string, row) => (
      <Space direction="vertical" size={0}>
        <Typography.Text strong>{text}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>v{row.versionNo}{row.issuer ? ` · ${row.issuer}` : ''}</Typography.Text>
      </Space>
    ) },
    { title: '剧目', dataIndex: 'playTitle', width: 150, render: (text: string) => <Typography.Text>《{text}》</Typography.Text> },
    { title: '批准地区', dataIndex: 'regions', render: (regions: string[]) => <Space wrap size={4}>{regions.map((region) => <Tag key={region}>{region}</Tag>)}</Space> },
    { title: '批准期限', width: 200, render: (_, row) => <Typography.Text style={{ fontSize: 12 }}>{row.validFrom} ~ {row.validTo}</Typography.Text> },
    { title: '额度', dataIndex: 'quota', width: 80, render: (quota: number) => <Tag color="gold">{quota} 场</Tag> },
    { title: '状态', dataIndex: 'status', width: 90, render: (status: AuthorizationRow['status']) => {
      const color = status === 'active' ? 'success' : status === 'superseded' ? 'default' : 'error';
      return <Tag color={color}>{AUTH_STATUS_LABEL[status]}</Tag>;
    } },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      render: (_, row) =>
        row.status === 'active' ? (
          <Space size={4}>
            <Button size="small" type="link" onClick={() => openEdit(row)}>更新范围</Button>
            <Button size="small" type="link" onClick={() => openSupersede(row)}>换发新版</Button>
            <Button size="small" type="link" danger onClick={() => confirmRevoke(row)}>废止</Button>
          </Space>
        ) : (
          <Button size="small" type="link" danger onClick={() => void removeAuthorization(row.id)}>
            删除记录
          </Button>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="授权书是外部批准的唯一依据"
        description="更新范围/额度会自动升版本号：未演场次立刻按新范围核对；已演批次永久保留演当时的授权依据，不追溯调整。"
      />
      <Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          登记授权书
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          也可在「导入与记账」批量导入授权书 CSV（同文号导入即更新升版）。
        </Typography.Text>
      </Space>
      <Table<AuthorizationRow> rowKey="id" columns={columns} dataSource={authorizations} pagination={false} size="small" />
      <AuthorizationFormModal
        open={modalOpen}
        title={mode === 'create' ? '登记授权书' : mode === 'edit' ? '更新授权范围（升版）' : '换发新版授权书'}
        okText={mode === 'create' ? '登记' : mode === 'edit' ? '保存并升版' : '换发'}
        plays={plays}
        initial={initialDraft}
        onCancel={() => setModalOpen(false)}
        onSubmit={handleSubmit}
      />
    </Space>
  );
}

/** 只取页面渲染授权书所需的剧目字段，避免与 db 的 PlayRow 强耦合 */
type PlayRowLike = { id: string; title: string };

/* ============================ 巡演批次与场次 ============================ */

function BatchTab({
  plays,
  batches,
  performances,
}: {
  plays: PlayRowLike[];
  batches: TourBatchRow[];
  performances: TourPerformanceRow[];
}) {
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [perfModalOpen, setPerfModalOpen] = useState(false);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);

  const activeBatchIdResolved = activeBatchId ?? batches[0]?.id ?? null;
  const activeBatch = batches.find((batch) => batch.id === activeBatchIdResolved) ?? null;
  const batchPerformances = performances
    .filter((performance) => performance.batchId === activeBatchIdResolved)
    .sort((a, b) => a.showDate.localeCompare(b.showDate));

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="两个分队各排一套，合起来共用同一份授权额度"
        description="排场次即按现行授权预占额度；演完登记回执转「已用」并冻结依据；取消释放预占，可重开再次预占。"
      />
      <BatchManager
        batches={batches}
        activeBatch={activeBatch}
        batchModalOpen={batchModalOpen}
        setBatchModalOpen={setBatchModalOpen}
        onSelectBatch={setActiveBatchId}
      />
      <PerformanceManager
        plays={plays}
        activeBatch={activeBatch}
        performances={batchPerformances}
        perfModalOpen={perfModalOpen}
        setPerfModalOpen={setPerfModalOpen}
      />
    </Space>
  );
}

function BatchManager({
  batches,
  activeBatch,
  batchModalOpen,
  setBatchModalOpen,
  onSelectBatch,
}: {
  batches: TourBatchRow[];
  activeBatch: TourBatchRow | null;
  batchModalOpen: boolean;
  setBatchModalOpen: (open: boolean) => void;
  onSelectBatch: (id: string) => void;
}) {
  const { message, modal } = App.useApp();
  const createBatch = useTourStore((state) => state.createBatch);
  const deleteBatch = useTourStore((state) => state.deleteBatch);
  const [batchForm] = Form.useForm<BatchFormValues>();

  const openCreate = () => {
    batchForm.setFieldsValue({
      name: '',
      team: 'teamA',
      range: [dayjs(), dayjs().add(14, 'day')],
      note: '',
    });
    setBatchModalOpen(true);
  };

  const handleBatchOk = async () => {
    const values = await batchForm.validateFields();
    await createBatch({
      name: values.name,
      team: values.team,
      planFrom: values.range[0].format('YYYY-MM-DD'),
      planTo: values.range[1].format('YYYY-MM-DD'),
      note: values.note ?? '',
    });
    message.success('巡演批次已建，可在下方排场次');
    setBatchModalOpen(false);
  };

  const confirmDelete = (batch: TourBatchRow) => {
    modal.confirm({
      title: `删除批次「${batch.name}」？`,
      content: '批次内全部巡演场次（含已演记录）会一并删除，请谨慎操作。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteBatch(batch.id);
        message.success('批次已删除');
      },
    });
  };

  return (
    <>
      <Card
        size="small"
        title="巡演批次（本地场次安排）"
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
            新建批次
          </Button>
        }
      >
        {batches.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有巡演批次，先建一批（如「秋后关中巡演·甲队」）" />
        ) : (
          <Space wrap>
            {batches.map((batch) => {
              const isActive = activeBatch?.id === batch.id;
              return (
                <Card.Grid
                  key={batch.id}
                  style={{
                    width: 240,
                    padding: 12,
                    background: isActive ? '#fff8f6' : undefined,
                    borderColor: isActive ? '#7a1f1f' : undefined,
                    cursor: 'pointer',
                    boxShadow: 'none',
                  }}
                  onClick={() => onSelectBatch(batch.id)}
                >
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space>
                      <Tag color="#7a1f1f">{TEAM_LABEL[batch.team]}</Tag>
                      <Typography.Text strong>{batch.name}</Typography.Text>
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {batch.planFrom} ~ {batch.planTo}
                    </Typography.Text>
                    <Space size={4}>
                      <Button size="small" type="link" danger onClick={(event) => { event.stopPropagation(); confirmDelete(batch); }}>
                        删除批次
                      </Button>
                    </Space>
                  </Space>
                </Card.Grid>
              );
            })}
          </Space>
        )}
      </Card>

      <Modal
        open={batchModalOpen}
        title="新建巡演批次"
        okText="新建"
        cancelText="取消"
        onCancel={() => setBatchModalOpen(false)}
        onOk={() => void handleBatchOk()}
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical">
          <Form.Item name="name" label="批次名" rules={[{ required: true, message: '请填写批次名' }]}>
            <Input placeholder="如：秋后关中巡演" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item name="team" label="分队" rules={[{ required: true }]}>
                <Select options={TEAM_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
              </Form.Item>
            </Col>
            <Col span={14}>
              <Form.Item name="range" label="计划起止" rules={[{ required: true, message: '请选择起止日期' }]}>
                <DatePicker.RangePicker style={{ width: '100%' }} format="YYYY-MM-DD" allowClear={false} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="note" label="备注">
            <Input placeholder="路线、带队人等" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

interface BatchFormValues {
  name: string;
  team: TroupeTeam;
  range: [Dayjs, Dayjs];
  note: string;
}

function PerformanceManager({
  plays,
  activeBatch,
  performances,
  perfModalOpen,
  setPerfModalOpen,
}: {
  plays: PlayRowLike[];
  activeBatch: TourBatchRow | null;
  performances: TourPerformanceRow[];
  perfModalOpen: boolean;
  setPerfModalOpen: (open: boolean) => void;
}) {
  const { message, modal } = App.useApp();
  const addPerformance = useTourStore((state) => state.addPerformance);
  const performPerformance = useTourStore((state) => state.performPerformance);
  const cancelPerformance = useTourStore((state) => state.cancelPerformance);
  const reopenPerformance = useTourStore((state) => state.reopenPerformance);
  const removePerformance = useTourStore((state) => state.removePerformance);
  const authorizations = useTourStore((state) => state.authorizations);
  const [perfForm] = Form.useForm<PerfFormValues>();
  const [receiptTarget, setReceiptTarget] = useState<TourPerformanceRow | null>(null);
  const [receiptNo, setReceiptNo] = useState('');

  const openCreate = () => {
    perfForm.setFieldsValue({
      linkedPlayId: plays[0]?.id ?? null,
      playTitle: plays[0]?.title ?? '',
      showDate: dayjs(),
      region: '',
      venue: '',
      note: '',
    });
    setPerfModalOpen(true);
  };

  const handlePerfOk = async () => {
    if (!activeBatch) return;
    const values = await perfForm.validateFields();
    const draft: TourPerformanceDraft = {
      batchId: activeBatch.id,
      playId: values.linkedPlayId,
      playTitle: values.playTitle,
      showDate: values.showDate.format('YYYY-MM-DD'),
      region: values.region.trim(),
      venue: values.venue.trim(),
      note: values.note.trim(),
    };
    await addPerformance(draft);
    message.success('场次已排入，额度已预占；可在对账总览查看核对结论');
    setPerfModalOpen(false);
  };

  const confirmPerform = (performance: TourPerformanceRow) => {
    setReceiptTarget(performance);
    setReceiptNo(performance.receiptNo ?? '');
  };

  const submitReceipt = async () => {
    if (!receiptTarget) return;
    await performPerformance(receiptTarget.id, receiptNo || undefined);
    message.success('已登记演出，预占额度转已用，授权依据已冻结');
    setReceiptTarget(null);
    setReceiptNo('');
  };

  const confirmCancel = (performance: TourPerformanceRow) => {
    modal.confirm({
      title: '取消该预占场次？',
      content: '取消后释放预占额度，场次保留为「已取消」，可随时重开再次预占。',
      okText: '取消场次',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: async () => {
        await cancelPerformance(performance.id);
        message.success('已取消并释放预占额度');
      },
    });
  };

  const columns: ColumnsType<TourPerformanceRow> = [
    { title: '日期', dataIndex: 'showDate', width: 110, sorter: (a, b) => a.showDate.localeCompare(b.showDate) },
    { title: '剧目', dataIndex: 'playTitle', width: 150, render: (text: string) => <Typography.Text>《{text}》</Typography.Text> },
    { title: '地区', dataIndex: 'region', width: 130 },
    { title: '戏台', dataIndex: 'venue', width: 160, render: (text: string) => text || '—' },
    {
      title: '状态',
      dataIndex: 'state',
      width: 100,
      render: (state: TourPerformanceRow['state']) => <Tag color={PERFORMANCE_STATE_COLOR[state]}>{PERFORMANCE_STATE_LABEL[state]}</Tag>,
    },
    {
      title: '授权匹配 / 依据',
      width: 220,
      render: (_, row) => <PerformanceAuthCell row={row} authorizations={authorizations} />,
    },
    {
      title: '操作',
      key: 'actions',
      width: 250,
      render: (_, row) => (
        <Space size={2} wrap>
          {row.state === 'held' ? (
            <>
              <Button size="small" type="link" onClick={() => confirmPerform(row)}>演完登记</Button>
              <Button size="small" type="link" danger onClick={() => confirmCancel(row)}>取消场次</Button>
            </>
          ) : null}
          {row.state === 'cancelled' ? (
            <Button size="small" type="link" onClick={async () => { await reopenPerformance(row.id); message.success('已重开，按当前授权重新预占额度'); }}>
              重开预占
            </Button>
          ) : null}
          {row.state === 'performed' ? (
            <Tooltip title={row.basis ? `冻结依据：${row.basis.docNo || '无授权'} · 结论 ${RECON_VERDICT_LABEL[row.basis.verdict]}` : ''}>
              <Button size="small" type="link" disabled>已演 {formatStamp(row.performedAt ?? '')}</Button>
            </Tooltip>
          ) : null}
          <Button size="small" type="link" danger onClick={() => { void removePerformance(row.id); }}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Card
        size="small"
        title={activeBatch ? `${TEAM_LABEL[activeBatch.team]} · ${activeBatch.name}（${activeBatch.planFrom} ~ ${activeBatch.planTo}）` : '选择左侧批次后排场次'}
        extra={
          activeBatch ? (
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
              排一场（预占额度）
            </Button>
          ) : null
        }
      >
        {!activeBatch ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先新建并选择一个巡演批次" />
        ) : performances.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该批次还没排场次" />
        ) : (
          <Table<TourPerformanceRow> rowKey="id" columns={columns} dataSource={performances} pagination={false} size="small" />
        )}
      </Card>

      <Modal
        open={perfModalOpen}
        title={`排场次 · ${activeBatch?.name ?? ''}（${activeBatch ? TEAM_LABEL[activeBatch.team] : ''}）`}
        okText="排入并预占"
        cancelText="取消"
        onCancel={() => setPerfModalOpen(false)}
        onOk={() => void handlePerfOk()}
        destroyOnClose
      >
        <Form form={perfForm} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="linkedPlayId" label="剧目" rules={[{ required: true, message: '请选择剧目' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="旧剧目可只填剧名"
                  options={plays.map((play) => ({ value: play.id, label: play.title }))}
                  onChange={(value: string) => {
                    const play = plays.find((item) => item.id === value);
                    if (play) perfForm.setFieldValue('playTitle', play.title);
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="showDate" label="演出日期" rules={[{ required: true, message: '请选择日期' }]}>
                <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" allowClear={false} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="playTitle" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            name="region"
            label="演出地区"
            rules={[{ required: true, message: '请填写演出地区' }]}
            extra="须与授权书批准地区逐字一致（归一空白后比对）"
          >
            <Input placeholder="如：陕西·西安" />
          </Form.Item>
          <Form.Item name="venue" label="戏台 / 戏院">
            <Input placeholder="如：易俗社小剧场" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="晚场、票价、带队等" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={receiptTarget !== null}
        title="登记演出回执（预占转已用）"
        okText="确认已演"
        cancelText="取消"
        onCancel={() => setReceiptTarget(null)}
        onOk={() => void submitReceipt()}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            {receiptTarget
              ? `${receiptTarget.showDate} ${receiptTarget.region}《${receiptTarget.playTitle}》演完后，将冻结当前授权依据；之后授权更新也不影响该场。`
              : ''}
          </Typography.Paragraph>
          <Input
            value={receiptNo}
            onChange={(event) => setReceiptNo(event.target.value)}
            placeholder="回执号（可留空，回执导入时回填）"
          />
        </Space>
      </Modal>
    </>
  );
}

interface PerfFormValues {
  linkedPlayId: string;
  playTitle: string;
  showDate: Dayjs;
  region: string;
  venue: string;
  note: string;
}

/** 场次行的授权匹配/冻结依据单元格 */
function PerformanceAuthCell({
  row,
  authorizations,
}: {
  row: TourPerformanceRow;
  authorizations: AuthorizationRow[];
}) {
  if (row.state === 'performed' && row.basis) {
    return (
      <Space direction="vertical" size={0}>
        <Typography.Text style={{ fontSize: 12 }}>冻结依据：{row.basis.docNo || '无授权书'}</Typography.Text>
        <Tag color={RECON_VERDICT_COLOR[row.basis.verdict]} style={{ marginInlineStart: 0 }}>
          {RECON_VERDICT_LABEL[row.basis.verdict]}
        </Tag>
      </Space>
    );
  }
  const matched = row.matchedAuthId ? authorizations.find((auth) => auth.id === row.matchedAuthId) : null;
  if (!matched) return <Tag color="warning">无现行授权 · 待补</Tag>;
  return (
    <Tooltip title={`${matched.regions.join('、')}｜${matched.validFrom} ~ ${matched.validTo}｜额度 ${matched.quota}`}>
      <Tag color="processing">{matched.docNo} · v{matched.versionNo}</Tag>
    </Tooltip>
  );
}
