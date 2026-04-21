import { sequelize } from '../config/database';
import { DailyScreener } from '../models/DailyScreener';
import { RiskAlert } from '../models/RiskAlert';
import { TradingJournal } from '../models/TradingJournal';
import { User } from '../models/User';
import { logger } from '../utils/logger';

async function seedData() {
  try {
    await sequelize.authenticate();
    logger.info('Database connected.');

    // 1. 获取第一个用户
    const user = await User.findOne();
    if (!user) {
      logger.error('No users found. Please create a user first.');
      return;
    }

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // 2. 生成 AI 每日优选数据
    await DailyScreener.destroy({ where: { date: todayStr } });
    await DailyScreener.bulkCreate([
      {
        date: todayStr,
        symbol: 'sh.600519',
        name: '贵州茅台',
        score: 95.5,
        rationale: '基本面稳健，Q1业绩超预期，北向资金持续流入，MACD金叉，AI综合评分极高。',
        decision: 'STRONG_BUY',
        scores: { technical: 95, fundamental: 96, sentiment: 94 }
      },
      {
        date: todayStr,
        symbol: 'sz.002594',
        name: '比亚迪',
        score: 88.0,
        rationale: '新能源汽车销量持续霸榜，电池技术有新突破，目前处于技术面支撑位。',
        decision: 'BUY',
        scores: { technical: 85, fundamental: 92, sentiment: 88 }
      },
      {
        date: todayStr,
        symbol: 'sh.601318',
        name: '中国平安',
        score: 82.5,
        rationale: '寿险改革成效显现，估值处于历史低位，具备较高的安全边际。',
        decision: 'BUY',
        scores: { technical: 80, fundamental: 85, sentiment: 83 }
      },
      {
        date: todayStr,
        symbol: 'sz.000858',
        name: '五粮液',
        score: 75.0,
        rationale: '消费复苏预期增强，但短期面临库存压力，建议逢低吸纳。',
        decision: 'HOLD',
        scores: { technical: 70, fundamental: 80, sentiment: 75 }
      }
    ]);
    logger.info('Seeded DailyScreener data.');

    // 3. 生成 风控告警数据
    await RiskAlert.destroy({ where: { user_id: user.id } });
    await RiskAlert.bulkCreate([
      {
        user_id: user.id,
        symbol: 'sz.000001',
        name: '平安银行',
        level: 'HIGH',
        message: '股价单日下跌超过5%，触发止损预警，请注意风险！',
        is_read: false,
      },
      {
        user_id: user.id,
        symbol: 'sh.600036',
        name: '招商银行',
        level: 'MEDIUM',
        message: '成交量异常放大，超过过去10日平均成交量的300%。',
        is_read: false,
      },
      {
        user_id: user.id,
        symbol: 'sz.000002',
        name: '万科A',
        level: 'HIGH',
        message: '跌破重要支撑位(MA60)，短期趋势可能转弱。',
        is_read: false,
      }
    ]);
    logger.info('Seeded RiskAlert data.');

    // 4. 生成 交易日记数据
    await TradingJournal.destroy({ where: { user_id: user.id } });
    await TradingJournal.bulkCreate([
      {
        user_id: user.id,
        date: todayStr,
        market_summary: '今天大盘整体震荡，上证指数微跌0.1%，深证成指上涨0.2%。新能源板块表现活跃，白酒板块出现调整。',
        portfolio_analysis: '持仓的消费股表现一般，贵州茅台小幅回撤。加仓的比亚迪带来了一定收益。平安银行触发了止损告警，建议关注明日走势，如继续跌破支撑位建议减仓。',
        action_plan: '1. 密切关注平安银行的走势，跌破10元果断止损；\n2. 观察新能源板块的持续性，寻找加仓机会；\n3. 整体保持5成仓位，控制风险。'
      },
      {
        user_id: user.id,
        date: new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 昨天
        market_summary: '市场情绪有所回暖，北向资金净流入超过50亿。大金融板块护盘，科技股冲高回落。',
        portfolio_analysis: '按照计划加仓了贵州茅台，成本控制在合理区间。招商银行出现放量上涨，持仓浮盈增加。',
        action_plan: '1. 贵州茅台继续持有，观察能否突破前期高点；\n2. 部分科技股短期涨幅过大，可能面临回调风险，暂时不碰；\n3. 留意明日宏观经济数据的发布。'
      }
    ]);
    logger.info('Seeded TradingJournal data.');

    logger.info('All seed data inserted successfully!');
    process.exit(0);
  } catch (error) {
    logger.error('Failed to seed data:', error);
    process.exit(1);
  }
}

seedData();
