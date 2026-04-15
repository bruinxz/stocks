import { createClient, RedisClientType } from 'redis';
import { logger } from './logger';

// Redis客户端实例
const redisClient: RedisClientType = createClient({
  url: `redis://${process.env.REDIS_PASSWORD ? `:${process.env.REDIS_PASSWORD}@` : ''}${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
  database: parseInt(process.env.REDIS_DB || '0'),
});

// 设置键前缀
redisClient.on('connect', () => {
  logger.debug('Redis锁客户端已连接');
});

redisClient.on('error', (error) => {
  logger.error('Redis锁客户端错误:', error);
});

// 连接Redis
redisClient.connect().catch(error => {
  logger.error('连接Redis失败:', error);
});

export class RedisLock {
  private static instance: RedisLock;
  private client: RedisClientType;

  private constructor() {
    this.client = redisClient;
  }

  static getInstance(): RedisLock {
    if (!RedisLock.instance) {
      RedisLock.instance = new RedisLock();
    }
    return RedisLock.instance;
  }

  /**
   * 尝试获取分布式锁
   * @param key 锁的键名
   * @param ttl 锁的存活时间（毫秒），默认30分钟
   * @param retryDelay 重试延迟（毫秒），默认500ms
   * @param maxRetries 最大重试次数，默认3次
   * @returns 锁的标识符（解锁时需要），获取失败返回null
   */
  async acquire(
    key: string,
    ttl: number = 30 * 60 * 1000, // 30分钟
    retryDelay: number = 500,
    maxRetries: number = 3
  ): Promise<string | null> {
    const lockValue = `lock:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    let retries = 0;

    while (retries <= maxRetries) {
      try {
        // 使用SET命令，NX参数确保只在键不存在时设置，PX参数设置过期时间
        const result = await this.client.set(key, lockValue, {
          NX: true,
          PX: ttl,
        });

        // @ts-ignore - redis client may return 'OK' or true
        if (result === 'OK' || result === true) {
          logger.debug(`成功获取锁: ${key}, value: ${lockValue}, ttl: ${ttl}ms`);
          return lockValue;
        }

        // 锁已被其他进程持有
        if (retries < maxRetries) {
          logger.debug(`锁 ${key} 被占用，等待 ${retryDelay}ms 后重试 (${retries + 1}/${maxRetries})`);
          await this.sleep(retryDelay);
          retryDelay *= 2; // 指数退避
        }
        retries++;
      } catch (error) {
        logger.error(`获取锁 ${key} 失败:`, error);
        throw error;
      }
    }

    logger.warn(`获取锁 ${key} 失败，超过最大重试次数 ${maxRetries}`);
    return null;
  }

  /**
   * 释放分布式锁
   * @param key 锁的键名
   * @param lockValue 锁的标识符
   * @returns 是否成功释放
   */
  async release(key: string, lockValue: string): Promise<boolean> {
    try {
      // 使用Lua脚本确保原子性：只有锁的值匹配时才删除
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await this.client.eval(luaScript, {
        keys: [key],
        arguments: [lockValue]
      });

      if (result === 1) {
        logger.debug(`成功释放锁: ${key}, value: ${lockValue}`);
        return true;
      } else {
        logger.warn(`释放锁 ${key} 失败：锁已过期或被其他进程持有`);
        return false;
      }
    } catch (error) {
      logger.error(`释放锁 ${key} 失败:`, error);
      return false;
    }
  }

  /**
   * 检查锁是否存在
   * @param key 锁的键名
   * @returns 锁是否存在
   */
  async isLocked(key: string): Promise<boolean> {
    try {
      const value = await this.client.get(key);
      return value !== null;
    } catch (error) {
      logger.error(`检查锁 ${key} 失败:`, error);
      return false;
    }
  }

  /**
   * 获取锁的剩余存活时间
   * @param key 锁的键名
   * @returns 剩余时间（毫秒），-1表示永不过期，-2表示键不存在
   */
  async getLockTTL(key: string): Promise<number> {
    try {
      return await this.client.pTTL(key);
    } catch (error) {
      logger.error(`获取锁 ${key} 的TTL失败:`, error);
      return -2;
    }
  }

  /**
   * 尝试续期锁
   * @param key 锁的键名
   * @param lockValue 锁的标识符
   * @param newTtl 新的存活时间（毫秒）
   * @returns 是否成功续期
   */
  async renew(key: string, lockValue: string, newTtl: number): Promise<boolean> {
    try {
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("pexpire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;

      const result = await this.client.eval(luaScript, {
        keys: [key],
        arguments: [lockValue, newTtl.toString()]
      });
      return result === 1;
    } catch (error) {
      logger.error(`续期锁 ${key} 失败:`, error);
      return false;
    }
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch (error) {
      logger.error('Redis健康检查失败:', error);
      return false;
    }
  }
}

// 预定义的锁键名（添加前缀）
const LOCK_PREFIX = 'stock:lock:';
export const LockKeys = {
  DATA_UPDATE: `${LOCK_PREFIX}data:update:global`, // 全局数据更新锁
  STOCK_SYNC: (symbol: string) => `${LOCK_PREFIX}data:stock:sync:${symbol}`, // 单只股票同步锁
  DAILY_UPDATE: (date: string) => `${LOCK_PREFIX}data:daily:update:${date}`, // 每日更新锁
  NEW_STOCKS_SYNC: `${LOCK_PREFIX}data:new:stocks:sync`, // 新股同步锁
};

// 导出单例
export const redisLock = RedisLock.getInstance();