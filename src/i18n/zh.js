/**
 * 中文文案表（i18n · 单一真相源）
 *
 * 职责：集中存放所有上屏文案。UI 层禁止硬编码中文字符串，一律通过 t(key, params) 取值。
 * 约定：
 *   - key 用点号分层：`now.title`、`status.ok`、`source.weather`；
 *   - 占位符用 `{name}`，由 t() 的 params 替换（未提供时保留占位符原样）；
 *   - 缺失键返回 key 本身，并在 debug 开启时告警（不抛异常）。
 * 阶段二新增英文包时，另建 `en.js` 并保持同构 key，由入口切换。
 */

/** 应用元信息（导出 JSON 与页面标题共用）。 */
export const APP_NAME = 'GeoScope';
export const APP_VERSION = '1.0.0';

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

  // ---------- 数据源名 ----------
  'source.weather': '天气（Open-Meteo Forecast）',
  'source.air': '空气质量（Open-Meteo Air Quality）',
  'source.geocode': '地名搜索（Open-Meteo Geocoding）',
  'source.elevation': '海拔（Open-Meteo Elevation）',
  'source.reverse': '逆地理反查（Photon）',
  'source.tile': '底图瓦片（ArcGIS Online）',

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
  'card.air': '空气',
  'card.place': '位置',
  'card.provenance': '数据来源',
  'card.forecast': '今日与未来',

  'w.temp': '气温',
  'w.feels': '体感',
  'w.humidity': '湿度',
  'w.precip': '降水',
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
  'w.beaufortLevel': '{zh}（{level} 级）',
  'w.unitC': '°C',
  'w.aqiAdvice': '{zh} · {advice}',
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

  // ---------- 自检页 ----------
  'sc.title': '数据源自检',
  'sc.subtitle': '真机复验：逐源串行取样，瓦片做指纹去重判定',
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
  'sc.offlineSkip': '设备离线，自检未发起请求',
  'sc.tileOk': '{label} · {ms} ms · {bytes} B',
  'sc.tileFail': '{label} · 失败 · {message}',
  'sc.effectiveType': 'effectiveType：{value}',
  'sc.downlink': 'downlink：{value} Mb/s',
  'sc.userAgent': 'UA：{value}',

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
  'compass.sensorDenied': '方向传感器未授权 · 仅显示计算值与手动换算',
  'compass.sensorIdle': '未启用方向传感器 · 仅显示计算值与手动换算',
  'compass.sensorWaiting': '已启用，正在等待方向数据…',
  'compass.sensorEnable': '启用方向传感器',
  'compass.headingMag': '当前朝向（磁）{deg}°',
  'compass.headingTrue': '当前朝向（真）{deg}°',
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
  'map.blocks': '{ok}/{total} 块',
  'map.detail': '{blocks} · {elapsed} · {tail}',
  'map.tailBlank': '{n} 块留白',
  'map.tailFailed': '{n} 块失败',
  'map.noMap': '底图不可用，已切换为纯坐标模式',
  'map.noMapNote': '坐标与数值不受影响',
  'map.zoomIn': '放大',
  'map.zoomOut': '缩小',
  'map.footnote': '瓦片按 URL 缓存 7 天 · 授信后发请求 · 6 s 超时不重试',
  'map.gridFootnote': '底图缺块不影响坐标与数值 · 离线仍可出网格',
  'map.credit': '底图署名',
  'map.skeletonNote': '瓦片未到 · 先出骨架',

  // ---------- 关于与边界 ----------
  'about.title': '关于与边界',
  'about.noCommercial': '不商业化：自用工具，无广告、无第三方统计、无账号登录、无后端。',
  'about.noE2ee': '不做端到端加密同步：数据只存本机 localStorage，搬家靠导出 JSON。',
  'about.noAlert': '预警不采购数据源：本阶段不实现预警推送。',
  'about.privacy': '除六路数据源之外，本应用不向任何域名发起请求；你的坐标不会被上传到数据源以外的地方。',
};

/**
 * 取文案。
 *
 * @param {string} key 文案键，如 'status.ok'
 * @param {Object<string, string|number>} [params] 占位符替换表，如 { ms: 123 }
 * @returns {string} 替换后的文案；键缺失时返回 key 本身。
 */
export function t(key, params = {}) {
  const tpl = ZH[key];
  if (tpl === undefined) {
    // 缺失键：静默返回 key；调试模式下由调用方（store.log）另行告警，此处不打日志以避免循环依赖
    return key;
  }
  return String(tpl).replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * 判断文案键是否存在（debug 自检用）。
 *
 * @param {string} key 文案键。
 * @returns {boolean} 是否存在。
 */
export function hasKey(key) {
  return Object.prototype.hasOwnProperty.call(ZH, key);
}

/** 导出全部键（供冒烟脚本检查完整性）。 */
export function allKeys() {
  return Object.keys(ZH);
}
