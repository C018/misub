/**
 * MiSub 阿里云 ESA（边缘函数）主入口
 *
 * 部署形态：函数 + Pages。
 * - 本文件打包为单 JS（dist-esa/index.js），作为 ESA 边缘函数代码。
 * - 前端 Vite 构建产物（dist/）部署到 ESA Pages 静态托管，
 *   静态资源与 SPA fallback 由 Pages 平台承担，函数只处理动态路由。
 *
 * 运行时差异适配（相对 Cloudflare Pages Functions）：
 * 1. 入口签名：export default { async fetch(request, context) }
 *    替代 CF 的 onRequest({ request, env, next })。
 * 2. 存储：EdgeKV 通过 new EdgeKV({ namespace }) 创建，
 *    经 EsaKVNamespace 适配为 CF KV 兼容接口后注入 env.MISUB_KV，
 *    上层 StorageFactory / SettingsCache / KVStorageAdapter 零改动复用。
 * 3. 无 env.ASSETS / next()：本函数不处理静态资源与 SPA fallback，
 *    全部交给 Pages 平台（404 规则回退 index.html）。
 * 4. 无 CF-Cron 头：定时任务改为外部定时器触发 /cron?secret=xxx。
 * 5. context.waitUntil 若运行时不提供，则降级为后台执行（不阻塞响应）。
 */

import { handleMisubRequest } from '../functions/modules/subscription-handler.js';
import { handleApiRequest } from '../functions/modules/api-router.js';
import { createJsonResponse, migrateConfigSettings } from '../functions/modules/utils.js';
import {
    corsMiddleware,
    csrfOriginMiddleware,
    securityHeadersMiddleware,
} from '../functions/middleware/cors.js';
import { createDisguiseResponse } from '../functions/modules/disguise-page.js';
import { SettingsCache } from '../functions/storage-adapter.js';
import { DEFAULT_SETTINGS as defaultSettings } from '../functions/modules/config.js';
import { handleCronTrigger } from '../functions/modules/notifications.js';
import { authMiddleware, renewAuthSession } from '../functions/modules/auth-middleware.js';
import { EsaKVNamespace } from './esa-storage-adapter.js';

function parseCorsOrigins(env, requestUrl) {
    const configured = (env?.CORS_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    const origins = configured.length ? configured : [requestUrl.origin];
    if (['localhost', '127.0.0.1'].includes(requestUrl.hostname)) {
        origins.push('http://localhost:5173', 'http://127.0.0.1:5173');
    }
    return Array.from(new Set(origins));
}

/**
 * 构造 ESA 上下文中的 env：
 * 1. 保留平台注入的环境变量；
 * 2. 将 EdgeKV 适配为 CF KV 兼容对象并挂到 MISUB_KV；
 * 3. 若运行环境已直接提供 MISUB_KV（本地模拟/自定义绑定），优先使用。
 */
async function buildEsaEnv(contextEnv = {}) {
    const env = { ...contextEnv };

    if (
        env.MISUB_KV &&
        typeof env.MISUB_KV.get === 'function' &&
        typeof env.MISUB_KV.put === 'function' &&
        typeof env.MISUB_KV.delete === 'function'
    ) {
        return env; // 本地模拟（esa-cli kv.json）或平台绑定已注入
    }

    const namespace =
        env.EDGE_KV_NAMESPACE ||
        env.EDGEKV_NAMESPACE ||
        env.MISUB_KV_NAMESPACE ||
        'misub';
    if (typeof EdgeKV !== 'undefined') {
        const edgeKv = new EdgeKV({ namespace });
        env.MISUB_KV = new EsaKVNamespace(edgeKv);
    } else if (typeof env.EDGE_KV !== 'undefined') {
        env.MISUB_KV = new EsaKVNamespace(env.EDGE_KV);
    } else {
        console.warn('[ESA] EdgeKV not available, storage will be noop');
    }

    return env;
}

export default {
    /**
     * @param {Request} request
     * @param {Object} context - ESA 运行时上下文（可能含 env / waitUntil）
     */
    async fetch(request, context = {}) {
        const env = await buildEsaEnv(context.env || {});
        const url = new URL(request.url);

        // 统一补一个 waitUntil：运行时不提供时，后台任务不阻塞响应
        const esaContext = {
            ...context,
            request,
            env,
            waitUntil:
                typeof context.waitUntil === 'function'
                    ? context.waitUntil.bind(context)
                    : (promise) => {
                          Promise.resolve(promise).catch((err) =>
                              console.error('[ESA] background task failed:', err)
                          );
                      },
        };

        try {
            const handleRequest = async () => {
                const settings = (await SettingsCache.get(env)) || {};
                const config = migrateConfigSettings({ ...defaultSettings, ...settings });

                // 动态识别订阅路由：/sub/ 显式前缀 + 自定义 mytoken/profileToken 短链
                const isExplicitSubRoute = url.pathname.startsWith('/sub/');
                const firstSeg = url.pathname.split('/').filter(Boolean)[0];
                const isCustomTokenRoute =
                    firstSeg && (firstSeg === config.mytoken || firstSeg === config.profileToken);

                if (url.pathname.startsWith('/api/')) {
                    return await handleApiRequest(request, env, esaContext);
                }

                if (isExplicitSubRoute || isCustomTokenRoute) {
                    return await handleMisubRequest(esaContext);
                }

                if (url.pathname === '/cron') {
                    const expectedSecret = settings.cronSecret;
                    if (!expectedSecret) {
                        return createJsonResponse(
                            { error: 'Cron Secret 未配置', hint: '请在设置页面的「自动任务配置」中设置 Cron Secret' },
                            500
                        );
                    }
                    const cronAuthHeader = request.headers.get('Authorization');
                    const cronSecretParam = url.searchParams.get('secret');
                    const isAuthorized =
                        cronAuthHeader === `Bearer ${expectedSecret}` ||
                        cronSecretParam === expectedSecret;
                    if (!isAuthorized) {
                        return createJsonResponse({ error: 'Unauthorized' }, 401);
                    }
                    return await handleCronTrigger(env);
                }

                // 非动态路由：静态资源与 SPA fallback 由 Pages 平台托管。
                // 伪装开启时，对浏览器页面访问返回伪装页（尽力保留 Smart Disguise）。
                const userAgent = request.headers.get('User-Agent') || '';
                const isBrowser = /Mozilla|Chrome|Safari|Edge/i.test(userAgent) && !/curl|wget|python|node/i.test(userAgent);
                if (settings?.disguise?.enabled && isBrowser) {
                    const isAuthenticated = await authMiddleware(request, env);
                    if (!isAuthenticated) {
                        const disguiseResponse = createDisguiseResponse(settings.disguise, request.url);
                        if (disguiseResponse) return disguiseResponse;
                    }
                }

                return new Response('Not Found', { status: 404 });
            };

            const corsOptions = {
                origins: parseCorsOrigins(env, url),
                allowCredentials: true,
            };
            const response = await corsMiddleware(
                request,
                () =>
                    csrfOriginMiddleware(
                        request,
                        () => securityHeadersMiddleware(request, handleRequest),
                        corsOptions
                    ),
                corsOptions
            );

            const isAuthCookieManagementRoute =
                url.pathname === '/api/login' || url.pathname === '/api/logout';
            if (isAuthCookieManagementRoute || request.method === 'OPTIONS') {
                return response;
            }
            return await renewAuthSession(request, env, response);
        } catch (error) {
            console.error('[ESA Main Handler Error]', error);
            return createJsonResponse(
                { error: 'Internal Server Error', message: error.message },
                500
            );
        }
    },
};
