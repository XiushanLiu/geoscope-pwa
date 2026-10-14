/**
 * 英文文案表（i18n 的一份表，不是入口）
 *
 * ★与 src/i18n/zh.js **逐键同构**：tools/check.mjs 第 14 节双向校验两张表的 key 集合
 *   完全相等 —— 多一个、少一个都报红。新增 key 必须两张表一起加。
 *
 * 翻译纪律（不是机翻，改文案前请读）：
 *   1) **整句翻译，不拼片段**。中英语序不同（「体感 26°」 vs "Feels like 26°"、
 *      「3 分钟前」 vs "3 min ago"），占位符只用来插数字 / 地名 / 方位名这类**值**，
 *      绝不把一句话拆成几段再拼回去。
 *   2) **单位与数值口径不变**：界面一律公制（°C / m/s / hPa / km），英文版同样用公制 ——
 *      数据源给的就是公制，换成英里只会引入换算错误。
 *   3) **如实，不夸大**。中文版写着「本应用没有对这项设分档」的地方，英文版一样要写；
 *      中文版区分「失败」与「没有这个地方」的地方，英文版也必须分成两句。
 *   4) 地名、数据源名、缩写（WMO / AQI / UV / WGS84 / PM2.5）保留原样，不翻译。
 */

/** 英文文案表：扁平 key → 字符串。 */
export const EN = {
  // ---------- General ----------
  'app.name': 'GeoScope',
  'app.tagline': 'Here · Now',
  'app.loading': 'Loading…',
  'app.retry': 'Retry',
  'app.refresh': 'Refresh',
  'app.unknown': 'Unknown',
  'app.dash': '—',
  'app.na': 'None yet',
  'app.about': 'About & limits',
  'app.copy': 'Copy',

  // ---------- Tabs ----------
  'tab.now': 'Now',
  'tab.selfcheck': 'Check',
  'tab.compass': 'Bearing',
  'tab.settings': 'Me',

  // ---------- Data sources ----------
  'source.weather': 'Weather (Open-Meteo Forecast)',
  'source.air': 'Air quality (Open-Meteo Air Quality)',
  'source.geocode': 'Place search (Open-Meteo Geocoding)',
  'source.elevation': 'Elevation (Open-Meteo Elevation)',
  'source.reverse': 'Reverse geocoding (Photon)',
  'source.tile': 'Basemap tiles (ArcGIS Online)',

  // ---------- Status words ----------
  'status.idle': 'Not requested',
  'status.ok': 'OK',
  'status.stale': 'Stale',
  'status.degraded': 'Degraded',
  'status.failed': 'Failed',
  'status.offline': 'Offline',
  'status.running': 'Running',

  // ---------- Error codes ----------
  'error.OFFLINE': 'Device is offline, no request was made',
  'error.TIMEOUT': 'Request timed out (no response within {ms} ms)',
  'error.HTTP': 'Data source returned HTTP {status}',
  'error.NETWORK': 'Network unreachable, request could not complete',
  'error.PARSE': 'Failed to parse the response (unexpected data format)',
  'error.ABORT': 'Request was cancelled',
  'error.EMPTY': 'Empty response (the source returned nothing)',
  'error.UNSUPPORTED': 'Unregistered source or unsupported capability',

  // ---------- Overall degraded modes ----------
  'mode.live': 'Live data',
  'mode.stale': 'Some data is stale, showing the last usable result',
  'mode.partial': 'Some sources are unavailable, the rest is fine',
  'mode.offline': 'Device is offline, showing on-device cache',
  'mode.no-map': 'Basemap unavailable, switched to coordinates-only mode',
  // grid only ever appears in the banner: all five APIs are fine, it is just that a few
  // tiles are missing and the basemap fell back to a grid. Must NOT reuse mode.partial —
  // "the rest is fine" would be a lie here (the data is fine, the basemap is what broke),
  // and it would make the reader think weather / air broke too.
  'mode.grid': 'Some tiles missing · fell back to grid',
  'mode.empty': 'No data available',

  // ---------- Now screen ----------
  'now.title': 'Now',
  'now.defaultPlaceNotice': 'No location fix, showing the default place',
  'now.locating': 'Getting your location…',
  'now.gpsOk': 'Location acquired',
  'now.updatedAt': 'Updated {time}',
  'now.staleNote': 'Data from {ago}, it may be out of date',
  'now.observeAt': 'Observed at {time}',

  'card.weather': 'Weather',
  'card.air': 'Air',
  'card.place': 'Place',
  'card.provenance': 'Sources',
  'card.forecast': 'Today & next days',

  'w.temp': 'Temperature',
  'w.feels': 'Feels like',
  'w.humidity': 'Humidity',
  // ★"Precipitation" and "Chance of rain" are two different quantities and the two labels
  // must each say so: one is millimetres, the other a percentage. Writing both as "Rain"
  // makes the reader think it is one number phrased two ways.
  'w.precip': 'Precipitation',
  'w.pop': 'Chance of rain',
  'w.wind': 'Wind',
  'w.pressure': 'Pressure',
  'w.visibility': 'Visibility',
  'w.sunrise': 'Sunrise',
  'w.sunset': 'Sunset',
  'w.dayLength': 'Day length',
  'w.uv': 'UV index',
  'w.elevation': 'Elevation',
  'w.coord': 'Coordinates (WGS84)',
  'w.air': 'European AQI',
  'w.pm10': 'PM10',
  'w.pm25': 'PM2.5',
  'w.ozone': 'Ozone O₃',
  'w.no2': 'Nitrogen dioxide NO₂',
  'w.latency': 'Latency',
  'w.beaufortLevel': '{name} (force {level})',
  'w.unitC': '°C',
  'w.aqiAdvice': '{level} · {advice}',
  'w.noMap': 'Map off, coordinates-only mode',
  'w.todayMax': "Today's high",
  'w.todayMin': "Today's low",
  'w.daylight': 'Daylight',
  'w.night': 'Night',

  // ---------- UV / AQI advice ----------
  'uv.low.advice': 'No protection needed',
  'uv.moderate.advice': 'Wear a hat if you stay out long',
  'uv.high.advice': 'Use sunscreen and seek shade',
  'uv.very-high.advice': 'Avoid being outdoors at midday',
  'uv.extreme.advice': 'Full protection essential',
  'aqi.good.advice': 'Air quality is satisfactory',
  'aqi.fair.advice': 'Normal activity is fine',
  'aqi.moderate.advice': 'Sensitive groups should cut back on intense outdoor exercise',
  'aqi.poor.advice': 'Consider reducing time outdoors',
  'aqi.very-poor.advice': 'Sensitive groups should stay indoors',
  'aqi.extreme.advice': 'Avoid going out; wear a mask if you must',

  // ---------- Place search ----------
  // Search is the only way to "look somewhere else": without it the user can only see
  // where they stand (GPS) or places already favourited.
  // ★'search.failed' and 'search.empty' must stay TWO DIFFERENT sentences: collapsing them
  // into one "not found" disguises a timeout / offline state as "this place doesn't exist".
  'search.open': 'Search places',
  'search.close': 'Close search',
  'search.placeholder': 'Type a city or place',
  'search.minChars': 'Type at least {n} characters',
  'search.loading': 'Searching…',
  'search.empty': 'No such place found',
  'search.failed': 'Search failed — this is not "no such place"',
  'search.unnamed': '(unnamed)',

  // ---------- Self-check ----------
  'sc.title': 'Source self-check',
  'sc.subtitle': 'On-device re-check: samples each source serially, tiles judged by fingerprint de-duplication',
  'sc.networkType': 'Network type',
  'sc.networkType.hint': 'Browsers do not expose the real network type, pick one manually',
  'sc.net.wifi': 'WiFi',
  'sc.net.cellular': 'Cellular',
  'sc.net.unknown': 'Unknown',
  'sc.samples': 'Samples',
  'sc.run': 'Start check',
  'sc.running': 'Check running…',
  'sc.export': 'Export JSON',
  'sc.copy': 'Copy result',
  'sc.copyOk': 'Copied to clipboard, ready to paste',
  'sc.copyFail': 'Copy failed; the JSON is shown in the log area, long-press to select all',
  'sc.copyCompact': 'Copy compact',
  'sc.copyCompactOk': 'Copied compact version (~1.5 KB, long URLs and UA stripped), ready to paste',
  'sc.copyCompactFail': 'Copy failed; the compact JSON is shown in the log area, long-press to select all',
  'sc.sources': 'Sources',
  'sc.tiles': 'Tile fingerprints',
  'sc.log': 'Log',
  'sc.summary.pass': '{pass}/{total} passed',
  'sc.verdict.all-ok': 'All sources available',
  'sc.verdict.partial': 'Some sources unavailable',
  'sc.verdict.offline': 'Device is offline, no request was made',
  'sc.ms': '{ms} ms',
  'sc.latencyRange': 'Latency {min}–{max} ms',
  'sc.latencyP50': 'P50 {ms} ms',
  'sc.latencyAvg': 'Avg {ms} ms',
  'sc.httpStatus': 'HTTP {status}',
  'sc.bytes': '{bytes} B',
  'sc.fp': 'Fingerprint fp',
  'sc.fpShort': 'fp',
  'sc.fpAlgo': 'Algorithm {algo}',
  'sc.dedupeReal': 'Verdict: real ({styles} basemap styles each have distinct fingerprints — genuine tiles)',
  'sc.dedupeFake': 'Verdict: fake (within each of the {styles} styles the fingerprints are all identical — likely placeholders)',
  'sc.dedupeUnknown': 'Verdict: unknown (styles disagree or too few samples, {unique}/{total})',
  'sc.dedupeByStyle': '{label}: {unique}/{total} → {verdict}',
  'sc.mapMode': 'Basemap mode: {mode}',
  'sc.mapMode.map': 'Basemap available',
  'sc.mapMode.grid': 'Grid + coordinates only (some tiles failed, has not declared "no map")',
  'sc.mapMode.no-map': 'Coordinates only (basemap unavailable)',
  'sc.warmup': '1 warm-up sample (not counted)',
  'sc.sampleDone': 'Sample {i}/{n} done',
  'sc.exportName': 'geoscope-selfcheck-{stamp}.json',
  'sc.exportFail': 'Export failed: this browser does not support file download',
  'sc.offlineSkip': 'Device is offline, the check made no requests',
  'sc.tileOk': '{label} · {ms} ms · {bytes} B',
  'sc.tileFail': '{label} · failed · {message}',
  'sc.effectiveType': 'effectiveType: {value}',
  'sc.downlink': 'downlink: {value} Mb/s',
  'sc.userAgent': 'UA: {value}',

  // ---------- Bearing screen (WMM2025 declination + compass) ----------
  // Wording rule: state "the value the model computes" and "the model's validity window",
  // and NOTHING about accuracy. The WMM COF carries no error model and this module exports
  // no uncertainty field, so "±X° error" would be invented.
  'compass.title': 'Bearing · Magnetic declination',
  'compass.subtitle': 'Computed on device: WMM2025 geomagnetic model, no network',
  'compass.na': 'Not available',
  'compass.unavailable': 'Declination not available ({reason})',
  'compass.defaultPlaceNotice': 'No location fix, showing the default place',
  'compass.altitudeUnknown': 'Elevation unknown, using 0 m',
  'compass.calcNote': 'Values are computed by the model, not calibrated on site',

  'card.declination': 'Declination',
  'card.magnetic': 'Magnetic elements',
  'card.model': 'Model',
  'card.convert': 'True ↔ magnetic bearing',
  'card.compass': 'Compass',

  'compass.d': 'Declination D',
  'compass.i': 'Inclination I',
  'compass.f': 'Total field F',
  'compass.h': 'Horizontal component H',
  'compass.x': 'North component X',
  'compass.y': 'East component Y',
  'compass.z': 'Vertical component Z',
  // How to READ D: east is positive, so a negative number must read as "N° west";
  // showing a bare -7.49° is not a reading.
  'compass.east': '{deg}° east',
  'compass.west': '{deg}° west',
  'compass.noDeclination': 'Due north (no offset)',
  // The annual change is part of the model (symbolRates.dD, deg/year → arcmin/year);
  // it is not an accuracy figure.
  'compass.rateD': 'Declination changes about {min}′ per year',

  'compass.modelName': 'Model',
  'compass.modelEpoch': 'Epoch',
  'compass.modelRangeLabel': 'Valid for',
  'compass.modelSource': 'Source',
  'compass.modelDoi': 'DOI',
  'compass.modelRange': '{from} – {until}',
  'compass.modelOk': 'Within validity',
  'compass.modelLeft': 'About {years} years left',
  // Out of range / back-dated: the numbers still show, only the trust level drops here
  // (the card gets a warning state; nothing is hidden).
  'compass.modelExpired': 'About {years} years past validity, values are approximate only',
  'compass.modelAhead': 'About {years} years before the model epoch, this is a back-extrapolation',

  'compass.trueBearing': 'True bearing',
  'compass.magBearing': 'Magnetic bearing',
  'compass.inputTrueHint': 'Enter a true bearing (degrees)',
  'compass.inputMagHint': 'Enter a magnetic bearing (degrees)',
  'compass.resultPrefix': 'Result',
  'compass.convertHint': 'East is positive: true = magnetic + declination',
  'compass.inputInvalid': 'Please enter an angle (a number)',
  'compass.convertUnavailable': 'Declination unavailable, conversion cannot run',

  'compass.sensorUnsupported': 'No orientation sensor on this device · showing computed values and manual conversion only',
  'compass.sensorDenied': 'Orientation sensor not permitted · showing computed values and manual conversion only',
  'compass.sensorIdle': 'Orientation sensor off · showing computed values and manual conversion only',
  'compass.sensorWaiting': 'Sensor enabled, waiting for a reading…',
  'compass.sensorEnable': 'Enable orientation sensor',
  'compass.headingMag': 'Heading (magnetic) {deg}°',
  'compass.headingTrue': 'Heading (true) {deg}°',
  'compass.compassNote': 'The needle comes from the device sensor, it is not calibrated — for reference only',

  // ---------- Tile styles ----------
  'tile.street': 'Streets',
  'tile.imagery': 'Imagery',
  'tile.dark': 'Dark',

  // ---------- Basemap rendering (S57 street style / S58 GRID fallback) ----------
  'card.map': 'Basemap',
  'map.subtitle': '256 px tiles stitched by z/x/y · streets / imagery / dark',
  'map.zoom': 'z{zoom}',
  'map.trusted': 'Trusted',
  'map.untrusted': 'Not trusted',
  'map.cacheHit': 'Cache hit',
  'map.loading': 'Loading tiles',
  'map.blocks': '{ok}/{total} tiles',
  'map.detail': '{blocks} · {elapsed} · {tail}',
  'map.tailBlank': '{n} blank',
  'map.tailFailed': '{n} failed',
  'map.noMap': 'Basemap unavailable, switched to coordinates-only mode',
  'map.noMapNote': 'Coordinates and values are unaffected',
  'map.zoomIn': 'Zoom in',
  'map.zoomOut': 'Zoom out',
  'map.footnote': 'Tiles cached by URL for 7 days · requests only after you trust the source · 6 s timeout, no retry',
  'map.gridFootnote': 'Missing basemap tiles do not affect coordinates or values · grid still works offline',
  'map.credit': 'Basemap attribution',
  'map.skeletonNote': 'Tiles not in yet · skeleton first',

  // ---------- About & limits ----------
  'about.title': 'About & limits',
  'about.noCommercial': 'Not commercial: a personal tool. No ads, no third-party tracking, no accounts, no backend.',
  'about.noE2ee': 'No end-to-end encrypted sync: data lives only in this device\'s localStorage; moving it means exporting JSON.',
  'about.noAlert': 'No alerting data source bought: push alerts are out of scope for this stage.',
  // "six" is no longer accurate: the road-trip module added OSRM routing and Amap POI
  // (eight in total). Honesty rule — adding a source means updating this sentence,
  // otherwise the privacy promise itself becomes false.
  'about.privacy': 'Apart from the declared data sources (eight at present), this app contacts no other domain; your coordinates are not uploaded anywhere beyond those sources.',

  // ---------- Favorites ----------
  // A favourite is a PLACE, not a weather snapshot: it stores a name + lat/lon only.
  // The empty state must spell out the "favourite → backup" link — that link is the reason
  // favourites exist at all: data is local only, iOS can wipe PWA storage, and the backup
  // export is the one way out.
  'fav.title': 'Saved places',
  'fav.count': '{count} saved',
  'fav.hint': 'Saved places stay on this device and are never uploaded; they travel with a backup export and come back with an import.',
  'fav.empty': 'No saved places yet. On the Now screen, tap the star under the title to save the place you are looking at — saved places go out with your backup, and importing that JSON on a new phone restores them as they were.',
  // Button states (☆ / ★ are icons; the words themselves go through i18n)
  'fav.add': 'Save this place',
  'fav.added': 'Saved',
  // Short feedback after the tap; the "add" one repeats that a backup will carry it.
  'fav.addedHint': 'Saved · it will be included in your backup export',
  'fav.removedHint': 'Removed from saved places',
  'fav.delete': 'Delete',
  'fav.deleteOf': 'Delete saved place: {name}',
  'fav.go': 'See weather now',
  'fav.unnamed': 'Unnamed place',

  // ---------- Multi-place compare ----------
  // Entered from the Me screen (it is not a tab: the bottom bar is already at its limit on a
  // 320 px screen, a fifth item would push the four tabs onto two lines — a real bug seen on
  // a real device).
  // Rule: each place is fetched SEPARATELY (one request at a time). A place that fails is
  // marked failed on its own with "—" placeholders; data from elsewhere is never substituted.
  'compare.title': 'Compare places',
  'compare.subtitle': 'The same set of readings for each saved place, one card per place — read across a row to compare',
  'compare.entry': 'Compare saved places',
  'compare.entryBtn': 'Start comparison',
  'compare.hint': 'Every place needs its own request, and only one request goes out at a time — the more places you save, the longer you wait.',
  'compare.current': '{count} saved now',
  'compare.needFav': 'Save some places first: on the Now screen tap the star under the title, store the places you want to compare, then come back.',
  'compare.maxNote': 'You have more than {max} saved places; only the first {max} are compared. To compare others, delete the ones you do not need above.',
  'compare.summary': '{total} places · {ok} fetched · {failed} failed',
  'compare.summaryRunning': '{total} places · fetching number {done}…',
  'compare.offline': 'Device is offline, no request was made',
  'compare.allFailed': 'Not one of these {total} places returned data. The network may be down or a source may be temporarily unavailable — it does not mean these places have no weather.',
  'compare.rowFailed': 'No data for this place: {reason}',
  'compare.loading': 'Fetching…',
  'compare.refresh': 'Refresh',
  'compare.back': 'Back to Me',

  // ---------- Settings / Me ----------
  'settings.title': 'Me · Settings',
  'settings.subtitle': 'Backup and appearance: nothing leaves this device, both export and import happen locally.',

  'settings.exportTitle': 'Export backup',
  'settings.exportBtn': 'Export backup file',
  'settings.exportCurrent': 'Ready to export: default place {place} · {count} saved places · weather snapshot {snapshot}',
  'settings.snapshotYes': 'Saved',
  'settings.snapshotNo': 'None',
  'settings.exportDone': 'Exported {name}',
  'settings.exportFail': 'Export failed: this browser does not support file download',
  // exportBackup()'s JSDoc requires telling the user up front that the file carries location.
  // This line sits under the button permanently, it is not a toast that flashes after the tap —
  // the user must know before pressing.
  //
  // "With snapshot" and "without snapshot" must be two different sentences: the snapshot
  // embeds the LAST KNOWN COORDINATES (lat/lon, precise to a neighbourhood) plus four source
  // request URLs that carry the same coordinates — an order of magnitude more sensitive than
  // defaultPlace (which is usually the factory default and not the user's real location).
  // Checked against a real exported backup on 2026-10-12: the old wording buried the most
  // sensitive item inside four inconspicuous words.
  'settings.backupPrivacy': 'This file contains your location: the default place, {count} saved places, and the last known coordinates (latitude/longitude, precise enough to identify a neighbourhood) plus the weather and air data fetched at that time — the source links carry that same pair of coordinates. Exporting is offline and uploads nothing; the file goes only where you choose to save it. Do not send it to people casually.',
  'settings.backupPrivacyNoSnap': 'This file contains your location: the default place and {count} saved places. There is no weather snapshot this time, so it carries no coordinates. Exporting is offline and uploads nothing; the file goes only where you choose to save it. Do not send it to people casually.',

  'settings.importTitle': 'Import backup',
  'settings.importHint': 'Pick a geoscope-backup-*.json. Read what is inside before you decide — confirming overwrites this device\'s default place, saved places and last known coordinates.',
  'settings.importPick': 'Choose a backup file',
  'settings.importReady': 'Read {name}, contents below. Nothing on this device has changed yet.',
  'settings.pickFirst': 'Choose a backup file first.',
  'settings.previewTitle': 'What this backup holds',
  'settings.previewExportedAt': 'Exported at: {time}',
  'settings.previewPlace': 'Default place: {name}',
  'settings.previewFavorites': 'Saved places: {count}',
  'settings.previewDropped': '{count} of them will not be imported: invalid coordinates, duplicates, or beyond the 200-place cap.',
  'settings.previewNoPlace': 'Unnamed place',
  'settings.confirmBtn': 'Confirm import',
  'settings.confirmHint': 'This is the step that writes to this device and overwrites current data with what you see above.',
  'settings.importOk': 'Import done: default place {name} · {count} saved places',
  'settings.importFail': 'Import failed: {reason}',
  'settings.readFail': 'Could not read the file: {message}',
  'settings.readEmpty': 'The file is empty; it may not be a text-format backup.',

  'settings.themeTitle': 'Theme',
  'settings.themeHint': 'Follow system means your device\'s light/dark setting decides; once you pick one manually it sticks until you change it back.',
  'settings.theme.system': 'Follow system',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.themeDone': 'Theme set to {mode}',

  // ---------- Accessibility font scale ----------
  // The three tiers only change a multiplier (--fs-scale in styles/tokens.css); no colour
  // values and no --sp-* spacing are touched.
  // The hero temperature deliberately scales more slowly (--fs-hero-scale): it is already
  // four times body text, and scaling it equally breaks narrow screens. Say so honestly
  // rather than vaguely promising "enlarge everything".
  'settings.fontTitle': 'Text size',
  'settings.fontHint': 'Three tiers enlarge text across the app. That big temperature grows more slowly: it is already four times body text, and scaling it equally would break narrow screens.',
  'settings.font.normal': 'Default',
  'settings.font.large': 'Large',
  'settings.font.xlarge': 'Largest',
  'settings.fontDone': 'Text size set to {mode}',

  // ---------- Export CSV ----------
  // Same rule as the backup JSON privacy note: say up front what is exported and how
  // missing values are represented.
  // Note in particular "missing is blank, never 0" — the UI shows a placeholder "—" but in a
  // CSV that makes Excel treat the whole column as text, which kills the numeric columns;
  // blank is the spreadsheet way of saying "no data here".
  'settings.csvTitle': 'Export CSV',
  'settings.csvHint': 'Export the latest Now reading as a spreadsheet. UTF-8 with BOM so Excel opens it without mojibake; one row per observation, missing values left blank (not 0).',
  'settings.csvBtn': 'Export CSV file',
  'settings.csvCurrent': 'Ready to export: {time} · {place}',
  'settings.csvNone': 'Ready to export: no data yet',
  'settings.csvEmpty': 'Nothing to export yet — open the Now screen once and it will save a snapshot to this device.',
  'settings.csvDone': 'Exported {name}',
  'settings.csvFail': 'Export failed: this browser does not support file download',
  'settings.csvNoSnapshot': 'No snapshot to export',

  // CSV headers (consumed by core/csv.js): every column maps to a number you can see on
  // screen; no column may hold a quantity that is not on screen.
  // The two time columns state their timezone on purpose: export time is device-local like
  // the filename, observation time is local to the queried place. When you look up somewhere
  // else these two legitimately differ; not saying so reads as a bug.
  'csv.h.exportedAt': 'Exported at (device)',
  'csv.h.observedAt': 'Observed at (local)',
  'csv.h.place': 'Place',
  'csv.h.lat': 'Latitude (deg)',
  'csv.h.lon': 'Longitude (deg)',
  'csv.h.elevation': 'Elevation (m)',
  'csv.h.temp': 'Temperature (°C)',
  'csv.h.feels': 'Feels like (°C)',
  'csv.h.humidity': 'Humidity (%)',
  'csv.h.precip': 'Precipitation (mm)',
  'csv.h.windSpeed': 'Wind speed (m/s)',
  'csv.h.windDir': 'Wind direction',
  'csv.h.beaufort': 'Beaufort force',
  'csv.h.pressure': 'Pressure (hPa)',
  'csv.h.visibility': 'Visibility (m)',
  'csv.h.weather': 'Conditions',
  'csv.h.wmoCode': 'WMO code',
  'csv.h.sunrise': 'Sunrise',
  'csv.h.sunset': 'Sunset',
  'csv.h.dayLength': 'Day length (min)',
  'csv.h.uv': 'UV index',
  'csv.h.uvLevel': 'UV band',
  'csv.h.todayMax': "Today's high (°C)",
  'csv.h.todayMin': "Today's low (°C)",
  'csv.h.aqi': 'European AQI',
  'csv.h.aqiLevel': 'AQI band',
  'csv.h.pm10': 'PM10 (µg/m³)',
  'csv.h.pm25': 'PM2.5 (µg/m³)',
  'csv.h.ozone': 'Ozone (µg/m³)',
  'csv.h.no2': 'NO₂ (µg/m³)',
  'csv.h.declination': 'Declination (deg, east positive)',
  'csv.h.sources': 'Data sources',

  // ---------- Legend / what the numbers mean ----------
  // "What the numbers mean" is a collapsible panel at the bottom of the Now screen that
  // explains the specialist figures in plain language.
  // ★Threshold discipline (read before editing): wherever a BAND NUMBER appears below it is
  //   READ OUT of src/core/wmo.js's existing tables by src/ui/legend.js — no threshold is
  //   hard-coded here. Copying numbers in would mean the legend silently lies the day the
  //   table changes.
  //   Metrics with no band in the code (temperature / humidity / pressure / visibility /
  //   pollutant concentration / elevation / coordinates / timezone) state "what it is + unit"
  //   only and are honestly marked with legend.noScale.
  'legend.title': 'What the numbers mean',
  'legend.open': 'Show explanations',
  'legend.close': 'Hide explanations',
  'legend.note': 'Each entry below matches a number on screen. Bands are listed only for the scales this app actually implements (Beaufort force, European AQI, the five UV bands, the 16-point wind rose); the rest get a description and a unit, no invented standard.',
  'legend.noScale': 'This app sets no bands for this one, it shows the value and unit only.',

  'legend.group.weather': 'Weather',
  'legend.group.air': 'Air',
  'legend.group.place': 'Place and time',

  'legend.temp.title': 'Temperature',
  'legend.temp.unit': '°C',
  'legend.temp.body': 'Air temperature 2 m above ground, from the source\'s temperature_2m.',

  'legend.feels.title': 'Feels like',
  'legend.feels.unit': '°C',
  'legend.feels.body': 'The apparent temperature the source reports (apparent_temperature): it folds wind and humidity into the air temperature. It is computed, not a second measurement — higher than the air temperature in summer and lower in winter is both normal.',

  'legend.humidity.title': 'Relative humidity',
  'legend.humidity.unit': '%',
  'legend.humidity.body': 'Actual vapour pressure as a share of the saturation vapour pressure at the same temperature (relative_humidity_2m). 100% means saturated, at which point fog or dew becomes likely.',

  'legend.precip.title': 'Precipitation',
  'legend.precip.unit': 'mm',
  'legend.precip.body': 'Precipitation accumulated in the current hour (precipitation), in millimetres. This is how much has fallen, not whether it will — for that see the next entry.',

  'legend.pop.title': 'Chance of rain',
  'legend.pop.unit': '%',
  'legend.pop.body': 'The probability of precipitation in the current hour (precipitation_probability), as a percentage. It is an HOURLY figure; the screen shows the hour that lines up with "Observed at". When it cannot be fetched the placeholder "—" is shown, never 0% — 0% means "it will definitely not rain", which is not the same as "we do not know".',

  'legend.wind.title': 'Wind speed',
  'legend.wind.unit': 'm/s',
  'legend.wind.body': 'Wind speed at 10 m above ground (wind_speed_10m) in metres per second; the screen also shows the km/h conversion (1 m/s = 3.6 km/h).',

  'legend.beaufort.title': 'Beaufort force',
  'legend.beaufort.unit': 'force',
  'legend.beaufort.body': 'Wind speed split into forces 0–12; this is where "Moderate breeze (force 4)" on screen comes from. Names and thresholds are read from this app\'s own conversion table:',
  'legend.beaufort.row': 'Force {level} · {name} · under {max} m/s',
  'legend.beaufort.rowLast': 'Force {level} · {name} · {min} m/s and above',

  'legend.winddir.title': 'Wind direction',
  'legend.winddir.unit': '°',
  'legend.winddir.body': 'The direction the wind comes FROM (wind_direction_10m), cut into 16 points of 22.5° each. "North-northwest wind" means it blows from the north-northwest, not towards it:',
  'legend.winddir.row': '{dir}',

  'legend.pressure.title': 'Pressure',
  'legend.pressure.unit': 'hPa',
  'legend.pressure.body': 'Surface pressure (surface_pressure) in hectopascals. It moves with elevation and weather systems; a single absolute value means little on its own.',

  'legend.visibility.title': 'Visibility',
  'legend.visibility.unit': 'm / km',
  'legend.visibility.body': 'The furthest distance you can see horizontally (visibility). Below 1000 m it is shown in metres; from 1000 m up it is converted to kilometres with one decimal.',

  'legend.uv.title': 'UV index',
  'legend.uv.unit': 'no unit',
  'legend.uv.body': 'The day\'s maximum UV index (uv_index_max), a unitless index. The five bands and their advice come from this app\'s existing conversion table:',
  'legend.uv.row': '{min}–{max} · {name} · {advice}',
  'legend.uv.rowLast': '{min} and above · {name} · {advice}',

  'legend.sun.title': 'Sunrise and sunset',
  'legend.sun.unit': 'local time',
  'legend.sun.body': 'Given by the source in local time (daily.sunrise / sunset). When the source omits them, the on-device NOAA algorithm is used instead.',

  'legend.dayLength.title': 'Day length',
  'legend.dayLength.unit': 'h · min',
  'legend.dayLength.body': 'Sunset minus sunrise, i.e. how long daylight lasts. Around midnight sun or polar night the source may omit both times, and then the placeholder "—" is shown.',

  'legend.today.title': "Today's high / low",
  'legend.today.unit': '°C',
  'legend.today.body': "The day's maximum and minimum temperature from the source (temperature_2m_max / _min). These are FORECASTS for the whole day, not a reading taken right now.",

  'legend.wmo.title': 'Conditions',
  'legend.wmo.unit': 'WMO code',
  'legend.wmo.body': 'The icon and description are translated from a WMO weather code (0–99; for example 0 is clear, 61 is light rain). When the code is missing or invalid it says "Unknown" — "no data" is never reported as clear sky.',

  'legend.observedAt.title': 'Observed at',
  'legend.observedAt.unit': 'local time',
  'legend.observedAt.body': 'The time step the source reports for the current data, converted to local time using the local offset.',

  'legend.aqi.title': 'European AQI',
  'legend.aqi.unit': 'no unit',
  'legend.aqi.body': 'The European AQI as the source reports it (european_aqi): several pollutants folded into one number, lower is better. This app only splits it into six bands — the bands and advice follow:',
  'legend.aqi.row': '{min}–{max} · {name} · {advice}',
  'legend.aqi.rowLast': '{min} and above · {name} · {advice}',

  'legend.pollutants.title': 'PM2.5 / PM10 / O₃ / NO₂',
  'legend.pollutants.unit': 'µg/m³',
  'legend.pollutants.body': 'Four pollutant concentrations in micrograms per cubic metre. This app does not grade individual pollutants — grading applies to the European AQI above, and these four are its inputs, so no bands are given here either.',

  'legend.elevation.title': 'Elevation',
  'legend.elevation.unit': 'm',
  'legend.elevation.body': 'Elevation at this place (Open-Meteo Elevation) in metres. When it cannot be fetched the placeholder "—" is shown.',

  'legend.coord.title': 'Coordinates',
  'legend.coord.unit': 'degrees (WGS84)',
  'legend.coord.body': 'WGS84 latitude and longitude to four decimals (about 11 m). Saving a place and jumping between screens both use these two numbers as the place\'s identity.',

  'legend.tz.title': 'Timezone offset',
  'legend.tz.unit': 'seconds',
  'legend.tz.body': 'The offset of local time from UTC as the source returns it (utc_offset_seconds). Sunrise, sunset and observation time are all converted with it — change it and those times move too.',

  // ---------- WMO weather codes ----------
  // core/wmo.js's wmo(code) returns only { key, shortKey, icon } — never an English string,
  // because core may not read a locale table. These 28 pairs are turned into words by the UI
  // layer via t(). full is used in the legend and the CSV; short in tight spots such as the
  // hero subline and the compare screen.
  'wmo.0': 'Clear sky',
  'wmo.0.short': 'Clear',
  'wmo.1': 'Mainly clear',
  'wmo.1.short': 'Mainly clear',
  'wmo.2': 'Partly cloudy',
  'wmo.2.short': 'Cloudy',
  'wmo.3': 'Overcast',
  'wmo.3.short': 'Overcast',
  'wmo.45': 'Fog',
  'wmo.45.short': 'Fog',
  'wmo.48': 'Depositing rime fog',
  'wmo.48.short': 'Rime fog',
  'wmo.51': 'Light drizzle',
  'wmo.51.short': 'Drizzle',
  'wmo.53': 'Moderate drizzle',
  'wmo.53.short': 'Drizzle',
  'wmo.55': 'Dense drizzle',
  'wmo.55.short': 'Drizzle',
  'wmo.56': 'Light freezing drizzle',
  'wmo.56.short': 'Freezing drizzle',
  'wmo.57': 'Dense freezing drizzle',
  'wmo.57.short': 'Freezing drizzle',
  'wmo.61': 'Slight rain',
  'wmo.61.short': 'Light rain',
  'wmo.63': 'Moderate rain',
  'wmo.63.short': 'Rain',
  'wmo.65': 'Heavy rain',
  'wmo.65.short': 'Heavy rain',
  'wmo.66': 'Light freezing rain',
  'wmo.66.short': 'Freezing rain',
  'wmo.67': 'Heavy freezing rain',
  'wmo.67.short': 'Freezing rain',
  'wmo.71': 'Slight snow fall',
  'wmo.71.short': 'Light snow',
  'wmo.73': 'Moderate snow fall',
  'wmo.73.short': 'Snow',
  'wmo.75': 'Heavy snow fall',
  'wmo.75.short': 'Heavy snow',
  'wmo.77': 'Snow grains',
  'wmo.77.short': 'Snow grains',
  'wmo.80': 'Slight rain showers',
  'wmo.80.short': 'Showers',
  'wmo.81': 'Moderate rain showers',
  'wmo.81.short': 'Showers',
  'wmo.82': 'Violent rain showers',
  'wmo.82.short': 'Torrential',
  'wmo.85': 'Slight snow showers',
  'wmo.85.short': 'Snow showers',
  'wmo.86': 'Heavy snow showers',
  'wmo.86.short': 'Snow showers',
  'wmo.95': 'Thunderstorm',
  'wmo.95.short': 'Thunderstorm',
  'wmo.96': 'Thunderstorm with slight hail',
  'wmo.96.short': 'Thunder, hail',
  'wmo.99': 'Thunderstorm with heavy hail',
  'wmo.99.short': 'Severe thunder, hail',
  // Unknown-code fallback: ★must mean "no data", never "clear".
  'wmo.unknown': 'Unknown conditions',
  'wmo.unknown.short': 'Unknown',

  // ---------- Beaufort forces 0–12 ----------
  'bf.0': 'Calm',
  'bf.1': 'Light air',
  'bf.2': 'Light breeze',
  'bf.3': 'Gentle breeze',
  'bf.4': 'Moderate breeze',
  'bf.5': 'Fresh breeze',
  'bf.6': 'Strong breeze',
  'bf.7': 'Near gale',
  'bf.8': 'Gale',
  'bf.9': 'Strong gale',
  'bf.10': 'Storm',
  'bf.11': 'Violent storm',
  'bf.12': 'Hurricane force',

  // ---------- 16-point wind rose ----------
  // full is used in the legend (spell it out), abbr on the Now screen next to the number
  // (keep it short). The two differ in English; in Chinese they were both the full name,
  // because Chinese has no shorter conventional abbreviation that reads better.
  'dir.0': 'North',
  'dir.0.abbr': 'N',
  'dir.1': 'North-northeast',
  'dir.1.abbr': 'NNE',
  'dir.2': 'Northeast',
  'dir.2.abbr': 'NE',
  'dir.3': 'East-northeast',
  'dir.3.abbr': 'ENE',
  'dir.4': 'East',
  'dir.4.abbr': 'E',
  'dir.5': 'East-southeast',
  'dir.5.abbr': 'ESE',
  'dir.6': 'Southeast',
  'dir.6.abbr': 'SE',
  'dir.7': 'South-southeast',
  'dir.7.abbr': 'SSE',
  'dir.8': 'South',
  'dir.8.abbr': 'S',
  'dir.9': 'South-southwest',
  'dir.9.abbr': 'SSW',
  'dir.10': 'Southwest',
  'dir.10.abbr': 'SW',
  'dir.11': 'West-southwest',
  'dir.11.abbr': 'WSW',
  'dir.12': 'West',
  'dir.12.abbr': 'W',
  'dir.13': 'West-northwest',
  'dir.13.abbr': 'WNW',
  'dir.14': 'Northwest',
  'dir.14.abbr': 'NW',
  'dir.15': 'North-northwest',
  'dir.15.abbr': 'NNW',
  // Wind direction is where the wind comes FROM. Chinese uses a "wind" suffix, English uses
  // a preposition — the two languages order it differently, so the whole phrase is one
  // template and only the point name is interpolated.
  'w.windFrom': 'wind from {dir}',

  // ---------- Band names (six European AQI bands / five UV bands) ----------
  'level.aqi.good': 'Good',
  'level.aqi.fair': 'Fair',
  'level.aqi.moderate': 'Moderate',
  'level.aqi.poor': 'Poor',
  'level.aqi.very-poor': 'Very poor',
  'level.aqi.extreme': 'Extremely poor',
  'level.uv.low': 'Low',
  'level.uv.moderate': 'Moderate',
  'level.uv.high': 'High',
  'level.uv.very-high': 'Very high',
  'level.uv.extreme': 'Extreme',

  // ---------- Durations / relative time / staleness ----------
  // The three core/format.js functions emit only a structured { unit, value }; the whole
  // phrase is translated here — Chinese and English order these differently
  // ("10 小时 32 分" vs "10h 32m", "3 分钟前" vs "3 min ago"), so assembling from fragments
  // is wrong. Only numbers are interpolated.
  'fmt.duration.hm': '{h}h {m}m',
  'fmt.duration.m': '{m}m',
  'fmt.ago.now': 'just now',
  'fmt.ago.minute': '{n} min ago',
  'fmt.ago.hour': '{n} h ago',
  'fmt.ago.day': '{n} d ago',
  'fmt.ago.month': '{n} mo ago',
  'fmt.stale.second': '{n} s',
  'fmt.stale.minute': '{n} min',
  'fmt.stale.hour': '{n} h',
  'fmt.stale.day': '{n} d',

  // ---------- Default place name ----------
  // core/geo.js and core/store.js store only the coordinates plus a stable marker name; the
  // display name comes from here — core may not read a locale table, but this is a place
  // name, and on an English screen it has to read "Beijing · Tian'anmen".
  'place.default': "Beijing · Tian'anmen",

  // ---------- Per-page <meta> and screen-reader labels ----------
  // Spots in the HTML shell with NO child element (meta description / iOS home-screen
  // name) plus the aria-labels a screen reader reads out. All of them are visible to
  // somebody — some just via the ears — so they go through i18n too.
  'app.shortName': 'GeoScope',
  'app.description': 'GeoScope — a personal weather and place glance: one screen of data, here and now.',
  'desc.selfcheck': 'GeoScope — source self-check: sample each source and see which ones answer.',
  'desc.compass': 'GeoScope — magnetic declination and true/magnetic bearing conversion, computed on device with WMM2025, offline.',
  'desc.settings': 'GeoScope — backup export and import, theme switching; data stays on this device, no network.',
  'desc.compare': 'GeoScope — compare places: the same readings for each saved place, side by side.',
  'desc.roadtrip': 'GeoScope — road trip: route planning, trip log and the trip map.',
  'a11y.mainNav': 'Main navigation',
  'a11y.checkParams': 'Self-check parameters',
  // ---------- Interface language ----------
  // The switch lives on the Me screen. ★each option is written in ITS OWN language
  // (the Chinese screen shows "English", not an-English-word-for-Chinese) — when a user
  // cannot read the current interface language, the one thing that can save them is the
  // option labelled in their own tongue.
  'settings.langTitle': 'Language',
  'settings.langHint': 'Switches the language of the whole interface. Place names and figures are unaffected — they come from the data sources as they are.',
  'settings.lang.zh': '中文',
  'settings.lang.en': 'English',
  'settings.langDone': 'Language set to {name}',

  // ---------- Source attribution ----------
  // Attribution is legally required text: the service name and the licence name
  // (CC-BY 4.0 / ODbL) are never translated, only the connective wording follows
  // the interface language. Parenthesis style follows each language's own habit.
  'attr.openmeteo': 'Open-Meteo.com (CC-BY 4.0)',
  'attr.photon': 'Photon by Komoot (based on OpenStreetMap, ODbL)',
  'attr.tile': 'Esri ArcGIS Online World Tile Service',
  'attr.osrm': 'OSRM (based on OpenStreetMap, ODbL)',
  'attr.amap': 'Amap Web Service API',

  // ---------- Road trip: the two new sources ----------
  'source.osrmRoute': 'Routing (OSRM public instance)',
  'source.amapPoi': 'Place candidates (Amap Web Service)',

  // ---------- Road trip: failure buckets (translated at the data layer, shown by the UI) ----------
  // These must be SPECIFIC: Amap reports business failures as HTTP 200 with status:"0",
  // and bucketing exists so the user knows what to do next (replace the key / wait until
  // tomorrow / retry later / turn signing off). A generic "request failed" says nothing.
  // {code} is numeric, so it reads the same in both languages.
  'rt.amap.noKey': 'Amap key is not set',
  'rt.amap.invalidKey': 'Amap key is invalid or expired (code {code})',
  'rt.amap.quota': "today's quota is used up (code {code})",
  'rt.amap.busy': 'too many requests (code {code}); please try again later',
  'rt.amap.sig': 'turn off digital signature in the console and retry (code {code})',
  'rt.amap.other': 'Amap returned an error (code {code})',
  'rt.err.noRoute': 'no route could be calculated (OSRM returned {code})',
  'rt.err.zeroDistance': 'the calculated route distance is 0: the coordinates may be somewhere without roads',
  'rt.err.noGeometry': 'OSRM returned no route geometry',
  'rt.err.needMorePoints': 'at least 2 coordinates are needed to calculate a route (got {n})',
  'rt.err.badAnchor': 'the candidate search centre coordinates are invalid',

  // ---------- Road trip: page copy (T03 page shell + two settings cards) ----------
  'rt.title': 'Road trip',
  'rt.subtitle': 'Plan routes and stops, log what you actually did, draw the trip map',
  'rt.back': 'Back to "Me"',
  'rt.empty': 'This build is only the entry point',
  'rt.emptyHint': 'Route planning, the trip log and the map are not built yet — they will start from this page. Nothing here sends a request right now.',
  'rt.entry': 'Road trip',
  'rt.entryBtn': 'Open road trip',
  'rt.entryHint': 'From start to destination, plan stops at 3–5 hours of driving per day, and log the places you actually stayed, visited and ate at.',
  'rt.keyTitle': 'Amap key',
  'rt.keyHint': 'Lodging / sight / food candidates come from Amap search, which needs your own key (the personal verified tier has a free quota). Routing and the map work without it — only candidates come up empty.',
  'rt.keyPlaceholder': 'Paste your Amap web service key',
  'rt.keySave': 'Save',
  'rt.keyClear': 'Clear',
  'rt.keyCheck': 'Verify (sends a real request, uses quota)',
  // ★Not "1 call": amapPoi has retry = 1. A business failure (HTTP 200 with status:"0")
  //   does not retry, but a **transport** timeout does — so at most 2 calls.
  //   Hard-coding "1" is true on the happy path and false on the timeout path.
  'rt.keyCheckHint': 'Normally 1 call; a timeout retries once, so at most 2.',
  'rt.keyChecking': 'Verifying…',
  'rt.keyOk': 'Key works: this search returned {count} candidates',
  'rt.keyOkZero': 'Key works (this search returned 0 candidates — the coordinates or category may be too narrow)',
  'rt.keyCurrent': 'Current: {mask}',
  'rt.keyNone': 'Current: not set',
  'rt.keySaved': 'Saved ({mask})',
  'rt.keyCleared': 'Cleared',
  'rt.keyBad': 'Not saved: the key is empty, longer than {max} characters, or contains whitespace',
  'rt.keyClearFail': 'Nothing was set, so there is nothing to clear',
  'rt.keyStored': 'The key stays on this device only — it is not written into backups and never uploaded.',

  // ---------- Road trip: trip import failure reasons ----------
  // core/roadtrip.js and core/tripstore.js return only reasonKey / reasonParams
  // (core may not import i18n); the UI translates them.
  'trip.badJson': 'not valid JSON',
  'trip.notObject': 'the trip body is not a JSON object',
  'trip.badSchema': 'unsupported trip file schema version (schema={schema})',
  'trip.newerSchema': 'this trip was created by a newer version (schema={schema}); please upgrade before opening it',
  'trip.notRoadtrip': 'not a GeoScope road-trip file',
  'trip.noTrips': 'the file has no trips array',
  'trip.planNoTrips': 'the import plan has no trips array (call inspectTripFile first)',
  'trip.notFound': 'this trip does not exist',

  // ---------- Backup import failure reasons ----------
  // core/backup.js returns only reasonKey / reasonParams (core may not import i18n);
  // the UI splices them into settings.importFail's {reason}.
  'backup.badJson': 'not valid JSON',
  'backup.notObject': 'the backup body is not a JSON object',
  'backup.badSchema': 'unsupported backup schema version (schema={schema})',
  'backup.notGeoscope': 'not a GeoScope backup file',
  'backup.noPrefs': 'missing prefs',
  'backup.badDefaultPlace': 'defaultPlace coordinates are invalid (lat/lon must be finite numbers, latitude within ±90, longitude within ±180)',
  'backup.planNoDefaultPlace': 'the import plan has no valid defaultPlace (call inspectBackup first)',
  'backup.planNoFavorites': 'the import plan has no favorites array (call inspectBackup first)',
  'backup.writeFailed': 'failed to write local state: {msg}',

  // ---------- Invalid tile coordinates ----------
  // The data layer MAY import i18n (only core may not), so this one is translated
  // right where it is thrown.
  'tile.badCoord': 'invalid tile coordinates (z={z}, x={x}, y={y}); no request was sent',
};
