# MiSub · 阿里云 ESA 部署指南（README-ESA）

本文档介绍如何将 MiSub 部署到**阿里云 ESA（边缘安全加速，Edge Security Acceleration）**，采用「**函数 + Pages + EdgeKV**」的产品组合。ESA 版改造代码位于 `functions-esa/` 与 `scripts/build-esa.mjs`，主分支 Cloudflare 版本（`functions/`）不受影响，两者可并行维护。

> 适用版本：MiSub 2.7.0+（`package.json` 提供 `build:esa` 相关脚本）

---

## 目录

- [1. 架构总览](#1-架构总览)
- [2. 前置条件](#2-前置条件)
- [3. 本地构建步骤](#3-本地构建步骤)
- [4. ESA 控制台部署流程](#4-esa-控制台部署流程)
  - [4.1 创建 EdgeKV 命名空间](#41-创建-edgekv-命名空间)
  - [4.2 部署边缘函数](#42-部署边缘函数)
  - [4.3 部署静态前端（Pages）](#43-部署静态前端pages)
  - [4.4 配置路由](#44-配置路由)
  - [4.5 配置定时触发](#45-配置定时触发)
- [5. 环境变量说明表](#5-环境变量说明表)
- [6. 与 CF 版差异说明](#6-与-cf-版差异说明)
- [7. 常见问题与注意事项](#7-常见问题与注意事项)

---

## 1. 架构总览

MiSub ESA 版采用「静态分离 + 函数只处理动态逻辑」的架构，与 Cloudflare Pages Functions 一体化形态不同：

```
浏览器 ──► ESA Pages（静态前端 dist/，负责静态资源与 SPA 回退）
              └── 非静态路径按路由规则转交函数

外部定时器 ──► ESA 边缘函数（dist-esa/index.js，单文件 ESM，约 512KB）
                 ├── /cron?secret=xxx    定时同步触发（替代 CF Cron Triggers）
                 ├── /api/*              业务 API（订阅管理 / 设置 / 通知）
                 ├── /subscription/* 或自定义短链  订阅节点托管
                 └── EdgeKV（misub-kv）  数据存储（经 esa-storage-adapter 分片适配）
```

核心设计：

- **入口适配**：由 CF 版 `onRequest({ request, env, next })` 改为 ESA 的 `export default { async fetch(request, context) }`。
- **静态资源分离**：函数不再处理 `env.ASSETS` / `next()`，静态资源与 SPA fallback 全部交给 ESA Pages 托管。
- **存储适配**：`functions-esa/esa-storage-adapter.js` 实现 CF KV 兼容接口（`get` / `put` / `delete` / `list`），大 value 自动按 1.5MB 分片存储，业务代码零改动即可从 CF KV 迁移到 EdgeKV。
- **定时任务改造**：ESA 无原生 Cron，改为外部定时器调用 `/cron?secret=<CRON_SECRET>`（支持 `?secret=` 参数或 `Authorization: Bearer <secret>` 请求头鉴权）。

---

## 2. 前置条件

| 类别 | 要求 |
|------|------|
| 本地环境 | Node.js 18+（建议 20 LTS）、npm 9+，已 clone 本项目仓库 |
| 阿里云账号 | 已开通 ESA（边缘安全加速）产品，具备控制台访问权限 |
| 域名 | 已在 ESA 完成域名接入/解析（用于 Pages 站点与函数 URL） |
| EdgeKV | ESA 控制台可创建 EdgeKV 命名空间（见 4.1） |
| 定时服务 | 任意外部定时器（GitHub Actions / 阿里云云监控报警回调 / 第三方 cron 服务），用于定时触发 `/cron` |

---

## 3. 本地构建步骤

在项目根目录执行：

```bash
# 1. 安装依赖（首次）
npm install

# 2. 完整构建（推荐）：前端 dist/ + 函数 dist-esa/index.js
npm run build:esa

# 仅构建前端（用于 Pages 静态托管）
npm run build

# 仅打包边缘函数（dist-esa/index.js）
npm run build:esa:fn
```

构建产物与校验：

| 产物 | 路径 | 说明 |
|------|------|------|
| 静态前端 | `dist/` | Vite 构建产物，用于 ESA Pages 托管 |
| 边缘函数 | `dist-esa/index.js` | esbuild 打包的单文件 ESM，`export default { async fetch(request, context) }` |

校验要点：

- `dist-esa/index.js` 大小约 **512KB**，远低于 ESA 函数 **4MB** 体积上限。
- 可执行 `node --check dist-esa/index.js` 做语法校验。
- 本地联调可参考 `scripts/smoke-subscription.mjs` 进行订阅抓取冒烟验证。

---

## 4. ESA 控制台部署流程

### 4.1 创建 EdgeKV 命名空间

1. 登录 ESA 控制台，进入 **边缘函数 → EdgeKV**。
2. 点击**创建命名空间**，输入名称（示例：`misub-kv`），创建完成后记录命名空间名称。
3. 该名称将在函数环境变量 `EDGE_KV_NAMESPACE` 中引用（注意是命名空间**名称**，不是 ID）。

### 4.2 部署边缘函数

1. ESA 控制台 → **边缘函数 → 创建函数**。
2. 上传代码：选择本地构建产物 `dist-esa/index.js`。
3. 配置环境变量（见 [第 5 节](#5-环境变量说明表)），至少设置：
   - `EDGE_KV_NAMESPACE` = 4.1 中创建的命名空间名称（如 `misub-kv`）
   - `CRON_SECRET` = 随机长字符串（须与前端设置页「自动任务配置」中的 Cron Secret 一致）
4. 发布函数，记录函数 URL（形如 `https://<函数域名>/`）。

### 4.3 部署静态前端（Pages）

**方式 A：GitHub 集成（推荐）**

1. 在 ESA 控制台的 **Pages** 中为当前仓库开启 GitHub 集成。
2. 配置构建设置：构建命令 `npm run build`，产物目录 `dist`。
3. 配置 **SPA 回退规则**：404 → `/index.html`（保证前端路由刷新不白屏）。

**方式 B：手动上传**

1. 本地执行 `npm run build`。
2. 将 `dist/` 目录整体上传到 ESA Pages 站点。

### 4.4 配置路由

在 ESA 控制台 **路由 / 规则** 中，将前端域名与函数路由打通：

| 路径 | 目标 | 说明 |
|------|------|------|
| `/assets/*` 等静态资源 | Pages | 静态资源直连 CDN |
| `/api/*` | 边缘函数 | 业务 API |
| `/subscription/*`、`/sub/*`、自定义短链 | 边缘函数 | 订阅节点托管 |
| `/cron` | 边缘函数 | 定时同步触发端点 |
| 其余路径 | Pages（SPA fallback 至 `index.html`） | 前端页面 |

> 提示：也可采用「其余路径全部转函数」的粗粒度路由，但建议静态资源精确指向 Pages，以充分发挥 ESA 缓存加速能力。函数内部对非动态路由返回 `404`（伪装开启时对浏览器访问返回伪装页）。

### 4.5 配置定时触发

ESA 没有原生定时触发器，请使用任意外部定时器（GitHub Actions / 阿里云云监控报警回调 / 第三方 cron 服务）定时请求：

```
GET https://<函数域名>/cron?secret=<CRON_SECRET>
```

- 鉴权方式二选一：URL 参数 `?secret=<CRON_SECRET>`，或请求头 `Authorization: Bearer <CRON_SECRET>`。
- 推荐频率：**每小时一次**（与 CF 版 `hourly-subscription-sync` 一致）。
- 端点返回 JSON 执行结果，外部定时器可据此判断成功/失败，失败时可配置告警。

GitHub Actions 参考（`cron: '0 * * * *'` 每小时触发）：

```yaml
on:
  schedule:
    - cron: '0 * * * *'
jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS "https://<函数域名>/cron?secret=${{ secrets.CRON_SECRET }}"
```

---

## 5. 环境变量说明表

在 ESA 控制台「函数配置 → 环境变量」中配置；也可参考 `esa.jsonc`（复制为 `esa.private.jsonc` 填入真实值，勿提交到 Git）。

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `EDGE_KV_NAMESPACE` | 是 | `misub` | EdgeKV 命名空间**名称**（控制台创建，非 ID）。兼容别名：`EDGEKV_NAMESPACE`、`MISUB_KV_NAMESPACE`（按此顺序读取，取首个非空值） |
| `CRON_SECRET` | 是 | 无 | `/cron` 外部触发鉴权密钥，须与前端设置页「自动任务配置」的 Cron Secret 一致 |
| `MAX_SYNC_COUNT` | 否 | `50` | 单次定时同步的最大订阅数 |
| `SYNC_TIMEOUT` | 否 | `30000` | 单个订阅抓取超时（毫秒） |
| `MAX_CONCURRENCY` | 否 | `3` | 同步并发数。ESA 单次 fetch 子请求上限为 4，**请勿超过 3** |
| `CORS_ORIGINS` | 否 | 请求来源 | 允许跨域的前端来源，逗号分隔；未配置时默认仅放行请求自身来源 |
| `TELEGRAM_BOT_TOKEN` | 否 | 无 | Telegram 通知机器人 Token（对应前端设置页，可选） |
| `TELEGRAM_CHAT_ID` | 否 | 无 | Telegram 通知接收 Chat ID（对应前端设置页，可选） |

> 存储说明：EdgeKV 通过运行时的 `EdgeKV` 对象按命名空间创建，经 `esa-storage-adapter.js` 适配为 CF KV 兼容接口后注入业务侧 `MISUB_KV`，上层业务代码无需感知存储差异。若运行环境已直接注入具备 `get/put/delete` 接口的 `MISUB_KV`（如本地模拟 `kv.json`），则优先直接使用。

---

## 6. 与 CF 版差异说明

| 能力 | CF 版（Cloudflare Pages Functions） | ESA 版（阿里云 ESA） |
|------|--------------------------------------|----------------------|
| 函数入口 | `onRequest({ request, env, next })` | `export default { async fetch(request, context) }` |
| 静态托管 | `env.ASSETS` + `next()` | ESA Pages 规则（404 → `index.html`） |
| 数据存储 | CF KV / D1 | EdgeKV（经 `esa-storage-adapter` 分片适配） |
| 定时任务 | CF Cron Triggers（`CF-Cron` 头） | 外部定时器调用 `/cron?secret=<CRON_SECRET>` |
| 单次子请求数 | 无硬限制 | ≤ 4（同步并发默认 3，已预留余量） |
| 单函数体积上限 | 25MB（Worker） | 4MB（当前产物约 512KB，余量充足） |
| 路由形态 | 函数一体处理 | 函数只处理动态路由，静态资源归 Pages |

其余业务能力（订阅管理、API、设置、通知、伪装页等）两版一致。

---

## 7. 常见问题与注意事项

1. **EdgeKV 单 value 上限约 1.8MB**
   适配器按 1.5MB 分片存储，业务侧无感知；分片 key 以 `__esa_shard__` 为后缀，`list` 时会自动过滤，并在主 key 上保留占位标记保证可枚举。

2. **EdgeKV 无 TTL**
   不使用 KV TTL 特性；若依赖自动过期清理，需在同步流程中自行清理旧 key（CF 版若未使用 TTL 则无影响）。

3. **EdgeKV `list` 为字典序区间枚举**
   `list({ prefix })` 被映射为 `[prefix, prefix + '\uffff')` 区间，已兼容前缀语义，业务侧 `list` 用法不变。

4. **函数超时限制**
   ESA 函数单次执行 RT 上限 120s（网关 10s 首包）。大批量同步请保持 `MAX_CONCURRENCY ≤ 3`，必要时拆分为多次 `/cron` 触发（如按订阅数分批）。

5. **CRON_SECRET 必须与设置页一致**
   `/cron` 校验的是**设置页存储的 `cronSecret`**（而非仅环境变量）。部署后请到前端设置页「自动任务配置」确认 Cron Secret 已设置且与环境变量一致，否则 `/cron` 返回 500（未配置）或 401（不匹配）。

6. **路由必须配置 SPA 回退**
   未配置 404 → `index.html` 时，前端路由深链刷新会 404。函数不参与静态资源分发，此项必须依赖 Pages 规则完成。

7. **迁移已有数据（从 CF KV）**
   如需从 CF KV 迁移数据，可调用 ESA 版 API 的导出/导入接口（与 CF 版一致），或按 `esa-storage-adapter` 的分片格式直接写入 EdgeKV。

8. **`_schedule.js` 附带死代码**
   打包产物内含 `functions/_schedule.js` 的 `onRequest`（因 `api-router` 动态 import 其 `performSubscriptionSync`），该函数不会被 ESA 路由调用，无功能影响，可忽略。

9. **伪装（Disguise）功能说明**
   伪装开启时，函数对浏览器页面访问返回伪装页（尽力保留 Smart Disguise），非浏览器客户端（curl 等）不受影响。确认伪装前请先通过 `/api/login` 登录鉴权。

10. **构建前注意 `dist-esa` 清理**
    `scripts/build-esa.mjs` 每次构建会先清空并重建 `dist-esa/`，请勿在该目录存放自定义文件。
