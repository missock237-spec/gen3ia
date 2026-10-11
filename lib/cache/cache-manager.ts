import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const memoryCache = new Map<string, { value: any; expiry: number }>();

export class CacheManager {
  // Cache mémoire pour données ultra-fréquentes
  static setMemory(key: string, value: any, ttlMs: number = 30000) {
    memoryCache.set(key, { value, expiry: Date.now() + ttlMs });
  }
  
  static getMemory(key: string) {
    const item = memoryCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      memoryCache.delete(key);
      return null;
    }
    return item.value;
  }
  
  // Cache Redis pour données partagées
  static async set(key: string, value: any, ttlSeconds: number = 300) {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  }
  
  static async get<T>(key: string): Promise<T | null> {
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  }
  
  // Cache avec tags pour invalidation groupée
  static async setWithTag(key: string, value: any, tag: string, ttlSeconds: number = 300) {
    const pipeline = redis.pipeline();
    pipeline.setex(key, ttlSeconds, JSON.stringify(value));
    pipeline.sadd(`tag:${tag}`, key);
    pipeline.expire(`tag:${tag}`, ttlSeconds);
    await pipeline.exec();
  }
  
  static async invalidateTag(tag: string) {
    const keys = await redis.smembers(`tag:${tag}`);
    if (keys.length > 0) {
      await redis.del(...keys, `tag:${tag}`);
    }
  }
  
  // Cache-aside pattern pour Firestore
  static async getOrSet<T>(
    key: string, 
    fetchFn: () => Promise<T>, 
    ttlSeconds: number = 300
  ): Promise<T> {
    // 1. Vérifier mémoire
    const memory = CacheManager.getMemory(key);
    if (memory) return memory;
    
    // 2. Vérifier Redis
    const cached = await CacheManager.get<T>(key);
    if (cached) {
      CacheManager.setMemory(key, cached, 5000);
      return cached;
    }
    
    // 3. Fetch depuis la source
    const fresh = await fetchFn();
    await CacheManager.set(key, fresh, ttlSeconds);
    CacheManager.setMemory(key, fresh, 5000);
    
    return fresh;
  }
}

// Usage
export async function getAgentConfig(agentId: string) {
  return CacheManager.getOrSet(
    `agent:${agentId}`,
    () => db.collection('agents').doc(agentId).get().then(doc => doc.data()),
    300 // 5 minutes
  );
  }
