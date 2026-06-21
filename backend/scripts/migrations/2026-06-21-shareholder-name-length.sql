-- 2026-06-21 数据 sync 修复 — shareholder_trade_records.shareholder_name
-- 长度限制 200 不够装下私募 / 产业基金 / 合伙企业 的完整名称
-- (e.g. "深圳市XXXX股权投资合伙企业(有限合伙)-..." 经常超 200 字符),
-- 导致 ShareholderTradeSyncService.syncSnapshot('全部') 整批 INSERT 失败.
-- 放宽到 500 与 sequelize model 同步.

ALTER TABLE shareholder_trade_records
  ALTER COLUMN shareholder_name TYPE VARCHAR(500);
