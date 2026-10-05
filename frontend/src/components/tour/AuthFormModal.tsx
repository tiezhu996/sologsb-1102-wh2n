/**
 * 授权书表单弹窗：新建首版 / 修改现行版 / 换发新版本。
 * 换发时文号默认沿用旧版，版本号自动 +1，旧版作废留存。
 */
import { useEffect, useMemo } from 'react';
import { DatePicker, Form, Input, InputNumber, Modal, Select } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { AuthDraft } from '../../types/tour';
import type { AuthRow } from '../../utils/db';

export type AuthFormMode = 'create' | 'edit' | 'renew';

interface AuthFormValues {
  docNo: string;
  regions: string[];
  range: [Dayjs, Dayjs];
  totalQuota: number;
  issuedAt: Dayjs;
  note: string;
}

interface Props {
  open: boolean;
  mode: AuthFormMode;
  /** edit / renew 时的原授权书 */
  source?: AuthRow;
  /** 已有的全部地区，供标签选择复用 */
  regionSuggestions: string[];
  playTitle: string;
  submitting: boolean;
  onSubmit: (draft: AuthDraft) => Promise<void> | void;
  onCancel: () => void;
}

const TITLE_TEXT: Record<AuthFormMode, string> = {
  create: '补办授权书',
  edit: '修改现行授权书',
  renew: '换发新版授权书',
};

export default function AuthFormModal(props: Props) {
  const { open, mode, source, regionSuggestions, playTitle, submitting, onSubmit, onCancel } = props;
  const [form] = Form.useForm<AuthFormValues>();

  useEffect(() => {
    if (!open) return;
    if (source) {
      form.setFieldsValue({
        docNo: source.docNo,
        regions: [...source.regions],
        range: [dayjs(source.dateFrom), dayjs(source.dateTo)],
        totalQuota: source.totalQuota,
        issuedAt: dayjs(source.issuedAt),
        note: source.note,
      });
    } else {
      form.setFieldsValue({
        docNo: '',
        regions: [],
        totalQuota: 4,
        issuedAt: dayjs(),
        note: '',
      });
    }
  }, [open, source, form]);

  const options = useMemo(
    () => regionSuggestions.map((region) => ({ value: region, label: region })),
    [regionSuggestions],
  );

  const handleOk = async () => {
    const values = await form.validateFields();
    const draft: AuthDraft = {
      docNo: values.docNo.trim(),
      regions: values.regions.map((region) => region.trim()).filter(Boolean),
      dateFrom: values.range[0].format('YYYY-MM-DD'),
      dateTo: values.range[1].format('YYYY-MM-DD'),
      totalQuota: values.totalQuota,
      issuedAt: values.issuedAt.format('YYYY-MM-DD'),
      note: values.note.trim(),
    };
    await onSubmit(draft);
  };

  return (
    <Modal
      open={open}
      title={`${TITLE_TEXT[mode]} · ${playTitle}`}
      okText={mode === 'renew' ? '换发并重核未演场次' : mode === 'edit' ? '保存并重核未演场次' : '建档'}
      cancelText="取消"
      confirmLoading={submitting}
      onCancel={onCancel}
      onOk={() => void handleOk()}
      destroyOnClose
    >
      {mode === 'renew' ? (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fdf6ec', borderRadius: 6, fontSize: 13 }}>
          旧版（v{source?.versionNo ?? 1} {source?.docNo}）将置为「已作废」留存；已演场次继续保留旧版依据，
          只有<strong>未演场次</strong>按新版本范围重新核对。
        </div>
      ) : null}
      <Form form={form} layout="vertical">
        <Form.Item
          name="docNo"
          label="授权书文号"
          rules={[{ required: true, message: '请填写批准文号' }, { max: 60 }]}
        >
          <Input placeholder="如：滦文演准〔2026〕第 106 号" />
        </Form.Item>
        <Form.Item
          name="regions"
          label="批准演出地区"
          rules={[{ required: true, message: '至少填写一个地区' }]}
          extra="精确到地市，精确匹配；回车可录入多个，两队场次在此范围内共用额度。"
        >
          <Select mode="tags" options={options} placeholder="如：唐山市 / 秦皇岛市 / 天津市" tokenSeparators={['，', ',', '、']} />
        </Form.Item>
        <Form.Item name="range" label="授权有效期" rules={[{ required: true, message: '请选择起止日期' }]}>
          <DatePicker.RangePicker style={{ width: '100%' }} allowClear={false} />
        </Form.Item>
        <Form.Item
          name="totalQuota"
          label="批准场次额度（两队合计）"
          rules={[{ required: true, message: '请填写场次额度' }]}
        >
          <InputNumber min={1} max={999} precision={0} style={{ width: '100%' }} addonAfter="场" />
        </Form.Item>
        <Form.Item name="issuedAt" label="发证日期" rules={[{ required: true, message: '请选择发证日期' }]}>
          <DatePicker style={{ width: '100%' }} allowClear={false} />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} maxLength={200} showCount placeholder="范围说明、换发原因等" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
