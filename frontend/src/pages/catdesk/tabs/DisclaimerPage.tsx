import { ArrowLeftOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Alert, Divider, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';

const { Title, Paragraph, Text } = Typography;

export default function DisclaimerPage() {
  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '24px 16px 48px' }}>
      <Link
        to="/catdesk"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 20,
          color: 'var(--cd-text-secondary)',
        }}
      >
        <ArrowLeftOutlined />
        返回研究台
      </Link>

      <Typography style={{ color: 'var(--cd-text-primary)' }}>
        <div
          style={{
            padding: '24px 28px',
            border: '1px solid var(--cd-border)',
            borderRadius: 'var(--cd-radius-md)',
            background:
              'linear-gradient(135deg, var(--cd-bg-surface), color-mix(in srgb, var(--cd-accent) 12%, var(--cd-bg-surface)))',
          }}
        >
          <Tag icon={<SafetyCertificateOutlined />} color="blue">
            风险披露
          </Tag>
          <Title level={2} style={{ margin: '14px 0 8px', color: 'var(--cd-text-primary)' }}>
            免责声明
          </Title>
          <Paragraph style={{ margin: 0, color: 'var(--cd-text-secondary)' }}>
            先理解信息边界，再使用评分、推荐与仓位提示。
          </Paragraph>
        </div>

        <Divider />

        <Alert
          type="warning"
          showIcon
          message="仅参考 · 非下单"
          description="所有输出均为研究信息，不构成投资建议、投资推荐或交易指令。"
          style={{ marginBottom: 24 }}
        />

        <Title level={4} style={{ color: 'var(--cd-text-primary)' }}>
          投资建议声明
        </Title>
        <Paragraph style={{ color: 'var(--cd-text-secondary)' }}>
          本平台所展示的所有数据、评分、推荐、分析结果及相关内容（以下统称“信息”）仅供参考，
          <Text strong>不构成任何投资建议、投资推荐或下单指令</Text>。
          用户应根据自身的投资目标、财务状况和风险承受能力，独立判断并做出投资决策。
        </Paragraph>

        <Title level={4} style={{ color: 'var(--cd-text-primary)' }}>
          仓位建议（SizeHint）说明
        </Title>
        <Paragraph style={{ color: 'var(--cd-text-secondary)' }}>
          仓位建议（SizeHint）分为五个档次，仅供参考：
        </Paragraph>
        <ul style={{ paddingLeft: 24, color: 'var(--cd-text-secondary)', lineHeight: 2 }}>
          <li>
            <Text code>TIER_5</Text> — 参考仓位 ≤ 5%（最高确信度）
          </li>
          <li>
            <Text code>TIER_3</Text> — 参考仓位 ≤ 3%
          </li>
          <li>
            <Text code>TIER_2</Text> — 参考仓位 ≤ 2%
          </li>
          <li>
            <Text code>TIER_1</Text> — 参考仓位 ≤ 1%（最低确信度）
          </li>
          <li>
            <Text code>SKIP</Text> — 不建议参与
          </li>
        </ul>
        <Paragraph style={{ color: 'var(--cd-text-secondary)' }}>
          <Text strong>仅参考 · 非下单 binding · 不构成投资建议。</Text>
          实际仓位应由用户根据自身情况自行决定。
        </Paragraph>

        <Title level={4} style={{ color: 'var(--cd-text-primary)' }}>
          数据来源
        </Title>
        <Paragraph style={{ color: 'var(--cd-text-secondary)' }}>
          本平台使用的数据均来自公开免费数据源（free-source-only），包括但不限于：
        </Paragraph>
        <ul style={{ paddingLeft: 24, color: 'var(--cd-text-secondary)', lineHeight: 2 }}>
          <li>SEC EDGAR（美国证券交易委员会公开文件）</li>
          <li>NASDAQ Earnings Calendar（纳斯达克财报日历）</li>
          <li>Yahoo Finance（雅虎财经公开数据，opt-in）</li>
          <li>Alpha Vantage（免费 API 层，opt-in）</li>
          <li>Baostock（A 股免费数据源，opt-in）</li>
        </ul>
        <Paragraph style={{ color: 'var(--cd-text-secondary)' }}>
          数据可能存在延迟、缺失或错误。本平台不对数据的完整性、准确性或及时性做任何保证。
        </Paragraph>

        <Title level={4} style={{ color: 'var(--cd-text-primary)' }}>
          模型局限性
        </Title>
        <Paragraph style={{ color: 'var(--cd-text-secondary)' }}>
          本平台使用的评分模型（6 维度评分）、确信度计算、风控门控等均为量化模型输出，
          存在固有局限性。模型基于历史数据训练和调参，不代表未来表现。 过往收益不代表未来收益。
        </Paragraph>

        <Title level={4} style={{ color: 'var(--cd-text-primary)' }}>
          风险提示
        </Title>
        <Paragraph style={{ color: 'var(--cd-text-secondary)' }}>
          投资有风险，入市需谨慎。股票交易可能导致本金全部损失。
          本平台对用户因使用平台信息而产生的任何损失不承担任何责任。
        </Paragraph>

        <Divider />

        <Paragraph type="secondary" style={{ fontSize: 12, textAlign: 'center' }}>
          本平台仅供个人学习研究使用 · 非商业用途 · free-source only
        </Paragraph>
      </Typography>
    </div>
  );
}
