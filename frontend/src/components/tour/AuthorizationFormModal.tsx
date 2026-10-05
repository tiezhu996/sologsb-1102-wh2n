/**
 * 授权书新建/编辑/换发共用表单弹窗
 */
import { useEffect } from 'react';
import { Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { AuthorizationDraft } from '../../types/tour';

/** 弹窗只需要剧目的 id / 名字 */
export type PlayOption = { id: string; title: string };

export interface AuthFormValues {
  docNo: string;
  linkedPlayId: string | null;
  playTitle: string;
  regionsText: string;
  range: [Dayjs, Dayjs];
  quota: number;
  issuer: string;
  note: string;
}

interface Props {
  open: boolean;
  title: string;
  okText: string;
  plays: PlayOption[];
  /** 编辑/换发时的初始值；新建为 null */
  initial: AuthorizationDraft | null;
  onCancel: () => void;
  onSubmit: (draft: AuthorizationDraft) => Promise<void> | void;
}

/** 对外草稿 ↔ 表单值 */
export function draftToFormValues(draft: AuthorizationDraft, plays: PlayOption[]): AuthFormValues {
  const linked = draft.playId && plays.some((play) => play.id === draft.playId) ? draft.playId : null;
  return {
    docNo: draft.docNo,
    linkedPlayId: linked,
    playTitle: draft.playTitle,
    regionsText: draft.regions.join('、'),
    range: [dayjs(draft.validFrom), dayjs(draft.validTo)],
    quota: draft.quota,
    issuer: draft.issuer,
    note: draft.note,
  };
}

export function emptyAuthFormValues(playTitle = ''): AuthFormValues {
  return {
    docNo: '',
    linkedPlayId: null,
    playTitle,
    regionsText: '',
    range: [dayjs(), dayjs().add(30, 'day')],
    quota: 10,
    issuer: '',
    note: '',
  };
}

export default function AuthorizationFormModal({ open, title, okText, plays, initial, onCancel, onSubmit }: Props) {
  const [form] = Form.useForm<AuthFormValues>();

  useEffect(() => {
    if (open) {
      form.setFieldsValue(initial ? draftToFormValues(initial, plays) : emptyAuthFormValues());
    }
  }, [open, initial, plays, form]);

  const handleOk = async () => {
    const values = await form.validateFields();
    const regions = values.regionsText
      .split(/[、，,\/；;\s]+/)
      .map((item) => item.trim())
      .filter((item) => item !== '');
    await onSubmit({
      docNo: values.docNo.trim(),
      playId: values.linkedPlayId,
      playTitle: values.playTitle.trim(),
      regions,
      validFrom: values.range[0].format('YYYY-MM-DD'),
      validTo: values.range[1].format('YYYY-MM-DD'),
      quota: values.quota,
      issuer: values.issuer.trim(),
      note: values.note.trim(),
    });
  };

  return (
    <Modal open={open} title={title} okText={okText} cancelText="取消" onCancel={onCancel} onOk={() => void handleOk()} destroyOnClose width={680}>
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="docNo" label="授权书号（批准文号）" rules={[{ required: true, message: '请填写授权书号' }]}>
              <Input placeholder="如：滦文演准字〔2026〕第 018 号" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="linkedPlayId" label="关联本地剧目（可不选）">
              <Select
                allowClear
                placeholder="旧剧目可仅填剧名"
                showSearch
                optionFilterProp="label"
                options={plays.map((play) => ({ value: play.id, label: play.title }))}
                onChange={(value: string | null) => {
                  const play = plays.find((item) => item.id === value);
                  if (play) form.setFieldValue('playTitle', play.title);
                }}
              />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="playTitle" label="授权书写明的剧目名" rules={[{ required: true, message: '请填写剧目名' }]}>
          <Input placeholder="如：白蛇传·借伞" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={15}>
            <Form.Item name="range" label="批准起止日期（含端点）" rules={[{ required: true, message: '请选择起止日期' }]}>
              <DatePicker.RangePicker style={{ width: '100%' }} format="YYYY-MM-DD" allowClear={false} />
            </Form.Item>
          </Col>
          <Col span={9}>
            <Form.Item name="quota" label="批准场次额度" rules={[{ required: true, message: '请填写场次额度' }]}>
              <InputNumber min={1} max={9999} precision={0} style={{ width: '100%' }} addonAfter="场" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="regionsText"
          label="批准可演地区（顿号/逗号分隔）"
          rules={[{ required: true, message: '请填写至少一个地区' }]}
        >
          <Input placeholder="如：陕西·西安、陕西·渭南、山西·运城" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="issuer" label="发证机关 / 批准单位">
              <Input placeholder="如：滦州市文化演出管理处" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="note" label="备注">
              <Input placeholder="限定条件、联系人等" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}
