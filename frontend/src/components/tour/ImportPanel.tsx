/**
 * 巡演导入面板：选择导入类型、下载 CSV 模板、选择文件并调用 store 处理。
 * 处理结果（成功 / 失败回滚 / 待核对）由外层导入记账列表展示。
 */
import { useRef, useState } from 'react';
import { App, Button, Card, Radio, Space, Typography } from 'antd';
import { DownloadOutlined, FileTextOutlined, UploadOutlined } from '@ant-design/icons';
import type { ImportKind } from '../../types/tour';
import { IMPORT_KIND_LABEL } from '../../types/tour';
import { useTourStore, type ProcessOutcome } from '../../stores/tourStore';

const TEMPLATES: Record<ImportKind, { header: string; sample: string; tip: string }> = {
  auth: {
    header: '授权书号,剧目,地区,开始日期,结束日期,场次额度,发证机关,备注',
    sample:
      '滦文演准字〔2026〕018号,白蛇传·借伞,陕西·西安、陕西·渭南,2026-10-01,2026-12-31,12,滦州市文化演出管理处,国庆档',
    tip: '同「授权书号」再次导入视为授权更新：自动升版本号，未演场次按新范围核对，已演场次保留原依据。',
  },
  schedule: {
    header: '批次,分队,日期,地区,戏台,剧目,备注',
    sample: '秋后关中巡演,甲队,2026-10-08,陕西·西安,易俗社小剧场,白蛇传·借伞,晚场',
    tip: '分队填「甲队/乙队」。排期导入即预占额度；同批次/同日期/同地区/同戏台的重复行不会重复预占。',
  },
  receipt: {
    header: '回执号,日期,地区,戏台,剧目',
    sample: 'HZ-20261008-01,2026-10-08,陕西·西安,易俗社小剧场,白蛇传·借伞',
    tip: '回执匹配已排的预占场次并转「已用」、冻结依据；回执号重复导入自动跳过，不重复占用额度。找不到排期则整批回滚留待核对。',
  },
};

function downloadTemplate(kind: ImportKind): void {
  const tpl = TEMPLATES[kind];
  const content = `﻿${tpl.header}\n${tpl.sample}\n`;
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `巡演${IMPORT_KIND_LABEL[kind].replace('导入', '')}模板.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export default function ImportPanel() {
  const { message } = App.useApp();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [kind, setKind] = useState<ImportKind>('schedule');
  const [busy, setBusy] = useState(false);
  const importFile = useTourStore((state) => state.importFile);

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const text = await file.text();
      const outcome = await importFile(kind, file.name, text);
      if ('error' in outcome) {
        message.error(outcome.error);
        return;
      }
      const result = outcome as ProcessOutcome;
      if (result.duplicated) {
        message.warning(result.message);
      } else if (result.status === 'success') {
        message.success(result.message);
      } else {
        message.error(result.message);
      }
    } catch (error) {
      message.error(`读取文件失败：${error instanceof Error ? error.message : '文件无法解析'}`);
    } finally {
      setBusy(false);
    }
  };

  const tpl = TEMPLATES[kind];

  return (
    <Card size="small" title="导入（授权书 / 排期 / 演出回执）" style={{ marginBottom: 12 }}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Radio.Group
          value={kind}
          onChange={(event) => setKind(event.target.value as ImportKind)}
          optionType="button"
          buttonStyle="solid"
          options={[
            { value: 'schedule', label: '排期（本地场次安排）' },
            { value: 'receipt', label: '演出回执（演完转已用）' },
            { value: 'auth', label: '授权书（外部批准范围）' },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          {tpl.tip}
        </Typography.Paragraph>
        <Space wrap>
          <Button icon={<DownloadOutlined />} onClick={() => downloadTemplate(kind)}>
            下载 CSV 模板
          </Button>
          <Button
            type="primary"
            icon={<UploadOutlined />}
            loading={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            选择文件导入
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <FileTextOutlined /> 支持 CSV / TSV，首行须为表头；导入失败会自动回滚额度并保留待核对批次。
          </Typography.Text>
        </Space>
      </Space>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/plain"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void handleFile(file);
        }}
      />
    </Card>
  );
}
