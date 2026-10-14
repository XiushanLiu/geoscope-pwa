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
  // ★「六路」已不再准确：自驾模块新增了 OSRM 路线与高德 POI 两路（现共八路）。
  //   诚实原则 —— 加了源就得改说法，否则这句话本身就成了假的隐私承诺。
  'about.privacy': '除已声明的数据源（现有八路）之外，本应用不向任何域名发起请求；你的坐标不会被上传到数据源以外的地方。',

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
  'csv.h.aqi': '欧洲 AQI',
  'csv.h.aqiLevel': 'AQI 档位',
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
  'desc.roadtrip': '地候 GeoScope —— 自驾：路线规划、行程实录与自驾路线图。',
  'a11y.mainNav': '主导航',
  'a11y.checkParams': '自检参数',
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
  'attr.osrm': 'OSRM（基于 OpenStreetMap，ODbL）',
  'attr.amap': '高德地图 Web 服务 API',

  // ---------- 自驾模块：两路新源的源名 ----------
  'source.osrmRoute': '路线规划（OSRM 公共实例）',
  'source.amapPoi': '地点候选（高德 Web 服务）',

  // ---------- 自驾模块：失败桶（data 层翻译，UI 层上屏） ----------
  // ★这几句必须是**具体的**：高德的业务失败是 HTTP 200 包着 status:"0"，
  //   分桶的用处是让用户知道该做什么（换 Key / 等明天 / 稍后再试 / 去关签名），
  //   一句「请求失败」等于什么都没说。{code} 是数字，双语通用。
  'rt.amap.noKey': '未填高德 Key',
  'rt.amap.invalidKey': '高德 Key 无效或已过期（错误码 {code}）',
  'rt.amap.quota': '今日配额已用尽（错误码 {code}）',
  'rt.amap.busy': '调用过于频繁（错误码 {code}），请稍后再试',
  'rt.amap.sig': '请在控制台关闭数字签名后重试（错误码 {code}）',
  'rt.amap.other': '高德返回错误（错误码 {code}）',
  'rt.err.noRoute': '未能算出路线（OSRM 返回 {code}）',
  'rt.err.zeroDistance': '算出的路线距离为 0：坐标可能落在没有道路的地方',
  'rt.err.noGeometry': 'OSRM 未返回路线几何',
  'rt.err.needMorePoints': '至少需要 2 个坐标点才能算路线（现在 {n} 个）',
  'rt.err.badAnchor': '候选搜索的中心坐标非法',
  // 下面两个是切段（`core/roadtrip.js::splitStopovers`）的失败桶：
  // 它拿不到 OSRM 错误码，只能说「这份路线数据缺了什么」，与上面几条同族。
  'rt.err.noAnnotations': 'OSRM 未返回逐边时长，无法按天切分',
  'rt.err.badTarget': '每天目标时长必须大于 0，最小间隔不能为负',
  // ★与 rt.err.noRoute 的区别：那条要填 {code}（OSRM 真的回了一个错误码）；这条是
  //   「压根没拿到一份路线数据」，没有码可填 —— 用带占位的那条会让 {code} 原样上屏。
  'rt.err.noRouteData': '拿到的不是一份路线数据，无法按天切分',

  // ---------- 自驾模块：页面文案（T03 页面外壳 + 设置页两张卡） ----------
  'rt.title': '自驾',
  'rt.subtitle': '规划路线与停留点、记录实际打卡、画出自驾路线图',
  'rt.back': '返回「我的」',
  'rt.empty': '这一版只有入口',
  'rt.emptyHint': '路线规划、行程实录、路线图还没做完 —— 做完后就从这一页开始。现在这里不会发任何请求。',
  'rt.entry': '自驾',
  'rt.entryBtn': '进入自驾',
  'rt.entryHint': '从出发地到目的地，按每天开 3–5 小时规划停留点，并记录实际打卡的住宿 / 景点 / 美食。',
  'rt.keyTitle': '高德 Key',
  'rt.keyHint': '住宿 / 景点 / 美食的候选走高德搜索，需要你自己的 Key（个人实名认证有免费额度）。没填也能求路和画路线图，只是候选搜不出来。',
  'rt.keyPlaceholder': '粘贴你的高德 Web 服务 Key',
  'rt.keySave': '保存',
  'rt.keyClear': '清除',
  'rt.keyCheck': '校验（会真的发请求、消耗配额）',
  // ★不写「1 次」：amapPoi 的 retry = 1，业务失败（HTTP 200 包 status:"0"）不重试，
  //   但**传输层**超时会重试一次 → 最坏 2 次。写死「1 次」在正常路径成立、在超时路径是假的。
  'rt.keyCheckHint': '正常情况下 1 次；网络超时会自动重试，最多 2 次。',
  'rt.keyChecking': '正在校验…',
  'rt.keyOk': 'Key 可用：这次搜到 {count} 条候选',
  'rt.keyOkZero': 'Key 可用（这次搜索返回 0 条候选，坐标或类别可能太窄）',
  'rt.keyCurrent': '当前：{mask}',
  'rt.keyNone': '当前：未填',
  'rt.keySaved': '已保存（{mask}）',
  'rt.keyCleared': '已清除',
  'rt.keyBad': '没存进去：Key 为空、超过 {max} 个字符，或者中间有空格',
  'rt.keyClearFail': '本来就没填，不用清',
  'rt.keyStored': 'Key 只存在这台设备上，不进备份文件、不上传。',

  // ---------- 自驾模块：规划主流程（T04b：表单 / 求路 / 分天 / 候选 / 存盘） ----------
  'rt.planTitle': '规划',
  'rt.planHint': '出发地与目的地走地点搜索挑，不手输经纬度；至少两个点才能算路线。',
  'rt.origin': '出发地',
  'rt.dest': '目的地',
  'rt.viaTitle': '必经点（可选）',
  'rt.viaItem': '必经点 {n}',
  'rt.viaAdd': '添加一个必经点',
  'rt.viaRemove': '移除',
  'rt.startDate': '出发日期',
  'rt.dailyTarget': '每天开多久',
  'rt.dailyOpt': '{h} 小时',
  'rt.planBtn': '算路线并分天',
  'rt.planning': '正在算路线…',
  'rt.pickPh': '搜索地点（至少 2 个字）',
  'rt.pickClear': '清除',
  'rt.searching': '正在搜索…',
  'rt.searchEmpty': '没搜到这个地方',
  'rt.resultTitle': '结果',
  'rt.totalLabel': '全程',
  'rt.daysLabel': '{n} 天',
  'rt.dayTitle': '第 {n} 天',
  'rt.dayDrive': '开 {dur} · {dist}',
  'rt.dayDriveUnknown': '开 — · —',
  'rt.tailMerged': '末段 {min} 分钟并入第 {n} 天',
  'rt.noStopover': '这一程不需要中途停留',
  'rt.driftNote': '每日时长出自 OSRM 逐边时长求和，全程总时长出自 legs 求和；两者实测相差 {pct} %（OSRM 内部取整），不是同一个数。',
  'rt.freeflowNote': '驾驶时长为 OSRM 自由流估算，非实时路况。',
  'rt.snapWarn': '有途经点被吸附到 {km} 外的道路，请核对。',
  'rt.poiTitle': '候选（不落盘）',
  'rt.poiHint': '候选只活在这一页，不写进本机存储；点了「采用」才变成打卡记录。',
  'rt.poiQuota': '将对 {a} 个停留点 × {t} 个类别发起 {n} 次搜索（串行，并发恒为 1），最多消耗 {n} 次配额。',
  'rt.poiQuotaZero': '还没有停留点，没有可搜的锚点。',
  'rt.poiBtn': '搜索候选',
  'rt.poiSearching': '正在搜索候选（{done}/{n}）…',
  'rt.poiOnlyStay': '只搜住宿',
  'rt.poiAllTypes': '三类都搜',
  'rt.poiTypeHint': '收窄类别能直接减少配额消耗。',
  'rt.poiNoKey': '未填高德 Key：候选搜不出来。求路 / 分天 / 保存照常可用，也可以手动添加。',
  'rt.poiGoSettings': '去设置页填 Key',
  'rt.poiManualAdd': '手动添加',
  'rt.poiManualPh': '手动填写名称',
  'rt.poiEmpty': '这次没搜到候选（坐标或类别可能太窄）。',
  'rt.poiAdopt': '采用',
  'rt.poiAdopted': '已采用',
  // ★必须标明是**直线**距离：路网距离要再发一次请求才拿得到，拿不到就不许冒充
  'rt.poiStraight': '直线 {m}',
  'rt.type.stay': '住宿',
  'rt.type.sight': '景点',
  'rt.type.food': '美食',
  'rt.groupPass': '符合（{n}）',
  'rt.groupFail': '不达标（{n}）',
  'rt.groupUnknown': '未填（{n}）',
  'rt.groupUnknownField': '未填：{field}（{n}）',
  'rt.unknownHint': '「未填」是高德没给这个字段 —— 不用均价 / 默认值补；用户可以自己补录。',
  'rt.field.pricePerNight': '房价',
  'rt.field.roomType': '房型',
  'rt.field.level': '景区等级',
  'rt.field.localSpecial': '当地特色',
  'rt.checkedTitle': '已采用的打卡（{n}）',
  'rt.saveTitle': '保存',
  'rt.tripName': '行程名字',
  'rt.tripNamePh': '例如「成都—西安 5 天」',
  'rt.saveBtn': '保存这条行程',
  'rt.saveOk': '已保存：{name}',
  'rt.saveFail': '没存进去：写入本机存储失败（配额可能已满）。请到设置页清理旧行程后再试。',
  'rt.tripListTitle': '已保存的行程（{n}）',
  'rt.tripListEmpty': '还没有保存过行程',
  'rt.tripSkipped': '有 {n} 条行程打不开',
  'rt.tripItem': '{name} · {days} 天',

  // ---------- 自驾模块：路线图（T05） ----------
  'rt.mapTitle': '路线图',
  'rt.mapHint': '底图与署名照旧；缩放层级由「刚好装下这一程」反算，不手动调。',
  'rt.mapWhole': '整段',
  'rt.mapEmpty': '还没有路线可画：先规划一次。',
  'rt.mapGeo': '几何来源：{src}',
  'rt.mapGeoSimplified': 'OSRM 简化几何（simplified）',
  'rt.mapGeoNone': '没有几何',
  'rt.mapLoad': '取这一段的几何（simplified，1 次请求）',
  'rt.mapFetching': '正在取几何…',
  'rt.mapGeoFail': '几何没取到：{msg}',
  'rt.mapSchematic': '★这条是**示意直线**（起点到终点直连），不是真实路径 —— 没拿到几何时不许画成实线。',
  'rt.mapNoFit': '这一程跨度太大，已降到最小层级，可能看不全。',
  'rt.mapNoCoord': '未定位',

  // ---------- 自驾模块：实录（T05） ----------
  'rt.recordTitle': '实录',
  'rt.recordHint': '采用过的候选与手填的打卡都在这里；没坐标的不上图，只写在列表里。',
  'rt.recordEmpty': '还没有打卡记录',
  'rt.recordItem': '{name}{addr}',
  'rt.recordNoLocated': '{n} 条未定位（不上图）',

  // ---------- 自驾模块：搬家（导出 / 导入，T05） ----------
  'rt.moveTitle': '搬家',
  'rt.moveHint': '导出成独立文件（不含几何），在另一台机器上导入。文件里有你去过的地方，别发到公开场合。',
  'rt.exportBtn': '导出全部行程',
  'rt.exportOk': '已导出 {n} 条：{file}',
  'rt.exportEmpty': '没有可导出的行程',
  'rt.importBtn': '选择行程文件',
  'rt.importPreview': '将导入 {n} 条（{d} 条被跳过）',
  'rt.importApply': '确认导入',
  'rt.importOk': '已导入 {n} 条',
  'rt.importFail': '这个文件读不出行程：{msg}',

  // ---------- 自驾模块：行程导入失败原因 ----------
  // core/roadtrip.js 与 core/tripstore.js 只回 reasonKey / reasonParams
  //（core 不许 import i18n），由 UI 层 tr() 上屏。
  'trip.badJson': '不是合法 JSON',
  'trip.notObject': '行程内容不是 JSON 对象',
  'trip.badSchema': '行程文件格式版本不支持（schema={schema}）',
  'trip.newerSchema': '这份行程由更新版本创建（schema={schema}），请升级后再打开',
  'trip.notRoadtrip': '不是地候的行程文件',
  'trip.noTrips': '文件里没有 trips 数组',
  'trip.planNoTrips': '导入计划里没有 trips 数组（请先调用 inspectTripFile）',
  'trip.notFound': '没有这条行程',

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
