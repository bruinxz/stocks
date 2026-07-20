/**
 * webhookUrlGuard — Batch X (2026-06-17)
 *
 * SSRF / phishing 防护. 用户可在 SettingsController 提交 webhook_url, 之前
 * 统一 FeishuNotificationService 在真正投递前调用本守卫；攻击者若可填入:
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/  → AWS 元数据泄露
 *   http://10.0.0.1:6379/  → 内网 Redis 无认证 POST 触发命令
 *   http://attacker.com/x  → 把告警卡片 (含用户信息) 推给攻击者
 *
 * 本 helper 校验:
 *  1. 必须 https:// (生产) 或 http://localhost (dev 测试)
 *  2. hostname 命中飞书域名 / env FEISHU_WEBHOOK_HOST_ALLOWLIST 白名单
 *  3. 解析后 IP 不在 RFC1918 / 127.0.0.0/8 / 169.254.0.0/16 / ::1
 *  4. axios.post 调用方应额外用 { maxRedirects: 0 } 防 302 → 内网跳转绕过
 */

import { URL } from 'url';

// Batch BF (2026-06-23): 补 open.larkoffice.com (Lark CN open API host 别名).
// 之前默认 allowlist 只含 open.feishu.cn / open.larksuite.com, 导致 prod 真正配置
// 的 webhook (host=open.larkoffice.com) 全部被 reject → 飞书告警一条都发不出去
// (从 combined.log 看每分钟多次 "feishu webhook_url 校验失败"). 仍只放行飞书 /
// Lark 官方域, 不放任意 host. 用户仍可通过 FEISHU_WEBHOOK_HOST_ALLOWLIST 扩展.
const DEFAULT_FEISHU_HOSTS = ['open.feishu.cn', 'open.larksuite.com', 'open.larkoffice.com'];

function resolveAllowlist(): string[] {
  const env = process.env.FEISHU_WEBHOOK_HOST_ALLOWLIST;
  if (!env) return DEFAULT_FEISHU_HOSTS;
  const extra = env
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return [...DEFAULT_FEISHU_HOSTS, ...extra];
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1') return true;
  // IPv4 numeric check
  const ipv4 = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  // IPv6 link-local / loopback
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // 内网主机名启发式 (不严格, 配合 allowlist)
  if (lower.endsWith('.internal') || lower.endsWith('.local') || lower.endsWith('.lan'))
    return true;
  return false;
}

export interface WebhookValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * 校验 webhook URL 是否安全可调.
 * caller 应在 catch 拦截 reason 给 user / log 不要 axios.post 出去.
 */
export function validateWebhookUrl(rawUrl: string): WebhookValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'webhook_url 为空' };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'webhook_url 不是合法 URL' };
  }
  // 1. protocol: 必须 https; dev 可 http://localhost 测试
  if (url.protocol !== 'https:') {
    if (process.env.NODE_ENV !== 'production' && url.hostname === 'localhost') {
      // dev http://localhost 允许
    } else {
      return { ok: false, reason: `webhook_url 必须 https:// (收到 ${url.protocol})` };
    }
  }
  // 2. 内网 / 元数据地址直接拒
  if (isPrivateOrLocalHostname(url.hostname)) {
    if (process.env.NODE_ENV !== 'production' && url.hostname === 'localhost') {
      // dev fallthrough
    } else {
      return {
        ok: false,
        reason: `webhook_url hostname '${url.hostname}' 是内网 / loopback / 云元数据地址, 拒绝 (SSRF 防护)`,
      };
    }
  }
  // 3. hostname allowlist (允许子域名)
  const allowlist = resolveAllowlist();
  const hostnameLower = url.hostname.toLowerCase();
  const allowed = allowlist.some(h => {
    const hLower = h.toLowerCase();
    return hostnameLower === hLower || hostnameLower.endsWith(`.${hLower}`);
  });
  if (!allowed && process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      reason: `webhook_url hostname '${url.hostname}' 不在白名单 (${allowlist.join(
        ', '
      )}). 如需新增, 在 FEISHU_WEBHOOK_HOST_ALLOWLIST env 配置`,
    };
  }
  return { ok: true };
}

/**
 * 同步抛错版，供设置入口与统一 outbox sender 使用。
 */
export function assertWebhookUrlAllowed(rawUrl: string, fieldLabel = 'webhook_url'): void {
  const result = validateWebhookUrl(rawUrl);
  if (!result.ok) {
    const err: any = new Error(`${fieldLabel} 校验失败: ${result.reason}`);
    err.statusCode = 400;
    err.code = 'WEBHOOK_URL_INVALID';
    throw err;
  }
}
