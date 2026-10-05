/**
 * 新建巡演批次：两个分队各排一套，批次必须关联本地剧目（便于额度挂池）。
 */
import { useEffect } from 'react';
import { Form, Input, Modal, Select } from 'antd';
import type { PlayRow } from '../../utils/db';
import { TROUPE_OPTIONS, type TroupeCode } from '../../types/tour';

interface FormValues {
  batchNo: string;
  troupe: TroupeCode;
  playId: string;
  note: string;
}

interface Props {
  open: boolean;
  plays: PlayRow[];
  submitting: boolean;
  onSubmit: (values: { batchNo: string; troupe: TroupeCode; playId: string | null; playTitle: string; note: string }) => Promise<void> | void;
  onCancel: () => void;
}

export default function BatchCreateModal(props: Props) {
  const { open, plays, submitting, onSubmit, onCancel } = props;
  const [form] = Form.useForm<FormValues>();

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        batchNo: `B2026-${String(Math.floor(100 + Math.random() * 900))}`,
        troupe: 'first',
        playId: plays[0]?.id,
        note: '',
      });
    }
  }, [open, plays, form]);

  const handleOk = async () => {
    const values = await form.validateFields();
    const play = plays.find((item) => item.id === values.playId);
    await onSubmit({
      batchNo: values.batchNo.trim(),
      troupe: values.troupe,
      playId: play ? play.id : null,
      playTitle: play ? play.title : '未关联剧目',
      note: values.note.trim(),
    });
  };

  return (
    <Modal
      open={open}
      title="新建巡演批次"
      okText="建立批次"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void handleOk()}
      onCancel={onCancel}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item name="batchNo" label="批次号" rules={[{ required: true, message: '请填写批次号' }, { max: 40 }]}>
          <Input placeholder="如：B2026-104" />
        </Form.Item>
        <Form.Item name="troupe" label="分队" rules={[{ required: true }]}>
          <Select options={[...TROUPE_OPTIONS]} />
        </Form.Item>
        <Form.Item
          name="playId"
          label="巡演剧目"
          rules={[{ required: true, message: '请选择本批演出的本地剧目' }]}
          extra="两个分队可各自建批演同一剧目，场次额度合并到该剧目的同一授权池里核对。"
        >
          <Select
            placeholder="选择本地剧目"
            options={plays.map((play) => ({ value: play.id, label: play.title }))}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} maxLength={200} showCount placeholder="巡演路线、带队师傅、箱件安排等" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
