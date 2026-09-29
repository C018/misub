# MiSub 阿里云 ESA 部署指南

本文档描述如何将 MiSub（Cloudflare Pages Functions 版）部署到阿里云 ESA（边缘安全加速，Edge Security Acceleration）的「函数 + Pages」产品线。改造代码位于 `functions-esa/` 与 `scripts/build-esa.mjs`，主分支 CF 版本不受影响。

## 架构总览

```
浏览器 ──► ESA Pages（静态前端 dist/）
              └── SPA fallback 交给 Pages 规则
              
外部定时器 ──► ESA 函数（dist-esa/index.js，单文件，≈512KB）
                 ├── /cron?secret=xxx  定时同步触发（替代 CF Cron）
                 ├── /api/*            业务 API（订阅管理/设置/通知）
                 └── /subscription/*   订阅节点托管
                 └── EdgeKV（misub-kv）  数据存储（经 esa-storage-adapter 分片适配）
```

核心改动：
- 入口由 `onRequest({ request, env, next })` 改为 ESA 的 `export default { async fetch(request, context) }`
- 静态资源与 SPA fallback 不再由函数处理（移除 `env.ASSETS` / `next()`），改由 ESA Pages 托管
- 存储由 CF KV/D1 切换为 EdgeKV：`functions-esa/esa-storage-adapter.js` 实现 CF KV 兼容接口（get/put/delete/list），大 value 自动按 1.5MB 分片，业务代码零改动
- 定时任务由 CF Cron Triggers 改为外部定时器调用 `/cron?secret=xxx`（secret 鉴权）

## 目录结构

```
misub/
├── functions/                  # CF 版（主分支，保持不变）
├── functions-esa/
│   ├── index.js                # ESA 函数入口（export default fetch）
│   └── esa-storage-adapter.js  # EdgeKV 适配器（分片存储 + 前缀 list）
├── scripts/
│   └── build-esa.mjs           # esbuild 打包脚本（单文件 ESM）
├── dist-esa/
│   └── index.js                # 打包产物（≈512KB，限制 4MB）
├── esa.jsonc                   # 环境变量配置示例
└── docs/esa-deployment.md      # 本文档
```

## 本地构建

```bash
# 仅打包函数
npm run build:esa:fn

# 完整构建（前端 dist + 函数 dist-esa/index.js）
npm run build:esa
```

产物校验：
- `dist-esa/index.js` 单文件 ESM，`export default { async fetch(request, context) }`
- 大小应远低于 4MB（当前约 512KB）
- 可本地用 `node --check` 做语法校验

## ESA 控制台部署

### 1. 创建 EdgeKV 命名空间

ESA 控制台 → 边缘函数 → EdgeKV → 创建命名空间，名称记为 `MISUB_KV_NAMESPACE`（示例 `misub-kv`）。

### 2. 部署函数

ESA 控制台 → 边缘函数 → 创建函数：
- 上传 `dist-esa/index.js`
- 配置环境变量（见 `esa.jsonc`）：
  - `MISUB_KV_NAMESPACE` = EdgeKV 命名空间名称
  - `CRON_SECRET` = 随机长字符串（与前端设置页一致）
  - 可选：`MAX_SYNC_COUNT` / `SYNC_TIMEOUT` / `MAX_CONCURRENCY`（默认 50/30000/3）
- 发布后记录函数 URL（形如 `https://<函数域名>/`）

### 3. 部署静态前端

方式 A（GitHub 集成，推荐）：仓库开启 ESA 的「Pages」GitHub 集成，构建命令 `npm run build`，产物目录 `dist`，并配置 SPA 回退规则（404 → `/index.html`）。

方式 B（手动上传）：本地 `npm run build` 后，将 `dist/` 目录整体上传到 ESA Pages。

### 4. 配置路由

ESA 控制台 → 路由/规则，将前端域名与函数路由打通：
- 静态资源（`/assets/*` 等）→ Pages
- 其余路径 → 函数（或按需精确路由 `/api/*`、`/subscription/*`、`/cron`）

### 5. 配置定时触发

ESA 无原生定时触发，使用任意外部定时器（阿里云云监控报警回调 / GitHub Actions / 第三方 cron 服务）定时请求：

```
GET https://<函数域名>/cron?secret=<CRON_SECRET>
```

推荐频率：每小时一次（与 CF 版 `hourly-subscription-sync` 一致）。端点返回 JSON 执行结果，外部定时器可据此判断成功/失败。

## 环境变量对照

| 变量 | CF 版 | ESA 版 | 说明 |
|------|-------|--------|------|
| 存储 | `MISUB_KV` (KV namespace) | `MISUB_KV_NAMESPACE` | EdgeKV 命名空间名称 |
| 定时密钥 | 设置页 `cronSecret` | `CRON_SECRET`（+ 设置页） | /cron 外部触发鉴权 |
| 同步参数 | 设置页配置 | `MAX_SYNC_COUNT` / `SYNC_TIMEOUT` / `MAX_CONCURRENCY` | 可选覆盖 |

## 与 CF 版的差异

| 能力 | CF 版 | ESA 版 |
|------|-------|--------|
| 入口 | `onRequest(context)` | `export default { async fetch(request, context) }` |
| 静态托管 | `env.ASSETS` + `next()` | ESA Pages 规则 |
| 存储 | CF KV / D1 | EdgeKV（分片适配） |
| 定时 | CF Cron Triggers（`CF-Cron` 头） | 外部定时器 `/cron?secret=` |
| 单次子请求 | 无硬限制 | ≤4（同步并发默认 3，已预留） |
| 单函数体积 | 25MB（Worker） | 4MB（当前 512KB，余量充足） |

## 已知边界与注意事项

1. **EdgeKV 单 value ≤1.8MB**：适配器按 1.5MB 分片存储，业务侧无感知；分片 key 以 `__esa_shard__` 为后缀，`list` 时会自动过滤并在主 key 上保留占位标记保证可枚举。
2. **EdgeKV 无 TTL**：不使用 KV TTL 特性；若依赖自动过期清理，需在同步流程中自行清理旧 key（CF 版若未使用 TTL 则无影响）。
3. **EdgeKV `list` 为字典序区间枚举**：`list({ prefix })` 被映射为 `[prefix, prefix+\uffff)` 区间，已兼容前缀语义。
4. **函数超时**：ESA 函数单次执行 RT 上限 120s（网关 10s 首包）。大批量同步请保持 `MAX_CONCURRENCY ≤ 3`，必要时拆分为多次 /cron 触发。
5. **迁移数据**：如需从 CF KV 迁移已有数据，可调用 ESA 版 API 的导出/导入接口（与 CF 版一致），或使用 `esa-storage-adapter` 的分片格式写入 EdgeKV。
6. **`_schedule.js` 附带死代码**：打包产物内含 `functions/_schedule.js` 的 `onRequest`（因 `api-router` 动态 import 其 `performSubscriptionSync`），该函数不会被 ESA 路由调用，无功能影响。
