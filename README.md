# 地候 GeoScope · 阶段一

自用地理气象速览 PWA。**零构建**：纯 HTML + CSS + 原生 ES Module，不引入任何第三方依赖、不装 npm 包、不用打包器、不用 CDN、不外链字体。

本阶段交付：六路数据源接入层 + 此刻屏 + 数据源自检页（真机复验）+ PWA 离线壳。

> 「六路」是**阶段一**的口径，指自检页 `SOURCE_LIST` 那六路（天气 / 空气 / 地理编码 / 海拔 / 逆地理 / 瓦片）。后续阶段新增的自驾两路（路线规划 OSRM、地点候选高德）走 `SOURCE_TABLE`，不在本阶段的六路之内。

---

## 1. 本地运行

ES Module 必须经 http 协议加载，直接双击 `index.html`（`file://`）打不开，请先起本地静态服务：

```bash
node tools/serve.mjs                 # 默认 http://127.0.0.1:8080
node tools/serve.mjs --port 8123     # 换端口（推荐）
node tools/serve.mjs --port=8123     # 等价写法
PORT=8123 node tools/serve.mjs       # Windows 用 set PORT=8123 && node tools/serve.mjs
node tools/serve.mjs 8123            # 位置参数，旧写法仍支持
```

端口优先级：`--port` 参数 → `PORT` 环境变量 → 位置参数 → 默认 `8080`。
8080 常被别的程序占着，端口冲突时服务会打印中文提示，并直接给出下一条可复制的命令（含换用端口与环境变量两种解法），不会甩一堆英文堆栈。

浏览器打开（端口换成你实际用的那个，启动日志里会完整打印这两个地址）：

- 此刻屏 → http://127.0.0.1:8080/index.html
- 自检页 → http://127.0.0.1:8080/selfcheck.html
- 方位屏 → http://127.0.0.1:8080/compass.html（磁偏角 / 真磁方位换算，**本机计算，断网可用**）
- 我的 · 设置 → http://127.0.0.1:8080/settings.html（备份导出 / 导入 + 主题切换）

> Service Worker 只在 `http://127.0.0.1`、`http://localhost` 或 `https://` 下可用（安全上下文要求）。

### 命令一览

| 命令 | 作用 |
|---|---|
| `node tools/serve.mjs [--port N]` | 本地静态服务（只绑定 127.0.0.1，不对外暴露）；启动日志直接打印两个入口页的完整 URL |
| `node tools/smoke.mjs` | 无网冒烟：mock fetch 验证队列/超时/重试/缓存/降级/映射/日出日落/指纹去重 |
| `node tools/check.mjs` | 静态检查：语法、import 引用存在性、HTML 引用、外链红线、SW 清单一致性 |
| `node tools/contrast-audit.mjs` | **改完配色必跑**：数据驱动扫描 `app.css` 全部 `color:` 声明（59 条），按「屏渐变→容器填色→自身填色」实算 WCAG 对比度，有项 < 4.5:1 则退出码 1（当前 59/59 达标，退出码 0） |
| `node tools/build-standalone.mjs` | 重新生成单文件版 `selfcheck-standalone.html` |
| `node tools/verify-standalone.mjs` | 校验刚生成的单文件版可用（落盘后按真实结构 import 一遍） |
| `node --version` | 需 ≥ 18（用到 `AbortController`、`crypto.subtle`、原生 fetch） |

### ⚠ 改完样式或源码，必须重新生成单文件版

`selfcheck-standalone.html` 是**生成产物**（不是手写源文件）：它把 `styles/tokens.css`、`styles/app.css` 与 15 个 ES Module 的源码全部内联进一个 HTML，用来发到手机上直接跑自检。

**任何改动 `styles/*.css` 或 `src/**/*.js` 之后，都必须补这两步：**

```bash
node tools/build-standalone.mjs      # 重新生成
node tools/verify-standalone.mjs     # 校验可用
```

为什么必须：它内联的是**源码快照**，不跟随源码自动更新。一旦忘记重新生成，手机上跑的仍是旧代码 —— 现象与仓库对不上，排查时会往错误方向找（瓦片三态、降级横幅、配色这些刚改过的东西全都可能缺）。曾实际发生过落后两轮的情况（连 `banner--grid` 都没有）。

> 判断是否需要重新生成的最快办法：`grep -c "banner--grid" selfcheck-standalone.html`，为 0 就是过期了。

`package.json` 只用于让 Node 以 ESM 方式加载浏览器 `.js` 模块（`"type": "module"`），
**不含任何依赖，不需要、也不要执行 `npm install`**。

---

## 2. 部署（Cloudflare Pages · 免备案）

自用、不上架、不商业化，托管在境外即可免备案。以 Cloudflare Pages 为例：

1. 把仓库推到 GitHub（或直接用 `wrangler pages deploy`）；
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**；
3. 构建配置留空：
   - **Framework preset**：`None`
   - **Build command**：留空（零构建，没有产物）
   - **Build output directory**：`/`（仓库根目录）
   - **Root path**：留空
4. 保存并部署，拿到 `https://<project>.pages.dev` 即可手机访问。
5. **发布前必须先跑一次** `node tools/bump-shell.mjs`（把 `sw.js` 里的 `geoscope-shell-vN` 版本号 +1）。
   为什么：浏览器判定 Service Worker 要不要更新，看的是 **sw.js 自身的字节变化**，不看业务文件。
   只改 `styles/app.css`、`src/ui/app.js` 这类业务文件的提交一个字节都没动 sw.js，
   浏览器判定「没变」→ 不安装新版 → 已安装的真机继续从旧壳缓存拿旧文件。
   版本号 +1 才能让 sw.js 必然变化、更新必然触发。忘跑的表现是「明明改了，手机上纹丝不动」。

其它等价选项（同样免备案）：GitHub Pages、Vercel、Netlify —— 都按「静态站点、无构建步骤、根目录直接发布」配置即可。

**必须保留**：`sw.js` 与 `manifest.webmanifest` 要能被以同源路径访问（不能放到 CDN 上），否则 Service Worker 注册失败。

---

## 3. 数据源契约（实测定稿，不得改 URL）

| id | 能力 | URL / 关键参数 | 超时 | 重试 | 缓存 TTL |
|---|---|---|---|---|---|
| `weather` | 天气 | `https://api.open-meteo.com/v1/forecast`<br>`current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,visibility`<br>`daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum`<br>`hourly=temperature_2m,precipitation_probability,weather_code`<br>`timezone=auto&forecast_days=7` | 6000 ms | 1 | 600000 ms |
| `air` | 空气质量 | `https://air-quality-api.open-meteo.com/v1/air-quality`<br>`current=european_aqi,pm10,pm2_5,ozone,nitrogen_dioxide` · `timezone=auto` | 6000 ms | 1 | 600000 ms |
| `geocode` | 地名搜索 | `https://geocoding-api.open-meteo.com/v1/search?name=<kw>&count=10&language=zh&format=json` | 6000 ms | 1 | 86400000 ms |
| `elevation` | 海拔 | `https://api.open-meteo.com/v1/elevation?latitude=&longitude=` | 6000 ms | 1 | 604800000 ms |
| `reverse` | 逆地理反查 | `https://photon.komoot.io/reverse?lat=&lon=&lang=default` | 6000 ms | 1 | 604800000 ms（键用坐标 `toFixed(4)`） |
| `tile` | 底图瓦片 | `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}`<br>另两种：`World_Imagery`、`Canvas/World_Dark_Gray_Base`（暗色路径层级不同） | 6000 ms | **0** | 不缓存 |

**已被实测剔除、禁止再引用**：`nominatim.openstreetmap.org`（整类不可达）、`basemaps.cartocdn.com`（假成功源：200 但多瓦片指纹全同）、`tile.openstreetmap.org`（真机 0/10）、`overpass`（沙箱四源全灭，本阶段不实现 POI）。

### 运行规则

- **全局并发 1**：所有 fetch 必经 `src/core/http.js` 的 `request()`，走一条串行队列；
- **离线短路**：`navigator.onLine === false` 时不发请求（`opts.force` 仅自检页使用）；
- **缓存三态** `fresh / stale / miss`：有 stale 就显示陈旧数据并标注陈旧时长，**绝不显示空白**；
- **瓦片失败一次即切「无地图纯坐标模式」**，不重试、不转圈；
- **首屏顺序**：串行 `weather → air → elevation` 先渲染（逐卡增量上屏），`reverse` 与瓦片探测在首屏完成后后台补齐。

---

## 4. 目录结构

```
index.html                 此刻屏
selfcheck.html             数据源自检 / 真机复验页
compass.html               方位屏（磁偏角 WMM2025 + 罗盘，本机计算不联网）
settings.html              「我的」设置页（备份导出 / 备份导入 / 主题切换）
manifest.webmanifest       PWA 清单（图标为内联 SVG data URI，不外链）
sw.js                      Service Worker：只预缓存静态壳，不缓存任何 API 响应
styles/tokens.css          设计令牌（--c-* / --sp-* / --fs-* / --r-* / --sh-*）
styles/app.css             全局与组件样式（深浅双主题、玻璃卡、胶囊 Tab、徽标、横幅）
src/i18n/zh.js             全部界面文案 + t(key, params)
src/core/http.js           超时中断 + 重试 + 全局串行队列 + 统一 SourceResult
src/core/cache.js          localStorage 缓存 + TTL + 三态 + LRU 淘汰
src/core/store.js          本机状态（默认地点 / 单位 / 最近快照 / debug / 网络类型）
src/core/geo.js            定位封装 + WGS84 + round4 + GCJ-02 占位
src/core/sun.js            NOAA 日出日落本地算法（纯函数、离线可用，仅兜底）
src/core/format.js         数字 / 单位 / 坐标 / 时延 / 相对时间格式化
src/core/wmo.js            WMO 天气码 + 欧洲 AQI 六档 + UV 五档 + 16 方位 + 蒲福风级
src/core/mag.js            地磁球谐综合（通用算法，不含任何具体模型系数）+ 真/磁方位换算
src/data/sources.js        源注册表（唯一真相源）
src/data/openmeteo.js      forecast / air-quality / geocoding / elevation 适配器
src/data/photon.js         Photon 逆地理反查适配器
src/data/tiles.js          Esri 三样式 URL / 探测 / 指纹 / 去重判定 / 无地图开关
src/data/health.js         源健康记录 + 整体降级态
src/data/wmm2025.js        WMM2025 系数表（G/H/DG/DH）+ 模型装配（换版本只换这一个文件）
src/ui/now.js              此刻屏渲染 + 降级态横幅
src/ui/selfcheck.js        自检页渲染 + 导出 JSON + 网络类型手动选择
src/ui/compass.js          方位屏渲染 + 入口装配（磁偏角 / 模型卡 / 换算 / 罗盘降级）
src/ui/map.js              底图渲染（瓦片拼接 / 样式切换 / 缩放 / 落点 / GRID 降级 / 署名）
src/ui/app.js              此刻屏入口装配
src/ui/settings.js         「我的」设置页：导出 / 导入（先预览后写入）/ 主题三档
src/ui/download.js         本地下载（Blob + <a download>，含延后释放 objectURL 的坑）
tools/serve.mjs            本地静态服务
tools/smoke.mjs            无网冒烟脚本
tools/check.mjs            语法 + 引用 + 红线静态检查
docs/stage1-architecture.md 架构与接口契约
```

依赖方向严格单向：`core`（无业务）← `data`（源适配器）← `ui`（渲染）← `html`（装配）。
`core` 不 import `data`；`data` 不 import `ui`。

---

## 5. 设计系统

- 品牌「晨曦青」`#1E9C8C`（亮）/ `#2BB6A3`（暗）；温度高 `#E08A3C`；温度低 `#4A93B8`；告警红 `#C9584B`；
- 深色屏渐变 `#0A0F17 → #0F262E`（默认），浅色屏渐变 `#F7FAFA → #E3EFF2`；
- 字体：**只用 CSS font-family 声明，不外链字体文件** —— 中文 `Noto Sans SC`，数字/拉丁 `Geist`，等宽（经纬度/时延/磁参数）`Geist Mono`，缺失时回退系统栈；
- 8pt 栅格；卡片圆角 18–20；胶囊 36；触达最小 44×44；
- 深色玻璃卡 = 白 7% 填充 + 白 10% 描边；浅色卡 = 白底 + `#0F181D` 9% 描边；
- 手机 390 宽为基准，底部自绘玻璃胶囊 Tab（选中实心青）。

---

## 6. 自检页怎么用

1. 顶部手动点选**网络类型**（WiFi / 蜂窝 / 未知，默认未知）—— 浏览器不暴露真实网络类型，只能手动标记；报告里会自动附带 `effectiveType` 与 `downlink` 作为参考；
2. 选**取样次数** 1 / 3 / 5（默认 3），先发 1 次预热（不计入统计）；
3. 点「开始自检」：五路 API 源逐条串行取样（状态 / 时延 / HTTP 状态 / 错误码 / 请求 URL 实时上屏），随后瓦片 3 样式 × 3 位置取指纹；
4. 瓦片去重判定：先按样式各自判（指纹各异 → `real`，指纹全同 → `fake`），再取三种底图的共识作为整轮结论；整轮判 `fake` 时整轮结论强制降为「部分不可用」；
5. 底部「导出 JSON」→ `geoscope-selfcheck-<YYYYMMDD-HHmm>.json`。

报告字段：`app`、`version`、`generatedAt`、`networkType`、`effectiveType`、`downlink`、`online`、`samples`、`warmup:true`、`userAgent`、`results[]`、`tiles[]`、`tileDedupe`、`mapMode`、`verdict`。

### 瓦片缓存与底图三态（2026-10-11 真机实测后新增）

- **缓存**：瓦片按 URL 缓存在**内存**里（LRU 96 条 / TTL 7 天），不落 localStorage（瓦片平均 20 KB，持久化会撑爆配额）。真机实测瓦片中位 693 ms、峰值 3198 ms（占 6 s 超时的 53%），而同一 z/x/y 的字节与指纹跨四轮完全一致 —— 内容确定不变，缓存不会拿到脏数据。
- **授信门槛**：**只有自检页判该样式为 `real`（真瓦片）之后才允许写缓存**。单块瓦片的指纹无法自证真假（占位图同样有指纹），必须「同一样式 + 多个位置」比对通过才授信；判 `fake` 会立刻撤销授信并清空该样式的缓存。自检页因此既是「体检」也是「授信」入口。
- **授信持久化 30 天**：授信结论存在 `gs:v1:tile-trust:<styleId>`（`{trusted, at}`），有效期 30 天，过期回到未授信（底图源会换、CDN 会切，不能永久信任一次实测）。localStorage 不可用时静默降级为纯内存，不影响瓦片请求本身。**默认仍是不授信** —— 不假设，只信实测。
- **三态降级**：`map`（底图可用）/ `grid`（部分瓦片失败 → 仅网格 + 坐标，**先不宣布无地图**）/ `no-map`（整批全败 → 纯坐标）。单块成败不再决定全局：3 块里坏 1~2 块不代表底图全废。
  - 主页面后台探 **3 块**（`TILE_PROBE_COUNT`）——只探一块时「部分成功」的判定区间是空集，grid 永远不可达，等于没改。
  - `grid` 时健康层仍给 `partial`（`overallMode()` 的返回值不动，自检页等其它消费者照旧），但**横幅这一层单独分支**，显示如实的 `mode.grid`：「部分瓦片未取到 · 已降为网格」，并挂 `.banner--grid`（琥珀）。不会说成「部分数据源不可用」——那句在 grid 场景下是假话，五个 API 明明都好，用户读完会以为天气数据也坏了。
  - 若同时有更严重的一档（`offline` / `empty` / `stale`），`grid` 让位：底图少几块瓦片不该盖掉「离线」或「数据陈旧」。
- 自检页取样时强制 `useCache: false` —— 否则测的是缓存而不是链路质量，那一轮数据就白测了。

### 真机复验怎么读（三个「判定」分别回答什么问题）

| 字段 | 含义 | 取值 |
|---|---|---|
| `verdict` | **这一轮能不能放心用**（连通性 + 非占位图） | `all-ok` / `partial` / `offline` |
| `tileDedupe.verdict` | **瓦片是不是占位图**（各样式结论的共识） | `real` / `fake` / `unknown` |
| `tileDedupe.byStyle[style].verdict` | **单样式内 3 个不同位置的判定**（识破占位图的主证据） | `real` / `fake` / `unknown` |

- `verdict` 是三个条件的合取：五路 API 全通 **且** 九块瓦片都拿到字节 **且** 整轮去重判定不是 `fake`。所以 `all-ok` 已经排除「200 但占位图」的假成功源；反过来说，**只要整轮去重判 `fake`，`verdict` 一律降到 `partial`**。
- `tileDedupe.verdict` **不是**把 9 块瓦片混在一起比指纹：不同样式本来就是不同底图，跨样式全相异证明不了「这是真瓦片」，取样位置重合时还会把 unique 人为压低。真正有效的证据是**同一样式内三个远离位置**的指纹关系，因此整轮结论取各样式共识：全部 `fake` → `fake`；全部 `real` → `real`；有 `unknown` 或结论打架 → `unknown`（保守）。`tileDedupe.unique/total` 仍保留 9 块的原始统计，仅供人工核对，不参与判定。
- 真机复验时以 **`byStyle` 为准**：只要有一个样式是 `fake`，就该换底图源（此时 `tileDedupe.verdict` 会是 `unknown` 而非 `fake`，`verdict` 仍是 `all-ok`，所以别只看最后一行）。
- 单样式判定规则：参与样本 ≥ 3 时，指纹全各异 → `real`；指纹全同 → `fake`；否则（样本不足或结论不明确）→ `unknown`。
- 指纹算法：SHA-256 前 16 位 hex（界面与导出统一称「指纹 fp」，`fpAlgo` 字段标明算法；非安全上下文下降级为 `size-head`）。

### SourceResult 的 `stale` 字段

`ok === false` 时 `data` **可能是陈旧兜底值**（上游失败但本机有旧缓存，遵循「绝不显示空白」）。
因此结果里额外给了显式的 `stale: boolean`（等价于 `meta.cacheState === 'stale'`）：

- 判断「这份 data 能不能当成功数据用」→ 看 `ok`；
- 判断「这份 data 是不是旧数据」→ 看 `stale`，不要靠 `data` 是否非空来猜。

---

## 7. 隐私与边界（红线）

- 无广告、无第三方统计、无账号登录、无后端；
- 除数据源之外**不发任何请求**（无字体/图标/统计外链，可用 `node tools/check.mjs` 复核）。现有八路 = 六路环境数据源（`src/data/sources.js` 的 `SOURCE_LIST`）+ 两路自驾源（`src/data/roadsources.js` 的 `ROAD_SOURCES`，合并后为 `SOURCE_TABLE` 八路）。**八路都要本人自备/公开免 key，没有一路是自建代理**；
- 绝不把用户坐标上传到数据源以外的地方；坐标只存本机 `localStorage`；
- 产品边界三条（见页面底部「关于与边界」）：不商业化 / 不做端到端加密同步（搬家靠导出 JSON）/ 预警不采购数据源（本阶段不实现预警）。

---

## 8. 阶段二 / 三扩展点（本阶段不实现，已留位）

| 能力 | 预留位置 |
|---|---|
| POI（Overpass） | `src/data/overpass.js`；`sources.js` 注册表追加条目即可 |
| 多地点对比 | `src/ui/compare.js`；`store.favorites` 已有 schema |
| 图表交互（24h 温度 / 降水概率） | `hourlyTempC` / `hourlyPopPct` 已在 `WeatherNow` 中输出 |
| 分享海报 | `src/core/share.js` |
| 导出 CSV | ✅**已落地**：`src/core/csv.js`（RFC 4180 转义 + UTF-8 BOM + CRLF），入口在「我的」页 |
| 英文包 | `src/i18n/en.js`（与 `zh.js` 同构 key）；本阶段不建文件，已定稿的一条先记在这里：`mode.grid` = "Some tiles failed · grid only" |
| 磁偏角 WMM2025 | ✅**已落地**：`src/core/mag.js`（通用球谐算法）+ `src/data/wmm2025.js`（该版本系数）；UI 见 `compass.html` + `src/ui/compass.js` |
| 罗盘（指针） | ✅**已落地**（传感器可用时）：`src/ui/compass.js` 的 `renderCompassCard()`；无传感器降级为「仅显示计算值与手动换算」 |
| 二十四山 | `src/core/compass.js`（未开工，方位屏未做此层） |
| 无障碍字号三档 | ✅**已落地**：`styles/tokens.css` 的 `--fs-scale` 乘数 + `<html data-fs>`；见下方 §8.1 |
| Pad 横屏 | ✅**已落地**：`styles/app.css` 末尾 `@media (min-width: 768px)` 块 |

「降级态」枚举已预留 `no-poi` 语义位置（当前由 `no-map` 分支承载）。

### 8.1 无障碍字号三档（怎么放大、为什么这么放）

三档：**默认 / 大（1.15×）/ 特大（1.30×）**，在「我的」页切换，档位存 `store.fontScale`。

★要点（改这里之前必须知道）：**不能靠改 `html { font-size }` 来放大**。全站零 rem，
`app.css` 的 72 处 `font-size` 里 69 处是 `var(--fs-*)`、全是裸 px，改根字号对它们
一个都不生效。所以做法是给八个 `--fs-*` 各挂一个乘数：

```css
--fs-scale: 1;                              /* 默认档；放大档由 data-fs 覆盖 */
--fs-hero-scale: 1;                         /* 英雄温度单独一个、更小的乘数 */
--fs-md: calc(14px * var(--fs-scale));
--fs-hero: calc(56px * var(--fs-hero-scale));
```

两条硬约束：

1. **默认档的计算值必须与此前一模一样**（一个像素都不许变）—— 由 `tools/check.mjs`
   第 13 节与 `tests/fontscale.test.mjs` 各用一套独立解析器逐值钉死；
2. **英雄区（那个大号温度）放得比正文慢**（xlarge 下 56px → 64.4px，不是 72.8px）——
   它本来就是正文的 4 倍，按全档放大会把 320px 窄屏的右侧描述列挤没了。

防跳档：ES module 是 defer 的，等模块跑起来再写 `data-fs`，浏览器可能已经按默认字号
画过一帧。所以四个 HTML 的 `<head>` 里各有一段同步内联脚本，读本机偏好先把属性设上；
读不到就什么都不做（模块顶层还会再应用一次）。

### 8.2 导出 CSV（列从哪来）

导的是 `store` 里的**最近一次快照**（此刻屏首屏三源取完才写入，所以必然是完整的一份），
一行 = 一个时刻，32 列，UTF-8 带 BOM（中文版 Excel 直接打开不乱码）。

两条口径：

1. **每一列都必须能在界面上找到出处** —— 界面上没有的量（例如已取回但尚未上屏的逐小时
   降水概率）一律不进表；磁偏角是唯一「跨页」的列，它来自方位屏那一屏；
2. **缺失留空，不填 0、也不写「—」** —— 界面上缺失显示占位符「—」，但 CSV 里写「—」
   会让 Excel 把整列判成文本列，数字列就废了；
3. **两个时间列各按各的时区，表头里就写明** —— `导出时间（本机）` 跟**文件名**同源
   （都是设备本地墙钟），`观测时刻（当地）` 按被查询地点的时区偏移换算。查异地时这两列
   本来就不一样（在东八区导出一份伦敦的数据，文件名是本地 14:23、观测时刻是当地 06:23）。
   踩过的坑：第一版 `导出时间` 按 UTC 写，于是同一份文件出现「文件名 1405、表里 06:05」，
   现在由 `tests/csv.test.mjs` 里两条同源断言守住。

`tools/check.mjs` 第 13 节与 `tests/csv.test.mjs` 覆盖转义（逗号 / 双引号 / 换行）、BOM、
CRLF 行尾、空数据（只输出表头）与公式注入（以 `=` `+` `@` 开头的单元格前置单引号；
负数**不**加，否则所有气温都会变成文本）。

---

## 9. 待办 / 已知限制

1. GCJ-02 纠偏为空实现（阶段二），本阶段界面坐标即数据源返回的 WGS84 原值；
2. 定位被拒 / 超时固定回落到北京天安门 `39.9087,116.3975`，尚未做「设置里改默认地点」的界面；
3. 瓦片只做可用性探测，本阶段不在界面上渲染真实地图（阶段二接底图）；
4. `geocode` 已有适配器但此刻屏尚未提供搜索框（阶段二接多地点/搜索）；
5. 自检页在离线状态下不会发起请求，直接给出 `verdict:'offline'`；
6. `sun.js` 的 `zenith` 用 `||` 取默认值，显式传 `0` 会被当成「未提供」而回落 90.833 —— QA 已把该行为固化为回归断言，等用例同步后再改成 `??`（其余入参均已放宽：`dateUTC` 支持 ms epoch / Date / ISO 字符串）。
