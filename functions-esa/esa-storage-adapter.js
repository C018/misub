/**
 * ESA EdgeKV 存储适配器（Cloudflare KV 接口兼容层）
 *
 * 设计目标：让现有业务代码（storage-adapter.js 的 KVStorageAdapter /
 * SettingsCache / resolveKV）无需任何改动即可运行在阿里云 ESA 边缘函数上。
 *
 * 通过实现与 CF KV namespace 相同的接口：
 *   get(key)             -> string | null
 *   put(key, value)      -> void
 *   delete(key)          -> boolean
 *   list({ prefix })     -> { keys: [{ name }] }
 *
 * 内部特性：
 * 1. EdgeKV 单 value 上限 1.8MB，超限数据自动按字节分片存储，
 *    分片对上层透明（get 自动拼接、delete 自动清理）。
 * 2. EdgeKV list 为字典序区间枚举（startKey 闭、endKey 开），
 *    本层将 CF 的前缀语义映射为 [prefix, prefix+\uffff) 区间，
 *    并过滤分片专用 key，保证 list 结果与 CF KV 一致。
 *
 * 限制与兼容性说明：
 * - EdgeKV 无原生 TTL，由业务层自行清理。
 * - get 未命中返回 null（CF 语义），与 EdgeKV 的 undefined 归一化。
 */

// 分片阈值：单 value 上限 1.8MB，留 0.3MB 余量避免多字节字符截断风险
export const SHARD_LIMIT_BYTES = 1_500_000;
// 分片 key 内部标记（业务 key 不应包含此标记，list 时会过滤）
const SHARD_PREFIX = '__esa_shard__';
// 分片占位标记：大 value 分片时主 key 写入该标记，
// 保证主 key 可被 list 枚举，get 读到该标记时自动走分片拼接。
const SHARD_MARKER = JSON.stringify({ __esaShardedV1__: true });

function utf8ByteLength(str) {
    return new TextEncoder().encode(str).length;
}

/**
 * 按字节长度切分字符串，保证每片不超过 maxBytes，
 * 且不会切断多字节 UTF-8 字符。
 */
export function splitByBytes(str, maxBytes) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const bytes = encoder.encode(str);
    const chunks = [];
    let start = 0;
    while (start < bytes.length) {
        let end = Math.min(start + maxBytes, bytes.length);
        // 回退到合法的 UTF-8 字符边界（不落在 continuation byte 上）
        while (end > start && (bytes[end] & 0xc0) === 0x80) {
            end--;
        }
        if (end === start) {
            // 单个字符超过阈值时强制截断，避免死循环
            end = Math.min(start + maxBytes, bytes.length);
        }
        chunks.push(decoder.decode(bytes.slice(start, end)));
        start = end;
    }
    return chunks;
}

/**
 * EdgeKV namespace 兼容层
 */
export class EsaKVNamespace {
    /**
     * @param {Object} edgeKv - new EdgeKV({ namespace }) 实例
     */
    constructor(edgeKv) {
        this._kv = edgeKv;
    }

    async _rawGet(key) {
        const value = await this._kv.get(key, { type: 'text' });
        return value === undefined ? null : value;
    }

    async _rawPut(key, value) {
        await this._kv.put(key, value);
    }

    async _rawDelete(key) {
        try {
            await this._kv.delete(key);
        } catch {
            // EdgeKV delete 未命中时部分实现会抛错，忽略即可
        }
    }

    async _clearShards(key) {
        const metaRaw = await this._rawGet(`${key}${SHARD_PREFIX}meta`);
        if (metaRaw === null) return;
        let meta = null;
        try {
            meta = JSON.parse(metaRaw);
        } catch {
            return;
        }
        if (meta && typeof meta.count === 'number') {
            for (let i = 0; i < meta.count; i++) {
                await this._rawDelete(`${key}${SHARD_PREFIX}${i}`);
            }
        }
        await this._rawDelete(`${key}${SHARD_PREFIX}meta`);
    }

    /**
     * 读取值。若目标被分片存储，自动拼接后返回完整字符串。
     * @param {string} key
     * @returns {Promise<string|null>}
     */
    async get(key) {
        const raw = await this._rawGet(key);
        if (raw !== null && raw !== SHARD_MARKER) return raw;

        // 分片数据：主 key 为占位标记（或兼容早期实现：主 key 无值但存在分片 meta）
        return this._readShards(key);
    }

    async _readShards(key) {
        const metaRaw = await this._rawGet(`${key}${SHARD_PREFIX}meta`);
        if (metaRaw === null) return null;
        let meta = null;
        try {
            meta = JSON.parse(metaRaw);
        } catch {
            return null;
        }
        if (!meta || typeof meta.count !== 'number') return null;

        let result = '';
        for (let i = 0; i < meta.count; i++) {
            const part = await this._rawGet(`${key}${SHARD_PREFIX}${i}`);
            if (part !== null) result += part;
        }
        return result;
    }

    /**
     * 写入值。超过分片阈值时自动分片存储。
     * @param {string} key
     * @param {string} value
     */
    async put(key, value) {
        const data = typeof value === 'string' ? value : String(value);
        // 先清理旧分片，避免残留
        await this._clearShards(key);

        const bytes = utf8ByteLength(data);
        if (bytes <= SHARD_LIMIT_BYTES) {
            await this._rawPut(key, data);
            return;
        }

        // 分片路径：主 key 写占位标记（保证 list 可枚举），数据写入分片 key
        await this._rawPut(key, SHARD_MARKER);
        const chunks = splitByBytes(data, SHARD_LIMIT_BYTES);
        for (let i = 0; i < chunks.length; i++) {
            await this._rawPut(`${key}${SHARD_PREFIX}${i}`, chunks[i]);
        }
        await this._rawPut(
            `${key}${SHARD_PREFIX}meta`,
            JSON.stringify({ count: chunks.length })
        );
    }

    /**
     * 删除 key（含其全部分片）。
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async delete(key) {
        await this._clearShards(key);
        await this._rawDelete(key);
        return true;
    }

    /**
     * 前缀枚举，返回 CF KV list 格式 { keys: [{ name }] }。
     * 内部映射为 EdgeKV 字典序区间 [prefix, prefix+\uffff)。
     * @param {{ prefix?: string }} options
     * @returns {Promise<{ keys: Array<{ name: string }> }>}
     */
    async list({ prefix = '' } = {}) {
        const endKey = prefix + '\uffff';
        const allKeys = [];
        let startKey = prefix;
        let guard = 0;

        while (guard++ < 1000) {
            let batch = [];
            try {
                const res = await this._kv.list({ startKey, endKey, limit: 1000 });
                batch = Array.isArray(res) ? res : [];
            } catch {
                break;
            }
            if (!batch.length) break;

            for (const k of batch) {
                if (typeof k !== 'string') continue;
                if (!k.startsWith(prefix)) continue;
                if (k.includes(SHARD_PREFIX)) continue;
                // startKey 为闭区间：除首次外跳过已处理过的 key（startKey 即上一批最后 key）
                if (startKey !== prefix && k <= startKey) continue;
                allKeys.push(k);
            }

            // EdgeKV list 无游标：以最后 key 作为下一轮 startKey（闭区间靠上面去重跳过）
            if (batch.length < 1000) break;
            startKey = batch[batch.length - 1];
        }

        return { keys: allKeys.map((name) => ({ name })) };
    }
}
