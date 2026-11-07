/**
 * 中文文案表（i18n 的**一份表**，不是入口）
 *
 * 职责：只存放中文文案。**翻译函数 t() 不在这里** —— 它住在 src/i18n/index.js
 * （那才是 i18n 的入口：持有「当前 locale + 表 + 切换」）。本文件是纯数据，
 * core 层不许 import 它（core ← data ← ui ← html 单向依赖里，core 读 locale 表
 * 等于让最底层反向依赖上层文案；core 只返回结构化 key，由 UI 层翻译）。
 *
 * ★本文件与 src/i18n/en.js 必须**逐键同构**：tools/check.mjs 第 14 节双向校验两张表的
 *   key 集合完全相等 —— 少一个 key，界面会直接显示 `wmo.61` 这样的原始键名。
 *   新增 key 时两张表一起加，顺序无要求（校验按集合比）。
 *
 * 约定：
 *   - key 用点号分层：`now.title`、`status.ok`、`source.weather`；
 *   - 占位符用 `{name}`，由 t() 的 params 替换（未提供时保留占位符原样）；
 *   - 占位符名一律用**语义名**（`{name}` / `{dir}` / `{level}`），不用 `{zh}`
 *     —— 英文包复用同一套占位符名，`{zh}` 在英文表里就是自相矛盾的命名。
 */

/** 中文文案表：扁平 key → 字符串。 */
export const ZH = {
  // ---------- 通用 ----------
  'app.name': '地候 GeoScope',
  'app.tagline': '此刻 · 此地',
  'app.loading': '正在装载…',
  'app.retry': '重试',
  'app.refresh': '刷新',
  'app.unknown': '未知',
  'app.dash': '—',
  'app.na': '暂无',
  'app.about': '关于与边界',
  'app.copy': '复制',

  // ---------- 标签页 ----------
  'tab.now': '此刻',
  'tab.selfcheck': '自检',
  'tab.compass': '方位',
  'tab.settings': '我的',
  'tab.geo': '地理',
  'tab.climate': '气候',

  // ---------- 数据源名 ----------
  'source.weather': '天气（Open-Meteo Forecast）',
  'source.air': '空气质量（Open-Meteo Air Quality）',
  'source.geocode': '地名搜索（Open-Meteo Geocoding）',
  'source.elevation': '海拔（Open-Meteo Elevation）',
  'source.reverse': '逆地理反查（Photon）',
  'source.tile': '底图瓦片（ArcGIS Online）',
  // 气候常态：ERA5 1991–2020 逐日再分析，**本地按月聚合**出来的月平均。
  'source.climate': '气候常态（Open-Meteo ERA5 归档）',

  // ---------- 气候常态（1991–2020 月平均 / 年平均） ----------
  // ★红线：`climate.entryNote` 必须整句上屏，不许简写成「气候常态」——
  //   它不是官方气候常态，是 ERA5 再分析格点值自算的月平均。
  'climate.title': '气候常态（1991–2020）',
  'climate.entryNote': 'ERA5 再分析 1991–2020 自算月平均 · 非官方气候常态',
  // 整句模板，只插值数字（英文语序不同，不能拼片段）。
  // {lat}/{lon} 是 ERA5 的 0.25° 格点中心，{km} 是它到查询点的距离；
  // 三者缺任一 → 整行不显示（见 ui/now.js 的 renderClimateCard）。
  'climate.gridNote': '数据取自 ERA5 格点 {lat}, {lon}，距查询点约 {km} km',
  'climate.loadBtn': '查看月平均',
  'climate.loading': '正在取 30 年再分析数据…',
  'climate.colMonth': '月份',
  'climate.colHigh': '平均最高',
  'climate.colLow': '平均最低',
  'climate.colPrecip': '月降水',
  'climate.annual': '年均',
  'climate.annualHigh': '年均最高',
  'climate.annualLow': '年均最低',
  'climate.annualPrecip': '年降水总量',
  'climate.sample': '样本 {n} 天 · {years} 年',
  'climate.m1': '1月',
  'climate.m2': '2月',
  'climate.m3': '3月',
  'climate.m4': '4月',
  'climate.m5': '5月',
  'climate.m6': '6月',
  'climate.m7': '7月',
  'climate.m8': '8月',
  'climate.m9': '9月',
  'climate.m10': '10月',
  'climate.m11': '11月',
  'climate.m12': '12月',
  'climate.err': '气候常态取数失败',
  'climate.retry': '重试',

  // ---------- 状态词 ----------
  'status.idle': '未请求',
  'status.ok': '正常',
  'status.stale': '陈旧',
  'status.degraded': '降级',
  'status.failed': '失败',
  'status.offline': '离线',
  'status.running': '进行中',

  // ---------- 错误码 ----------
  'error.OFFLINE': '设备离线，未发起请求',
  'error.TIMEOUT': '请求超时（{ms} ms 内未响应）',
  'error.HTTP': '数据源返回 HTTP {status}',
  'error.NETWORK': '网络不可达，请求未能完成',
  'error.PARSE': '响应解析失败（数据格式异常）',
  'error.ABORT': '请求被主动取消',
  'error.EMPTY': '响应为空（数据源未返回内容）',
  'error.UNSUPPORTED': '未注册的数据源或不支持的能力',

  // ---------- 整体降级态 ----------
  'mode.live': '实时数据',
  'mode.stale': '部分数据陈旧，正在显示最近一次可用结果',
  'mode.partial': '部分数据源不可用，其余数据正常',
  'mode.offline': '设备离线，正在显示本机缓存',
  'mode.no-map': '底图不可用，已切换为纯坐标模式',
  // grid 只在横幅出现：五个 API 全都好，只是瓦片缺了几块、底图降成网格。
  // 不能复用 mode.partial —— 那句「其余数据正常」在这里是假话（数据没事，坏的是底图），
  // 会让用户以为天气/空气也跟着坏了。
  'mode.grid': '部分瓦片未取到 · 已降为网格',
  'mode.empty': '暂无可用数据',

  // ---------- 此刻屏 ----------
  'now.title': '此刻',
  'now.defaultPlaceNotice': '未取得定位，正在显示默认地点',
  'now.locating': '正在获取定位…',
  'now.gpsOk': '定位成功',
  'now.updatedAt': '更新于 {time}',
  'now.staleNote': '数据于 {ago} 更新，可能已过时',
  'now.observeAt': '观测时刻 {time}',

  'card.weather': '天气',
  // 逐时曲线：画的是**今日 0–23 点**（上游 hourly 从当地 00:00 起，见 openmeteo.js 的 slice(0,24)），
  // 不是「未来 24 小时」—— 标题必须说清是「今日」，否则 20 点看这张图会误以为跨到明天。
  'card.hourly': '今日逐时',
  'hourly.hint': '点按曲线查看某一小时',
  'hourly.empty': '逐时数据未取到',
  'hourly.at': '{hour} 时',
  'hourly.nowLabel': '现在',
  'hourly.a11y': '今日逐时温度曲线，最高 {max}，最低 {min}',
  // 分享海报：只补按钮与结果播报；海报内的指标名沿用 w.* 既有键，不另造一套词
  'poster.make': '生成海报',
  'poster.shareTitle': '{place} 天气',
  'poster.shared': '海报已分享',
  'poster.saved': '海报已保存为图片',
  'poster.fail': '海报生成失败，请重试',
  'poster.brand': '地候 GeoScope',
  'poster.footer': '数据来源 Open-Meteo · 仅供出行参考',
  'card.air': '空气',
  // ★2026-10 真机：空气卡上的数取自 `european_aqi`（欧洲 AQI，档位 20/40/60/80/100），
  //   等级词却和国标用同一套字 —— 中国用户会把 EAQI 74 读成国标的「良」（51–100），
  //   而欧标里它落在 60–80 = 差。数值没错，缺的是「这把尺子是哪把」，所以这句必须上屏。
  //   ★只标尺度，不改算法（wmo.js 的阈值与 aqi() 的判定式一字未动）。
  'air.aqiScale': 'AQI 为欧洲标准（EAQI），档位与中国国标不同',
  'card.place': '位置',
  'card.provenance': '数据来源',
  // ★「这一路命中了本地缓存」：没发请求，不许显示 0 ms。与 map.cacheHit 各用各的键，故意不互借。
  'prov.cacheHit': '缓存命中',
  // 缓存命中时的数据年龄：只在这里补一句「多久前取的」，观测时刻仍以 now.observeAt 为准
  'prov.cachedAgo': '缓存数据 · {ago}更新',
  'card.forecast': '今日与未来',

  'w.temp': '气温',
  'w.feels': '体感',
  'w.humidity': '湿度',
  // ★「降水量」与「降水概率」是两个不同的量，两个标签必须各自说清楚：
  // 前者是毫米、后者是百分比，混写成一句「降水」会让用户以为这是同一个数的两种说法。
  'w.precip': '降水量',
  'w.pop': '降水概率',
  'w.wind': '风',
  'w.pressure': '气压',
  'w.visibility': '能见度',
  'w.sunrise': '日出',
  'w.sunset': '日落',
  'w.dayLength': '昼长',
  'w.uv': '紫外线',
  'w.elevation': '海拔',
  'w.coord': '坐标（WGS84）',
  'w.air': '欧洲 AQI',
  'w.pm10': 'PM10',
  'w.pm25': 'PM2.5',
  'w.ozone': '臭氧 O₃',
  'w.no2': '二氧化氮 NO₂',
  'w.latency': '时延',
  'w.beaufortLevel': '{name}（{level} 级）',
  'w.unitC': '°C',
  'w.aqiAdvice': '{level} · {advice}',
  'w.noMap': '无地图纯坐标模式',
  'w.todayMax': '今日最高',
  'w.todayMin': '今日最低',
  'w.daylight': '白昼',
  'w.night': '夜间',

  // ---------- 紫外线 / AQI 建议 ----------
  'uv.low.advice': '无需防护',
  'uv.moderate.advice': '长时间户外建议戴帽',
  'uv.high.advice': '建议防晒霜与遮阳',
  'uv.very-high.advice': '尽量避免正午外出',
  'uv.extreme.advice': '务必全面防护',
  'aqi.good.advice': '空气质量令人满意',
  'aqi.fair.advice': '可正常活动',
  'aqi.moderate.advice': '敏感人群减少户外剧烈运动',
  'aqi.poor.advice': '建议减少户外活动',
  'aqi.very-poor.advice': '敏感人群应避免外出',
  'aqi.extreme.advice': '尽量避免外出，必要时佩戴口罩',

  // ---------- 地点搜索 ----------
  // 搜索是「看别的地方」的唯一入口：没有它，用户只能看自己站的那一处（定位）或
  // 已经收藏过的那几处，形成「只能看当前位置 → 收藏它 → 在收藏之间跳」的死锁。
  // ★'search.failed' 与 'search.empty' 必须是**两句不同的话**：合成一句「没找到」
  // 会把超时 / 断网伪装成「这地方不存在」，用户会以为自己打错了而不是网络坏了。
  'search.open': '搜索地点',
  'search.close': '收起搜索',
  'search.placeholder': '输入城市或地名',
  'search.minChars': '至少输入 {n} 个字再搜索',
  'search.loading': '正在搜索…',
  'search.empty': '没有找到这个地方',
  'search.failed': '搜索失败，不是「没有这个地方」',
  'search.unnamed': '（未命名）',

  // ---------- 自检页 ----------
  'sc.title': '数据源自检',
  'sc.subtitle': '真机复验：逐源串行取样，瓦片做指纹去重判定',
  // 「我的」页里的自检入口（2026-10-16：自检从底部 tabbar 搬进「我的」页）
  'sc.entryTitle': '数据源自检',
  'sc.entryHint': '逐源取样，看清哪一路通、哪一路不通。换网络或数据看着不对时先来这里。',
  'sc.entryBtn': '打开自检',
  'sc.networkType': '网络类型',
  'sc.networkType.hint': '浏览器不暴露真实网络类型，请手动点选',
  'sc.net.wifi': 'WiFi',
  'sc.net.cellular': '蜂窝',
  'sc.net.unknown': '未知',
  'sc.samples': '取样次数',
  'sc.run': '开始自检',
  'sc.running': '自检进行中…',
  'sc.export': '导出 JSON',
  'sc.copy': '复制结果',
  'sc.copyOk': '已复制到剪贴板，可直接粘贴发送',
  'sc.copyFail': '复制失败，JSON 已显示在日志区，请长按全选复制',
  'sc.copyCompact': '复制精简版',
  'sc.copyCompactOk': '已复制精简版（约 1.5 KB，去掉长 URL 与 UA），可直接粘贴发送',
  'sc.copyCompactFail': '复制失败，精简 JSON 已显示在日志区，请长按全选复制',
  'sc.sources': '数据源',
  'sc.tiles': '瓦片指纹',
  'sc.log': '日志',
  'sc.summary.pass': '通过 {pass}/{total}',
  'sc.verdict.all-ok': '全部数据源可用',
  'sc.verdict.partial': '部分数据源不可用',
  'sc.verdict.offline': '设备离线，未发起请求',
  'sc.ms': '{ms} ms',
  'sc.latencyRange': '时延 {min}–{max} ms',
  'sc.latencyP50': 'P50 {ms} ms',
  'sc.latencyAvg': '均值 {ms} ms',
  'sc.httpStatus': 'HTTP {status}',
  'sc.bytes': '{bytes} B',
  'sc.fp': '指纹 fp',
  'sc.fpShort': 'fp',
  'sc.fpAlgo': '算法 {algo}',
  'sc.dedupeReal': '去重判定：real（{styles} 种底图各自指纹各异，是真实瓦片）',
  'sc.dedupeFake': '去重判定：fake（{styles} 种底图内指纹各自全同，疑似占位图）',
  'sc.dedupeUnknown': '去重判定：unknown（各样式结论不一致或样本不足，{unique}/{total}）',
  'sc.dedupeByStyle': '{label}：{unique}/{total} → {verdict}',
  'sc.mapMode': '底图模式：{mode}',
  'sc.mapMode.map': '底图可用',
  'sc.mapMode.grid': '仅网格 + 坐标（部分瓦片失败，未宣布无地图）',
  'sc.mapMode.no-map': '纯坐标（底图不可用）',
  'sc.warmup': '预热 1 次（不计入统计）',
  'sc.sampleDone': '第 {i}/{n} 次取样完成',
  'sc.exportName': 'geoscope-selfcheck-{stamp}.json',
  'sc.exportFail': '导出失败：本机浏览器不支持文件下载',
  'sc.offlineSkip': '设备离线，自检未发起请求',
  'sc.tileOk': '{label} · {ms} ms · {bytes} B',
  'sc.tileFail': '{label} · 失败 · {message}',
  'sc.effectiveType': 'effectiveType：{value}',
  'sc.downlink': 'downlink：{value} Mb/s',
  'sc.userAgent': 'UA：{value}',

  // ---------- 地理屏（地点 + 底图 + 方位 + 完整罗盘） ----------
  // 2026-10-17 导航重构：compass.html 从「方位」页扩成「地理」页，三 tab 之一。
  // `geo.title` 是它的 <title>；页头第一行是**地名**（动态），不是这一条。
  'geo.title': '地理 · 方位与底图',

  // ---------- 方位屏（磁偏角 WMM2025 + 罗盘） ----------
  // 文案口径：只说「模型算出来的值」与「模型有效期」，**不说精度**。
  // WMM 的 COF 里没有误差模型，模块也不导出任何不确定度字段，写「误差 ±X°」就是编的。
  'compass.title': '方位 · 磁偏角',
  'compass.subtitle': '本机计算：WMM2025 地磁模型，不联网',
  'compass.na': '暂不可用',
  'compass.unavailable': '磁偏角暂不可用（{reason}）',
  'compass.defaultPlaceNotice': '未取得定位，正在显示默认地点',
  'compass.altitudeUnknown': '海拔未知，按 0 m 参与计算',
  'compass.calcNote': '数值由模型算出，未经实地标定',

  'card.declination': '磁偏角',
  // ★本键已不上屏（2026-10-26 起模型卡末行改用 `compass.modelAt`）。保留**仅作反向锚点**：
  //   `tests/compass.test.mjs` 拿它断言「不许再借『地磁要素』当那一行的标签」；删了它，
  //   `t()` 会返回键名字面量 'card.magnetic'，那条断言就变成拿中文标签比一个英文字符串
  //   —— **永远绿、却什么都没钉住，且不报红**（与 `compass.title` 在 tools/check.mjs
  //   第 16 节的用途同一类：都是「看似没用、删了护栏静默变弱」的键）。
  'card.magnetic': '地磁要素',
  'card.model': '模型信息',
  'card.convert': '真方位 ↔ 磁方位换算',
  'card.compass': '罗盘',

  'compass.d': '磁偏角 D',
  'compass.i': '磁倾角 I',
  'compass.f': '总场强 F',
  'compass.h': '水平分量 H',
  'compass.x': '北向分量 X',
  'compass.y': '东向分量 Y',
  'compass.z': '垂直分量 Z',
  // D 的**读法**：东偏为正，负数要读成「西偏 N°」，不能直愣愣显示 -7.49°
  'compass.east': '东偏 {deg}°',
  'compass.west': '西偏 {deg}°',
  'compass.noDeclination': '正北（不偏）',
  // 年变率是模型自带的（symbolRates.dD，单位 度/年 → 换算成分/年），不是精度指标
  'compass.rateD': '磁偏角每年变化约 {min}′',

  'compass.modelName': '模型',
  'compass.modelEpoch': '历元',
  'compass.modelRangeLabel': '有效期',
  'compass.modelSource': '来源',
  // ★这一行的值是小数年，原借 `card.magnetic`（地磁要素）当标签，界面读到「地磁要素 2026.82」。
  'compass.modelAt': '计算时刻（小数年）',
  'compass.modelDoi': 'DOI',
  'compass.modelRange': '{from} – {until}',
  'compass.modelOk': '在有效期内',
  'compass.modelLeft': '距失效约 {years} 年',
  // 超期/回溯：数值照常显示，只在这里把信任等级降下来（卡片挂告警态，数字不隐藏）
  'compass.modelExpired': '已超出有效期约 {years} 年，数值仅供近似参考',
  'compass.modelAhead': '早于模型历元约 {years} 年，为回溯推值',

  'compass.trueBearing': '真方位',
  'compass.magBearing': '磁方位',
  'compass.inputTrueHint': '输入真方位（度）',
  'compass.inputMagHint': '输入磁方位（度）',
  'compass.resultPrefix': '结果',
  'compass.convertHint': '东偏为正：真方位 = 磁方位 + 磁偏角',
  'compass.inputInvalid': '请输入一个角度（数字）',
  'compass.convertUnavailable': '磁偏角暂不可用，换算不可进行',

  'compass.sensorUnsupported': '本机无方向传感器 · 仅显示计算值与手动换算',
  // ★「未授权」这句要能真的帮到人：WebKit 会把拒绝决定按站点记住，之后不再询问，
  //   所以必须告诉用户去哪儿改回来（只说「未授权」等于把人卡死）。
  'compass.sensorDenied': '方向传感器未授权 · 仅显示计算值与手动换算；若曾点过「不允许」，需到浏览器的站点设置里改回',
  // ★不说「iPhone」：所有 iOS 浏览器都走 WebKit，且未来的 Chrome 安卓也会要授权 ——
  //   写死平台名，那条未来一到来就是错的（用「本浏览器」这类不指名平台的说法）。
  'compass.sensorIdle': '本浏览器要求点击后才授权读取方向传感器 · 未授权前仅显示计算值与手动换算',
  'compass.sensorWaiting': '已启用，正在等待方向数据…',
  'compass.sensorEnable': '启用方向传感器',
  'compass.headingMag': '当前朝向（磁）{deg}°',
  'compass.headingTrue': '当前朝向（真）{deg}°',
  // ★山名按**磁方位**取（与盘面刻度同源）：用真方位会整体错一个磁偏角
  'compass.shanNow': '二十四山：{name}',
  // ★真机问题「红蓝两针不知道哪个是真北哪个是磁北」——盘面下方给一行图例。
  //   色点**只由 CSS token 取色**（.compass-dot--mag / --true），文案这里只负责命名：
  //   写死十六进制，哪天 token 改了图例就会撒谎。
  'compass.legendMag': '红针 · 磁北',
  'compass.legendTrue': '青针 · 真北',
  // ★只在磁偏角有效时才上屏：没有磁偏角就没有真北针，此时说「两针夹角」是假话。
  //   这句话本身是真的 —— _dial() 里真北针是在磁北针基础上再转 +declination。
  'compass.needleHint': '两针夹角即磁偏角：红针指向磁北，青针指向真北',
  'compass.compassNote': '指针方向来自设备传感器，未做校准，仅供参考',

  // ---------- 瓦片样式 ----------
  'tile.street': '街道图',
  'tile.imagery': '影像图',
  'tile.dark': '暗色图',

  // ---------- 底图渲染（S57 街道样式 / S58 GRID 降级） ----------
  'card.map': '底图',
  'map.subtitle': '256 px 瓦片按 z/x/y 拼接 · 街道 / 影像 / 暗色三样式',
  'map.zoom': 'z{zoom}',
  'map.trusted': '已授信',
  'map.untrusted': '未授信',
  'map.cacheHit': '缓存命中',
  'map.loading': '瓦片加载中',
  // ★终态「全部取回成功」，原先无词可说被兜底成「瓦片加载中」（读到「9/9 块 · 瓦片加载中」）。不许借 loading / cacheHit。
  'map.loaded': '已加载',
  'map.blocks': '{ok}/{total} 块',
  'map.detail': '{blocks} · {elapsed} · {tail}',
  'map.tailBlank': '{n} 块留白',
  'map.tailFailed': '{n} 块失败',
  'map.noMap': '底图不可用，已切换为纯坐标模式',
  'map.noMapNote': '坐标与数值不受影响',
  'map.zoomIn': '放大',
  'map.zoomOut': '缩小',
  // ★「画不动了」要说出来：以前顶到缩放上限只有一个变灰的 +，用户不知道是网络失败还是到底了
  //   （street 在中国上限 z13，放大两下就撞上）。只在到顶时出现，不许常驻。
  // ★真机反馈「影像放到最大偏模糊」：这句要能回答「为什么糊」，而不是只报一个数字。
  //   只陈述两条确定的事实 —— ① 已经到样式上限；② 再放大拿不到更细的瓦片。
  //   ★不许承诺「放大就清楚」，也不许说「此地区没有影像」（我们只实测过北京，
  //     实拍截图的位置是别处）；清晰度确实随该地区的源数据覆盖而变，如实说明即可。
  'map.zoomMax': '已到最高 {z} 级 · 再放大不会有更细的影像，清晰度取决于该地区覆盖',
  'map.footnote': '瓦片按 URL 缓存 7 天 · 授信后发请求 · 6 s 超时不重试',
  'map.gridFootnote': '底图缺块不影响坐标与数值 · 离线仍可出网格',
  'map.credit': '底图署名',
  'map.skeletonNote': '瓦片未到 · 先出骨架',

  // ---------- 关于与边界 ----------
  'about.title': '关于与边界',
  'about.noCommercial': '不商业化：自用工具，无广告、无第三方统计、无账号登录、无后端。',
  'about.noE2ee': '不做端到端加密同步：数据只存本机 localStorage，搬家靠导出 JSON。',
  'about.noAlert': '预警不采购数据源：本阶段不实现预警推送。',
  // ★这句话里的**数字必须跟着源表走**：诚实原则 —— 加了源就得改说法，
  //   否则这句话本身就成了假的隐私承诺。
  //   2026-10-17 自驾下线：原本是「六路 + 自驾两路 = 八路」，现为
  //   「自检六路（`SOURCE_LIST`）+ 气候常态一路 = 七路」（见 data/sources.js 的 `SOURCE_TABLE`）。
  'about.privacy': '除已声明的数据源（现有七路）之外，本应用不向任何域名发起请求；你的坐标不会被上传到数据源以外的地方。',
  // 开发者署名：中文只显示「善哉」；英文的「+」是写在 HTML 里的 <sup>（见 about-dev-plus），
  //   不放文案里 —— applyI18n 用 textContent 覆盖，写这里会被抹掉。
  'about.developerLabel': '开发者：',
  'about.developer': '善哉',

  // ---------- 使用说明（settings.html 的 #help 静态区块） ----------
  // 只写代码与 README 已确认的行为，不承诺未验证的能力（不写精度、不写实测耗时）。
  'help.title': '使用说明',
  'help.step1': '三个页面：底部胶囊切换「地理 / 气候 / 我的」。桌面图标直接落在「地理」页。',
  'help.step2': '定位与地点：首次打开会请求定位；拒绝或超时会用默认地点。可在「我的 → 默认地点」改，或在「气候」页的搜索框按地名查找。',
  'help.step3': '地理页：磁偏角由 WMM2025 模型在本机算出，断网也能用；底图可在街道 / 影像 / 暗色三种样式间切换，用「放大 / 缩小」按钮缩放；手机有方向传感器时可点「启用方向传感器」看罗盘。',
  'help.step4': '气候页：天气、空气、今日与未来，以及「查看月平均」取 1991–2020 气候常态。有旧缓存时照常显示并标注「更新于 …」，不会留空白。',
  'help.step5': '添加到桌面：在浏览器菜单里选「添加到桌面 / 添加到主屏幕」。OPPO 自带浏览器没有这个菜单，请改用 360 或 Chrome 打开同一个网址。',
  'help.step6': '备份：数据只存本机。「我的 → 备份导出」生成 JSON，换机后用「备份导入」恢复；也可以导出 CSV 表格。',
  'help.tip': '磁偏角与网格底图离线可用；离线时天气显示的是上一次的缓存值，并标明更新时间。',
  'help.entry': '查看使用说明',

  // ---------- 收藏 ----------
  // 收藏是「地点」，不是天气快照：只存 名称 + 经纬度，不存任何取回来的数据。
  // 空态必须把「收藏 → 备份」这条关系讲明白 —— 这是收藏这个功能存在的理由：
  // 数据只在本机，iOS 会清 PWA 存储，收藏唯一的退路就是跟着备份导出走。
  'fav.title': '收藏地点',
  'fav.count': '共 {count} 条',
  'fav.hint': '收藏只存本机，不上传；导出备份时会一起带走，导入备份时会一起回来。',
  'fav.empty': '还没有收藏地点。到「此刻」页点标题下的收藏按钮，把当前地点存到这里 —— 收藏会随备份一起导出，换手机时导入那份 JSON 就能原样恢复。',
  // 按钮两态（☆ / ★ 是图标，文案本身走 i18n）
  'fav.add': '收藏此地',
  'fav.added': '已收藏',
  // 点完的短暂反馈：add 那条顺手把「备份时会带上」说清楚，替空态文案再讲一次
  'fav.addedHint': '已收藏 · 导出备份时会带上它',
  'fav.removedHint': '已取消收藏',
  'fav.delete': '删除',
  'fav.deleteOf': '删除收藏：{name}',
  'fav.go': '查看此刻天气',
  'fav.unnamed': '未命名地点',

  // ---------- 多地点对比 ----------
  // 对比页从「我的」页进（不进底部 tabbar：tabbar 在 320px 屏上已经贴着临界点，
  // 再加一项会把四个 tab 挤到换行 —— 那是个真机上真实发生过的 bug）。
  // 口径规矩：每个地点**单独**取一次数（网络一次只发一个请求），取不到的那个
  // 单独标失败、指标留占位符「—」，绝不拿别处的数据填进来。
  'compare.title': '多地点对比',
  'compare.subtitle': '把收藏地点的同一批指标逐个列出来，一个地点一张卡，同一行的指标可以直接对读',
  'compare.entry': '对比收藏地点',
  'compare.entryBtn': '开始对比',
  'compare.hint': '每个地点要单独取一次数，而网络一次只发一个请求 —— 收藏越多，等得越久。',
  'compare.current': '当前收藏 {count} 条',
  'compare.needFav': '先收藏地点：到「此刻」页点标题下的收藏按钮，把想对比的地方存起来，再回来。',
  'compare.maxNote': '收藏超过 {max} 条，本次只对比前 {max} 条。想对比别的，先到上面把不看的删掉。',
  'compare.summary': '共 {total} 个地点 · 已取到 {ok} 个 · 失败 {failed} 个',
  'compare.summaryRunning': '共 {total} 个地点 · 正在取第 {done} 个…',
  'compare.offline': '设备离线，未发起请求',
  'compare.allFailed': '这 {total} 个地点一个都没取到数据。可能是网络不通或数据源暂时不可用 —— 不是这些地点没有天气。',
  'compare.rowFailed': '这个地点没取到数据：{reason}',
  'compare.loading': '正在取数…',
  'compare.refresh': '刷新',
  'compare.back': '返回「我的」',

  // ---------- 设置 / 我的 ----------
  'settings.title': '我的 · 设置',
  'settings.subtitle': '备份搬家与外观：整机数据不出设备，导出与导入都在本机完成。',

  // 地理页一次性安装提示（compass.js 用）：只出现一次，链接到设置页的安装卡
  'install.hint': '可添加到桌面，下次一键直达地理页。',
  'install.hintCta': '去安装',
  'install.dismiss': '关闭安装提示',
  // 添加到桌面 / 主屏幕（一次性动作，装完折叠成一行）
  'settings.installTitle': '添加到桌面或主屏幕',
  'settings.installHint': '装好之后从桌面或主屏幕的图标打开就是它：不显示地址栏，断网也能打开这一页。',
  'settings.installBtn': '添加到桌面',
  'settings.installedNote': '已经装好了：从桌面或主屏幕上的那个图标打开即可。',
  // 平台中立：本页无法可靠判断 iOS / 安卓，所以两条路都写出来，让用户自己对号入座
  'settings.installManual': '这个浏览器没有给页面「一键安装」的入口，需要手动添加：iPhone / iPad 请用 Safari 打开本页，点底部「分享」→「添加到主屏幕」；安卓请用 Chrome 打开本页，点右上角菜单 →「安装应用」或「添加到主屏幕」。装好后从那个图标打开即可。',
  'settings.installAccepted': '已接受安装：系统会在桌面或主屏幕上加一个图标。',
  'settings.installDismissed': '这次没装：你在系统提示里点了取消。想再试可以刷新本页，或按上面的手动步骤添加。',
  'settings.installFailed': '这一步没能走完（多半是重复点击或浏览器不支持）。按上面的手动步骤一样能添加。',
  // 宿主环境分档：先说清「为什么这里装不了」，再给出路。判据见 install.js 的 detectHostEnv()
  'settings.installBlockedWechat': '你现在是在「微信内置的浏览器」里（不是 Chrome / Safari），它不支持把网页装到桌面 —— 所以这一步在微信里无论点多少次都不会有图标，跟本 App 本身没关系。唯一可行的出路：点右上角「…」→「在浏览器打开」，换系统浏览器打开本页，再按那边的菜单添加。',
  'settings.installBlockedQq': '你现在是在「QQ 内置的浏览器」里（不是 Chrome / Safari），它不支持把网页装到桌面 —— 这一步在 QQ 里点不出来，跟本 App 本身没关系。出路：点右上角「…」→「在浏览器打开」，换系统浏览器打开本页，再按那边的菜单添加。',
  'settings.installManualIos': 'iPhone / iPad 请用「Safari」打开本页：iOS 上的 Chrome、微信、QQ 用的都是同一套 WebKit 内核，只有 Safari 有这个入口。然后点屏幕「底部中间」的「分享」→ 在列表里下滑找到「添加到主屏幕」→ 右上角「添加」。',
  // ★这一档以真机核对为准（ColorOS，2026-11-07）：菜单里**没有**「添加到桌面」，
  //   长按书签也没有这一项 —— 旧的「长按书签→添加到桌面」是错的，别再写回去。
  //   同一台机器上用 360 浏览器可一步装成，所以文案改为「换 360 / Chrome」。
  'settings.installManualOppo': '你用的是 OPPO 自带浏览器（ColorOS）。实机核对过：它的菜单里没有「添加到桌面」，长按书签也没有这一项 —— 加收藏只会把网页留在「书签收藏」列表里，不会生成桌面图标，别在这儿找。能装成的办法：① 复制下面的网址，打开 360 浏览器或 Chrome 粘贴访问（实机验证：360 浏览器的「添加到桌面」一步装成，点开没有地址栏）；② 在那个页面点「添加到桌面」，桌面出现「地候 GeoScope」，点开进入地理页；③ 若坚持用自带浏览器，它只能当书签用，桌面不会有图标。',
  'settings.installManualAndroid': '两条路。① 先试快的：用「Chrome 或系统自带浏览器」打开本页 → 右上角「⋮」→「安装应用」或「添加到主屏幕」（三星 / 小米 / 华为 / UC / 夸克的菜单在屏幕「底部的底栏」里，不在右上角）。② 找不到就用系统兜底：长按手机桌面空白处 →「快捷方式」或「小部件」→「网站快捷方式」→ 网址填 {url} → 名称填「{app}」。★但这条兜底只有部分安卓机（三星、原生系统）有 —— OPPO 的 ColorOS 和 vivo 的桌面编辑里没有「快捷方式」这一项，别在那里找（用这两个自带浏览器打开时，本卡会直接给你它们各自的路径）。两条都不成：装 Chrome，用它打开本页安装。差别说清：②只是书签图标（有地址栏、断网打不开）；Chrome 装出来的才是无地址栏、能离线的完整版。',
  // 拿不到网址（Node 侧等非浏览器环境）时的同一条安卓文案：不许把 {url} 占位符漏到界面上
  'settings.installManualAndroidNoUrl': '两条路。① 先试快的：用「Chrome 或系统自带浏览器」打开本页 → 右上角「⋮」→「安装应用」或「添加到主屏幕」（三星 / 小米 / 华为 / UC / 夸克的菜单在屏幕「底部的底栏」里，不在右上角）。② 找不到就用系统兜底：长按手机桌面空白处 →「快捷方式」或「小部件」→「网站快捷方式」→ 网址填「浏览器地址栏里当前这一页的地址」（长按可复制）→ 名称填「{app}」。★但这条兜底只有部分安卓机（三星、原生系统）有 —— OPPO 的 ColorOS 和 vivo 的桌面编辑里没有「快捷方式」这一项，别在那里找。两条都不成：装 Chrome，用它打开本页安装。差别说清：②只是书签图标（有地址栏、断网打不开）；Chrome 装出来的才是无地址栏、能离线的完整版。',
  'settings.installCopyUrl': '复制网址',
  'settings.installCopied': '已复制 {url}：粘到浏览器地址栏或「网站快捷方式」的网址栏里就行。',
  'settings.installCopyFailed': '这个浏览器不允许网页自动复制，只能手动：长按上面那行网址，选中后复制。',

  // 默认地点（定位拿不到时显示的就是它；出厂那份必须标注出来，它不是用户的位置）
  'settings.defaultPlaceTitle': '默认地点',
  'settings.defaultPlaceHint': '定位拿不到的时候（拒绝 / 超时 / 没信号 / 环境不支持），此刻屏与地理页显示的就是这里设的地点。收藏与搜索跳转不受它影响。',
  'settings.defaultPlaceCurrent': '现在是：{name} · {coord}',
  'settings.defaultPlaceFactoryNote': '这是出厂默认的那个地点，不是你的位置 —— 没改过的话，定位拿不到时显示的就是它。',
  'settings.defaultPlaceGpsBtn': '用当前位置',
  'settings.defaultPlaceGpsDone': '已设为默认地点：{name}',
  'settings.defaultPlaceGpsDenied': '没改成：定位权限被拒绝（你或系统拒的）。默认地点一个字节都没动。',
  'settings.defaultPlaceGpsTimeout': '没改成：等定位等到超时。默认地点一个字节都没动。',
  'settings.defaultPlaceGpsUnsupported': '没改成：这个环境不支持浏览器定位。默认地点一个字节都没动。',
  'settings.defaultPlaceGpsOther': '没改成：定位没拿到，原因分不出来（不是超时，可能是权限或本机定位不可用）。默认地点一个字节都没动。',
  'settings.defaultPlaceFavTitle': '从收藏选',
  'settings.defaultPlaceFavEmpty': '还没有收藏 —— 先去此刻页或地理页收藏几个地点，就能在这里选了。',
  'settings.defaultPlaceFavDone': '已设为默认地点：{name}',
  'settings.defaultPlaceFavMissing': '没改成：那条收藏已经不在列表里了（可能刚被删掉）。默认地点一个字节都没动。',
  'settings.defaultPlaceResetBtn': '恢复出厂默认',
  'settings.defaultPlaceResetDone': '已恢复出厂默认：{name}',

  // 首屏分段耗时（整句成模板，只插值数字；缺段显示「—」，不许显示 0 也不许省略整段）
  'settings.bootTiming': '首屏耗时：定位 {geo} · 天气 {weather} · 空气 {air} · 海拔 {elevation} · 后台 {background} · 合计 {total}',

  'settings.exportTitle': '备份导出',
  'settings.exportBtn': '导出备份文件',
  'settings.exportCurrent': '当前可导出：默认地点 {place} · 收藏 {count} 条 · 天气快照 {snapshot}',
  'settings.snapshotYes': '已保存',
  'settings.snapshotNo': '暂无',
  'settings.exportDone': '已导出 {name}',
  'settings.exportFail': '导出失败：本机浏览器不支持文件下载',
  // exportBackup() 的 JSDoc 明确要求：导出前必须告知用户这份文件含位置信息。
  // 这句话常驻在按钮下方，不是点完才闪一下的提示 —— 用户要在按之前就知道。
  //
  // 有快照 / 无快照必须分开说，不能用同一句含糊带过：快照里嵌着**最近一次定位坐标**
  // （经纬度，能精确到社区）以及四条同样含经纬度的数据源请求链接 —— 这比 defaultPlace
  // 敏感一个量级（defaultPlace 通常是出厂默认值「北京·天安门」，根本不是用户的真实位置）。
  // 2026-10-12 用真机导出的第一份备份核对后发现原文案只说「最近一次天气快照」，
  // 把最敏感的一项藏在了最不起眼的四个字里。
  'settings.backupPrivacy': '这份文件含你的位置信息：默认地点、{count} 个收藏地点，以及最近一次定位坐标（经纬度，能精确到社区）和当时取到的天气、空气数据 —— 数据源链接里也嵌着同一串经纬度。导出不联网、不上传，文件只存到你选择的位置；别把它随手发给别人。',
  'settings.backupPrivacyNoSnap': '这份文件含你的位置信息：默认地点与 {count} 个收藏地点。本次没有天气快照，所以不含定位坐标。导出不联网、不上传，文件只存到你选择的位置；别把它随手发给别人。',

  'settings.importTitle': '备份导入',
  'settings.importHint': '选择 geoscope-backup-*.json。先看清楚内容再决定 —— 确认后会覆盖本机的默认地点、收藏与最近一次定位坐标。',
  'settings.importPick': '选择备份文件',
  'settings.importReady': '已读取 {name}，内容如下。本机数据此刻还没动。',
  'settings.pickFirst': '请先选择一个备份文件。',
  'settings.previewTitle': '这份备份的内容',
  'settings.previewExportedAt': '导出时间：{time}',
  'settings.previewPlace': '默认地点：{name}',
  'settings.previewFavorites': '收藏地点：{count} 条',
  'settings.previewDropped': '其中 {count} 条不会被导入：坐标非法、与前面的重复，或超出 200 条上限。',
  'settings.previewNoPlace': '未命名地点',
  'settings.confirmBtn': '确认导入',
  'settings.confirmHint': '这一步才会写入本机，并把上面的内容覆盖到当前数据。',
  'settings.importOk': '导入完成：默认地点 {name} · 收藏 {count} 条',
  'settings.importFail': '导入失败：{reason}',
  'settings.readFail': '读取文件失败：{message}',
  'settings.readEmpty': '文件内容是空的，可能不是文本格式的备份文件。',

  'settings.themeTitle': '主题',
  'settings.themeHint': '跟随系统＝由系统的深浅色设置决定；手动指定后会一直保持，直到你改回来。',
  'settings.theme.system': '跟随系统',
  'settings.theme.light': '浅色',
  'settings.theme.dark': '深色',
  'settings.themeDone': '主题已切换为「{mode}」',

  // ---------- 无障碍字号三档 ----------
  // 三档只改「乘数」（styles/tokens.css 的 --fs-scale），不动任何色值、不动 --sp-* 间距。
  // 英雄区那个大温度刻意放得比正文慢（--fs-hero-scale）—— 它本来就是正文的 4 倍，
  // 再按 1.3 放大会把窄屏挤坏。这句话要如实讲给用户听，别含糊成「放大全部文字」。
  'settings.fontTitle': '字号',
  'settings.fontHint': '三档放大全站文字。那个大号温度放得慢一些：它本来就是正文的四倍，跟着一起放大会把窄屏挤坏。',
  'settings.font.normal': '默认',
  'settings.font.large': '大',
  'settings.font.xlarge': '特大',
  'settings.fontDone': '字号已切换为「{mode}」',

  // ---------- 离线壳版本（「我的」页那张卡） ----------
  // 为什么要把版本号摆到界面上：浏览器只看 sw.js 自身的字节判断要不要更新，
  // 真机可能一直跑着一份**很旧**的壳 —— 页面是旧的，但没有任何报错，只能靠猜。
  // 这里显示的不是「仓库里最新的版本号」，而是 SW 自己报回来的、这台设备实际在用的那一份。
  // ★绝不编版本号：拿不到就如实说「未知 / 本环境不支持」，不许拿常量或缓存名拼一个糊上去 ——
  //   编出来的版本号比「未知」更糟，它会让人以为自己已经在跑新版。
  'shell.title': '离线壳版本',
  'shell.querying': '查询中…',
  'shell.unknown': '未知（没读到本机离线壳的版本）',
  'shell.unsupported': '本环境不支持离线壳（需要 https 或 localhost）',
  'shell.checkBtn': '检查更新',
  'shell.checking': '发现新版本，正在应用…',
  'shell.upToDate': '已是最新',
  'shell.compareUnknown': '没拿到要对比的版本号，无法确认是否最新；已催浏览器去查更新，刷新后再看上方版本号。',
  'shell.checkFailed': '检查失败：{msg}',
  'shell.fingerprint': '指纹 {fp}',
  // 微信 / QQ 内置浏览器不运行 Service Worker：这不是「没更新」，是根本没壳可更新，必须说清楚
  'shell.noSW': '这个浏览器不运行离线壳（微信、QQ 内置浏览器常见），换 Chrome / Edge / 360 打开才会自动更新。',
  'shell.registered': '已注册离线壳，刷新一次页面后生效。',
  'shell.onlineVersion': '线上最新：{v}',
  'shell.localOlder': '本机 {local}，线上已是 {online}；已催更新，刷新页面即换新。',
  'shell.hint': '浏览器有时会继续用旧的那份离线壳，这里显示的就是本机实际在用的那一份。如果它比你以为的旧，说明缓存还没换过来 —— 点「检查更新」可以手动催一次。',
  // 全站提示条（src/ui/shellupdate.js）：新壳已装好、正等待接管时，任何页面顶部都会显示。
  // reloadBtn 只出现在提示条上，刷新**由用户点**，不自动刷（会把正在输入的搜索词冲掉）。
  'shell.updateReady': '有新版本已就绪',
  'shell.reloadBtn': '立即刷新',

  // ---------- 导出 CSV ----------
  // 口径（与备份 JSON 那条隐私说明同一套规矩）：导出前就说清楚导的是什么、缺的项怎么表示。
  // 特别注意「缺的项留空，不填 0」—— 本项目界面上缺失一律显示占位符「—」，但 CSV 里写
  // 「—」会让 Excel 把整列判成文本列，数字列就废了；留空才是表格里「没有数据」的语义。
  'settings.csvTitle': '导出 CSV',
  'settings.csvHint': '把最近一次「此刻」数据导出成表格。UTF-8 带 BOM，Excel 直接打开不乱码；每一行一个时刻，缺的项留空（不填 0）。',
  'settings.csvBtn': '导出 CSV 文件',
  'settings.csvCurrent': '当前可导出：{time} · {place}',
  'settings.csvNone': '当前可导出：暂无数据',
  'settings.csvEmpty': '还没有可导出的数据 —— 先去「此刻」页取一次，它会自动存一份到本机。',
  'settings.csvDone': '已导出 {name}',
  'settings.csvFail': '导出失败：本机浏览器不支持文件下载',
  'settings.csvNoSnapshot': '暂无快照可导出',

  // CSV 表头（core/csv.js 消费）：每一列都对应界面上一个数字，不许出现界面上没有的量。
  // 时间两列特意标出时区：导出时间跟文件名一样是设备本地时间，观测时刻是被查询
  // 地点的当地时间。查异地时这两列本来就不一样，不明写会被当成 bug。
  'csv.h.exportedAt': '导出时间（本机）',
  'csv.h.observedAt': '观测时刻（当地）',
  'csv.h.place': '地点',
  'csv.h.lat': '纬度（度）',
  'csv.h.lon': '经度（度）',
  'csv.h.elevation': '海拔（m）',
  'csv.h.temp': '气温（°C）',
  'csv.h.feels': '体感（°C）',
  'csv.h.humidity': '湿度（%）',
  'csv.h.precip': '降水（mm）',
  'csv.h.windSpeed': '风速（m/s）',
  'csv.h.windDir': '风向',
  'csv.h.beaufort': '蒲福风级',
  'csv.h.pressure': '气压（hPa）',
  'csv.h.visibility': '能见度（m）',
  'csv.h.weather': '天气现象',
  'csv.h.wmoCode': '天气码',
  'csv.h.sunrise': '日出',
  'csv.h.sunset': '日落',
  'csv.h.dayLength': '昼长（分）',
  'csv.h.uv': '紫外线指数',
  'csv.h.uvLevel': '紫外线档位',
  'csv.h.todayMax': '今日最高（°C）',
  'csv.h.todayMin': '今日最低（°C）',
  // ★与屏幕口径一致：空气卡上写的是 EAQI（欧洲标准），导出的两列也必须是同一把尺子。
  'csv.h.aqi': '欧洲 AQI（EAQI）',
  'csv.h.aqiLevel': 'EAQI 档位',
  'csv.h.pm10': 'PM10（µg/m³）',
  'csv.h.pm25': 'PM2.5（µg/m³）',
  'csv.h.ozone': '臭氧（µg/m³）',
  'csv.h.no2': '二氧化氮（µg/m³）',
  'csv.h.declination': '磁偏角（度，东偏为正）',
  'csv.h.sources': '数据来源',

  // ---------- 图例与指标释义 ----------
  // 「指标释义」是此刻页底部一个可展开的面板，把界面上那些专业数字讲成人话。
  // ★阈值纪律（改这段文案前必须知道）：下面凡是出现**分档数字**的，全部由
  //   src/ui/legend.js 从 src/core/wmo.js 的既有换算表**读出来**再拼进占位符，
  //   这里一个阈值都不写死 —— 抄死数字等于将来改了换算表图例还在说谎。
  //   代码里找不到现成分档的指标（气温 / 湿度 / 气压 / 能见度 / 污染物浓度 / 海拔 /
  //   坐标 / 时区），一律只写「是什么 + 单位」，并如实标注 legend.noScale。
  'legend.title': '指标释义',
  'legend.open': '展开指标释义',
  'legend.close': '收起指标释义',
  'legend.note': '下面每一条对应界面上一个数字。分档只列本应用「已经实现」的那几套（蒲福风级、欧洲 AQI、UV 五档、风向 16 方位）；其余指标只说明含义与单位，不另立标准。',
  'legend.noScale': '本应用没有对这项设分档，只显示数值与单位。',

  'legend.group.weather': '天气',
  'legend.group.air': '空气',
  'legend.group.place': '位置与时间',

  'legend.temp.title': '气温',
  'legend.temp.unit': '°C',
  'legend.temp.body': '离地 2 米高处的气温，取自数据源的 temperature_2m。',

  'legend.feels.title': '体感温度',
  'legend.feels.unit': '°C',
  'legend.feels.body': '数据源给出的体感温度（apparent_temperature）：在气温之外还把风与湿度的影响算了进去。它是算出来的，不是另测一个数 —— 夏天比气温高、冬天比气温低都属正常。',

  'legend.humidity.title': '相对湿度',
  'legend.humidity.unit': '%',
  'legend.humidity.body': '空气中实际水汽压与同温度下饱和水汽压之比（relative_humidity_2m）。100% 表示已饱和，此时容易起雾或结露。',

  'legend.precip.title': '降水量',
  'legend.precip.unit': 'mm',
  'legend.precip.body': '当前时次累计的降水量（precipitation），单位毫米。这是「下了多少」，不是「会不会下」—— 会不会下看下面那条降水概率。',

  'legend.pop.title': '降水概率',
  'legend.pop.unit': '%',
  'legend.pop.body': '当前这一小时出现降水的概率（precipitation_probability），单位百分比。它是**逐时**量，界面显示的是与「观测时刻」对上的那一小时。取不到时显示占位符「—」，不按 0% 显示 —— 0% 是「确定不下」，与「不知道」不是一回事。',

  'legend.wind.title': '风速',
  'legend.wind.unit': 'm/s',
  'legend.wind.body': '离地 10 米处的风速（wind_speed_10m），单位米每秒；界面同时给出公里每小时换算（1 m/s = 3.6 km/h）。',

  'legend.beaufort.title': '蒲福风级',
  'legend.beaufort.unit': '级',
  'legend.beaufort.body': '把风速分成 0–12 级，界面上「清风（4 级）」就是这么来的。级名与阈值取自本应用的换算表：',
  'legend.beaufort.row': '{level} 级 · {name} · 小于 {max} m/s',
  'legend.beaufort.rowLast': '{level} 级 · {name} · {min} m/s 及以上',

  'legend.winddir.title': '风向',
  'legend.winddir.unit': '°',
  'legend.winddir.body': '风的**来向**（wind_direction_10m），按每 22.5° 一段切成 16 个方位。「西北偏北风」说的是风从西北偏北吹来，不是吹向那边：',
  'legend.winddir.row': '{dir}',

  'legend.pressure.title': '气压',
  'legend.pressure.unit': 'hPa',
  'legend.pressure.body': '地面气压（surface_pressure），单位百帕。数值随海拔与天气系统起伏，单看一个绝对值意义不大。',

  'legend.visibility.title': '能见度',
  'legend.visibility.unit': 'm / km',
  'legend.visibility.body': '水平方向能看清的最远距离（visibility）。不足 1000 米时按米显示，达到 1000 米后换算成公里并保留一位小数。',

  'legend.uv.title': '紫外线指数',
  'legend.uv.unit': '无量纲',
  'legend.uv.body': '当天的紫外线指数最大值（uv_index_max），是个无量纲指数。五档与对应建议取自本应用既有的换算表：',
  'legend.uv.row': '{min}–{max} · {name} · {advice}',
  'legend.uv.rowLast': '{min} 及以上 · {name} · {advice}',

  'legend.sun.title': '日出与日落',
  'legend.sun.unit': '本地时刻',
  'legend.sun.body': '由数据源按当地时区给出（daily.sunrise / sunset）。数据源没给时，改用本机内置的 NOAA 算法推算。',

  'legend.dayLength.title': '昼长',
  'legend.dayLength.unit': '时 · 分',
  'legend.dayLength.body': '日落减日出，即白昼时长。极昼或极夜时数据源可能给不出这两个时刻，那一刻显示占位符「—」。',

  'legend.today.title': '今日最高 / 最低',
  'legend.today.unit': '°C',
  'legend.today.body': '数据源给出的当日最高温与最低温（temperature_2m_max / _min）。这是**全天预报值**，不是此刻的实测值。',

  'legend.wmo.title': '天气现象',
  'legend.wmo.unit': 'WMO 码',
  'legend.wmo.body': '图标与描述由 WMO 天气码翻译而来（0–99，例如 0 是晴、61 是小雨）。取不到码、或码非法时显示「未知天气」—— 不会把「没数据」误报成晴天。',

  'legend.observedAt.title': '观测时刻',
  'legend.observedAt.unit': '本地时刻',
  'legend.observedAt.body': '数据源给出的当前数据时次，已按当地时间偏移换算成本地时间显示。',

  'legend.aqi.title': '欧洲 AQI',
  'legend.aqi.unit': '无量纲',
  'legend.aqi.body': '数据源直接给出的欧洲 AQI（european_aqi）：把多种污染物折算成一个数，越小越好。本应用只负责把它分成六档，档位与建议如下：',
  'legend.aqi.row': '{min}–{max} · {name} · {advice}',
  'legend.aqi.rowLast': '{min} 及以上 · {name} · {advice}',

  'legend.pollutants.title': 'PM2.5 / PM10 / O₃ / NO₂',
  'legend.pollutants.unit': 'µg/m³',
  'legend.pollutants.body': '四种污染物浓度，单位微克每立方米。本应用不对单项污染物分级 —— 分级只针对上面那个欧洲 AQI，这四项只是构成它的原料，所以这里也就不给档位。',

  'legend.elevation.title': '海拔',
  'legend.elevation.unit': 'm',
  'legend.elevation.body': '所在地点的海拔（Open-Meteo Elevation），单位米。取不到时显示占位符「—」。',

  'legend.coord.title': '坐标',
  'legend.coord.unit': '度（WGS84）',
  'legend.coord.body': 'WGS84 经纬度，保留四位小数（约 11 米精度）。收藏与跨页跳转都以这两个数作为地点的身份。',

  'legend.tz.title': '时区偏移',
  'legend.tz.unit': '秒',
  'legend.tz.body': '数据源返回的「当地时区相对 UTC 的偏移」（utc_offset_seconds）。日出日落与观测时刻都是按它换算的 —— 它一变，这几个时刻会跟着变。',

  // ---------- WMO 天气码 ----------
  // core/wmo.js 的 wmo(code) 只返回 `{ key, shortKey, icon }`，**不给中文串** ——
  // core 层不许读 locale 表。这 28 组 key 由 UI 层 t() 之后才变成人话。
  // 分 full / short 两档：short 用在窄处（英雄区副行、对比页），full 用在图例与表格。
  'wmo.0': '晴',
  'wmo.0.short': '晴',
  'wmo.1': '大部晴朗',
  'wmo.1.short': '晴间少云',
  'wmo.2': '局部多云',
  'wmo.2.short': '多云',
  'wmo.3': '阴',
  'wmo.3.short': '阴',
  'wmo.45': '雾',
  'wmo.45.short': '雾',
  'wmo.48': '沉积雾凇雾',
  'wmo.48.short': '雾凇',
  'wmo.51': '小毛毛雨',
  'wmo.51.short': '毛毛雨',
  'wmo.53': '中毛毛雨',
  'wmo.53.short': '毛毛雨',
  'wmo.55': '大毛毛雨',
  'wmo.55.short': '毛毛雨',
  'wmo.56': '冻毛毛雨（弱）',
  'wmo.56.short': '冻毛毛雨',
  'wmo.57': '冻毛毛雨（强）',
  'wmo.57.short': '冻毛毛雨',
  'wmo.61': '小雨',
  'wmo.61.short': '小雨',
  'wmo.63': '中雨',
  'wmo.63.short': '中雨',
  'wmo.65': '大雨',
  'wmo.65.short': '大雨',
  'wmo.66': '冻雨（弱）',
  'wmo.66.short': '冻雨',
  'wmo.67': '冻雨（强）',
  'wmo.67.short': '冻雨',
  'wmo.71': '小雪',
  'wmo.71.short': '小雪',
  'wmo.73': '中雪',
  'wmo.73.short': '中雪',
  'wmo.75': '大雪',
  'wmo.75.short': '大雪',
  'wmo.77': '米雪',
  'wmo.77.short': '米雪',
  'wmo.80': '小阵雨',
  'wmo.80.short': '阵雨',
  'wmo.81': '中阵雨',
  'wmo.81.short': '阵雨',
  'wmo.82': '强阵雨',
  'wmo.82.short': '暴雨',
  'wmo.85': '小阵雪',
  'wmo.85.short': '阵雪',
  'wmo.86': '大阵雪',
  'wmo.86.short': '阵雪',
  'wmo.95': '雷阵雨',
  'wmo.95.short': '雷阵雨',
  'wmo.96': '雷阵雨伴小冰雹',
  'wmo.96.short': '雷暴冰雹',
  'wmo.99': '雷阵雨伴大冰雹',
  'wmo.99.short': '强雷暴冰雹',
  // 未知码兜底：★必须与「取不到数据」同义，不能是「晴」。
  'wmo.unknown': '未知天气',
  'wmo.unknown.short': '未知',

  // ---------- 蒲福风级 0–12 ----------
  'bf.0': '无风',
  'bf.1': '软风',
  'bf.2': '轻风',
  'bf.3': '微风',
  'bf.4': '和风',
  'bf.5': '清风',
  'bf.6': '强风',
  'bf.7': '疾风',
  'bf.8': '大风',
  'bf.9': '烈风',
  'bf.10': '狂风',
  'bf.11': '暴风',
  'bf.12': '飓风',

  // ---------- 风向 16 方位 ----------
  // full 用在图例（要写全名），abbr 用在此刻页那个数字后面（要短）。
  // 中文两档同值 —— 中文没有「缩写更短」的习惯，硬造一个反而不如原名清楚。
  'dir.0': '北',
  'dir.0.abbr': '北',
  'dir.1': '东北偏北',
  'dir.1.abbr': '东北偏北',
  'dir.2': '东北',
  'dir.2.abbr': '东北',
  'dir.3': '东北偏东',
  'dir.3.abbr': '东北偏东',
  'dir.4': '东',
  'dir.4.abbr': '东',
  'dir.5': '东南偏东',
  'dir.5.abbr': '东南偏东',
  'dir.6': '东南',
  'dir.6.abbr': '东南',
  'dir.7': '东南偏南',
  'dir.7.abbr': '东南偏南',
  'dir.8': '南',
  'dir.8.abbr': '南',
  'dir.9': '西南偏南',
  'dir.9.abbr': '西南偏南',
  'dir.10': '西南',
  'dir.10.abbr': '西南',
  'dir.11': '西南偏西',
  'dir.11.abbr': '西南偏西',
  'dir.12': '西',
  'dir.12.abbr': '西',
  'dir.13': '西北偏西',
  'dir.13.abbr': '西北偏西',
  'dir.14': '西北',
  'dir.14.abbr': '西北',
  'dir.15': '西北偏北',
  'dir.15.abbr': '西北偏北',
  // 风向是**来向**。中文靠后缀「风」、英文靠介词 from，两种语言语序不同 ——
  // 所以整句作为一条模板翻译，只插方位名，不拼片段。
  'w.windFrom': '{dir}风',

  // ---------- 分档名（欧洲 AQI 六档 / UV 五档） ----------
  'level.aqi.good': '优',
  'level.aqi.fair': '良',
  'level.aqi.moderate': '中',
  'level.aqi.poor': '差',
  'level.aqi.very-poor': '很差',
  'level.aqi.extreme': '极差',
  'level.uv.low': '低',
  'level.uv.moderate': '中',
  'level.uv.high': '高',
  'level.uv.very-high': '很高',
  'level.uv.extreme': '极高',

  // ---------- 时长 / 相对时间 / 陈旧时长 ----------
  // core/format.js 那三个函数只产出 { unit, value } 这样的**结构化量**，
  // 整句在这里翻译 —— 中英文语序不同（「10 小时 32 分」 vs "10h 32m"、
  // 「3 分钟前」 vs "3 min ago"），拼片段必错，只能整句插值。
  'fmt.duration.hm': '{h} 小时 {m} 分',
  'fmt.duration.m': '{m} 分',
  'fmt.ago.now': '刚刚',
  'fmt.ago.minute': '{n} 分钟前',
  'fmt.ago.hour': '{n} 小时前',
  'fmt.ago.day': '{n} 天前',
  'fmt.ago.month': '{n} 个月前',
  'fmt.stale.second': '{n} 秒',
  'fmt.stale.minute': '{n} 分钟',
  'fmt.stale.hour': '{n} 小时',
  'fmt.stale.day': '{n} 天',

  // ---------- 默认地点名 ----------
  // core/geo.js 与 core/store.js 里的默认地点只存经纬度 + 一个**稳定标记名**，
  // 显示名由这里给 —— core 不许读 locale 表，但「北京 · 天安门」是个地名，
  // 英文界面下必须写成 "Beijing · Tian'anmen"。
  'place.default': '北京 · 天安门',

  // ---------- 各页 <meta> 与读屏标签 ----------
  // HTML 外壳里那些**没有子元素**的位置（meta description / iOS 主屏名）与
  // 读屏软件念的 aria-label，同样看得见（只是有的用耳朵看），所以也走 i18n。
  'app.shortName': '地候',
  'app.description': '地候 GeoScope —— 自用地理气象速览，此刻此地的一屏数据。',
  'desc.selfcheck': '地候 GeoScope —— 数据源自检：逐源取样，看清哪一路通、哪一路不通。',
  'desc.compass': '地候 GeoScope —— 磁偏角与真/磁方位换算，本机 WMM2025 计算，不联网。',
  'desc.settings': '地候 GeoScope —— 备份导出与导入、主题切换，数据只留本机，不联网。',
  'desc.compare': '地候 GeoScope —— 多地点对比：把收藏地点的同一批指标并排列出来。',
  // ★地理页（compass.html）：地点（海拔 / 坐标 / 地名）+ 底图 + 方位·磁偏角 + 完整罗盘。
  //   2026-10-17 导航重构：方位页升级为「地理」主 tab，页面描述随之从「方位·磁偏角」
  //   扩到整页内容 —— 罗盘那部分仍在本页，只是不再是唯一的主题。
  'desc.geo': '地候 GeoScope —— 地理：海拔、坐标与地名，配底图、方位·磁偏角与完整罗盘。',
  'a11y.mainNav': '主导航',
  'a11y.checkParams': '自检参数',
  'a11y.located': '位置已更新：{place}',
  'a11y.weather': '天气已更新：{temp}，{desc}',
  // ---------- 界面语言 ----------
  // 切换器在「我的」页。★两档的显示名一律用**各自语言自己的写法**
  // （中文界面写「English」而不是「英文」）—— 用户看不懂当前界面语言时，
  // 唯一能救他的正是那个用他母语写着的选项名。
  'settings.langTitle': '语言',
  'settings.langHint': '切换全站文案语言。地点名与数值不受影响，它们本来就是数据源给的原文。',
  'settings.lang.zh': '中文',
  'settings.lang.en': 'English',
  'settings.langDone': '语言已切换为「{name}」',

  // ---------- 数据源署名 ----------
  // 署名是许可条款要求的原文，服务商名与协议名（CC-BY 4.0 / ODbL）一律不译；
  // 只有「基于」这类说明词跟着界面语言走。★括号用各语言自己的全角/半角习惯。
  'attr.openmeteo': 'Open-Meteo.com（CC-BY 4.0）',
  'attr.photon': 'Photon by Komoot（基于 OpenStreetMap，ODbL）',
  'attr.tile': 'Esri ArcGIS Online World Tile Service',

  // ---------- 备份导入失败原因 ----------
  // core/backup.js 只回 reasonKey / reasonParams（core 不许 import i18n），
  // 由 UI 层拼进 settings.importFail 的 {reason} 里上屏。
  'backup.badJson': '不是合法 JSON',
  'backup.notObject': '备份内容不是 JSON 对象',
  'backup.badSchema': '备份格式版本不支持（schema={schema}）',
  'backup.notGeoscope': '不是地候的备份文件',
  'backup.noPrefs': '缺少 prefs',
  'backup.badDefaultPlace': 'defaultPlace 坐标非法（lat/lon 必须是有限数字，纬度 ±90、经度 ±180 内）',
  'backup.planNoDefaultPlace': '导入计划里没有合法的 defaultPlace（请先调用 inspectBackup）',
  'backup.planNoFavorites': '导入计划里没有 favorites 数组（请先调用 inspectBackup）',
  'backup.writeFailed': '写入本机状态失败：{msg}',

  // ---------- 瓦片坐标非法 ----------
  // data 层可以 import i18n（只有 core 不行），所以这里直接在抛出点翻译。
  'tile.badCoord': '瓦片坐标非法（z={z}, x={x}, y={y}），未发起请求',
};
