# 夹具说明

本目录放**真实响应**，不是手工编的、不是 mock。两个使用方：

- `tests/roadtrip-plan.test.mjs` → 下面那三份 OSRM 路线；
- `tests/climate.test.mjs` → `climate-bj-1991-2020.json`（ERA5 气候常态）。

---

# OSRM 路线夹具（`tests/roadtrip-plan.test.mjs` 用）

这里的三个 `.json` 是**真实 OSRM 响应**，不是手工编的、不是 mock。

- 请求地址：公共实例 `https://router.project-osrm.org`（`overview=full&geometries=geojson&annotations=true&steps=false`）。
- 落地方式：原样喂给 `src/data/osrm.js::parseRoute()`，把**真实解析器的产出**序列化成文件。
  因此夹具的形状与线上路线的形状是同一份代码产出的，不是「照着结构手写一遍」。
- 每份文件里都留了 `_meta`（`source` / `note` / `producedBy` / `rawBytes`），
  **出处随夹具一起入库** —— 换个人、换个时间也能照着 `_meta.source` 重跑一遍对账。

| 文件 | 路线 | 点数 | legs | 原始响应 | 存储 |
|---|---|---|---|---|---|
| `osrm-cd-xian.json` | 成都 → 西安 | 5940 | 1 | 359.5 KB | 347.7 KB |
| `osrm-cd-hanzhong-xian.json` | 成都 → 汉中 → 西安（含一个真实必经点） | 6122 | 2 | 371.1 KB | 359.7 KB |
| `osrm-xian-luoyang.json` | 西安 → 洛阳（总时长刚过 4 h，收尾规则样本） | 2678 | 1 | 162.4 KB | 158.1 KB |

合计 **约 848 KB**。

## ★为什么这 848 KB 不许瘦身

体积的两个来源都是**被测对象本身**：

1. 三条 `overview=full` 的真实几何（5940 / 6122 / 2678 个点）；
2. 两条与几何**等长**的累积数组（`cumulativeS` / `cumulativeM`，各点数个浮点）。

「按天切段」测的正是「在累积曲线上跨过 4 h 门槛的那一个点是哪一个」——
**降坐标精度会挪动点、降时长精度会挪动门槛**，锚点下标随之一变，夹具就不知不觉
从「真响应」变成「看起来像真响应的东西」。那正是本仓最忌的一类 bug：数字还是那
个数量级，但已经不再证明任何事。

所以：

- **不许**为了减少体积去截断坐标小数位或时长小数位；
- **不许**把 `overview=full` 换成 `simplified`（简化几何只有 19–31 个点，累积曲线
  会退化成几段，切段锚点随之完全不同）；
- 真要变小，唯一正当的做法是**换一条更短的路线**，并同步更新 `_meta.source`
  与 `docs/roadtrip-architecture.md` §4.4.1 那张表里的数值 —— 那张表的锚点已被
  `tests/roadtrip-plan.test.mjs` 的 ⑥b 用机器钉在这几份夹具上，改夹具就会红。

## 什么时候该重新采集

OSRM 公共实例的路网与自由流时长会变。若将来 §4.4.1 表格里的锚点与实际输出对不上，
**先怀疑路网更新**（重跑 `_meta.source` 拿新响应），而不是去放宽断言。

---

# 气候常态夹具（`tests/climate.test.mjs` 用）

| 文件 | 地点 | 天数 | 原始响应 | 存储 |
|---|---|---|---|---|
| `climate-bj-1991-2020.json` | 北京 39.9087,116.3975 | 10958（1991-01-01 ~ 2020-12-31） | 303294 B | 272085 B |

- 采集：2026-10-16 沙箱直连 `curl -s --noproxy '*'`（本机 HTTP_PROXY 会拦回环地址），
  请求串写在文件内 `_meta.source` 里，换个人、换个时间都能照着它重抓一遍对账。
- 内容：**archive-api.open-meteo.com 的 ERA5 逐日再分析**原样入库，数值一个字节未改，
  只追加了 `_meta`（`source` / `note` / `producedBy` / `rawBytes` / `whyKeptWhole`）。
- 它是 `parseClimate()` 的**输入**，不是产出（不像 OSRM 那三份是解析器的产出）。

## ★为什么同样不许瘦身

被测的就是「把 10958 天逐日序列按日历月聚合」：裁掉任何一天，月平均就不是那个数，
断言也就不再证明任何事 —— 与上面 OSRM 那三份同一条理由。

## ★★ 300 KB 只躺在测试夹具里

运行时**绝不**落盘这 30 年逐日数组：缓存里存的只有聚合结果（几百字节，TTL 30 天），
见 `src/data/climate.js` 文件头。「夹具大」不等于「运行时可以缓存原始数组」。

## 什么时候该重新采集

ERA5 归档会随上游更新（例如再分析版本升级、缺测被补上）。若 `tests/climate.test.mjs`
里那张 12 行期望表与实际输出对不上，**先怀疑上游数据变了**（照 `_meta.source` 重抓），
而不是去放宽断言。
