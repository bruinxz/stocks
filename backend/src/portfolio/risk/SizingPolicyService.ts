/**
 * SizingPolicyService — Phase 2 用户 sizing 配置 CRUD
 *
 * 与同目录其他 guard service 一样的模式：
 *   - getConfig(user_id) → 读 User.risk_config.sizing_policy，回退 DEFAULT_SIZING_POLICY
 *   - updateConfig(user_id, raw) → normalize input → 写入 User.risk_config.sizing_policy
 *
 * 不像其他 guards 这里没有 evaluate() 方法 —— sizing policy 是**配置**，
 * 实际 sizing 决策由 decideSizing() 在 PaperTradingAutomationService 调用。
 *
 * **设计取舍**：暂时只提供配置 CRUD，不做强制接入。已有 sizing 逻辑保留为
 * 默认（method='equal_pct' 完全等价）。未来 story 把现有 sizing 一处一处
 * 切到 decideSizing() 后再彻底替换。
 */

import { User } from '../../models/User';
import { logger } from '../../utils/logger';
import {
  DEFAULT_SIZING_POLICY,
  SizingPolicyConfig,
  normalizeSizingPolicyConfig,
} from '../PositionSizingPolicy';

export class SizingPolicyService {
  /**
   * 读取用户当前 sizing 配置（缺失字段用 DEFAULT 补齐）。
   *
   * @returns SizingPolicyConfig (always 完整, normalized)
   */
  async getConfig(user_id: number): Promise<SizingPolicyConfig> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`SizingPolicyService.getConfig: user ${user_id} 不存在`);
    }
    const raw = (user.risk_config || {})['sizing_policy'];
    return normalizeSizingPolicyConfig(raw);
  }

  /**
   * 更新用户 sizing 配置；输入经 normalize 防止脏数据。
   *
   * @returns 保存后的 SizingPolicyConfig
   */
  async updateConfig(user_id: number, raw: any): Promise<SizingPolicyConfig> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`SizingPolicyService.updateConfig: user ${user_id} 不存在`);
    }
    const normalized = normalizeSizingPolicyConfig(raw);
    const riskConfig = { ...(user.risk_config || {}), sizing_policy: normalized };
    user.risk_config = riskConfig;
    // Sequelize JSONB 需要显式 changed 才会重写整个字段
    user.changed('risk_config', true);
    try {
      await user.save();
    } catch (error: any) {
      logger.error(`SizingPolicyService.updateConfig user=${user_id} failed:`, error);
      throw error;
    }
    return normalized;
  }

  /**
   * 返回 default + 当前 user 配置的对比，便于 UI 给"恢复默认"按钮。
   */
  async getConfigWithDefaults(
    user_id: number
  ): Promise<{ current: SizingPolicyConfig; defaults: SizingPolicyConfig }> {
    const current = await this.getConfig(user_id);
    return { current, defaults: { ...DEFAULT_SIZING_POLICY } };
  }
}

export const sizingPolicyService = new SizingPolicyService();
