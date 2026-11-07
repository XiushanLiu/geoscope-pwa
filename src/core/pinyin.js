/**
 * 拼音 → 中文地名映射（高频县/镇/村/城市）
 *
 * 1) 上游（Open-Meteo / GeoNames）**本身就支持拼音查询** —— 2026-11-07 实测
 *    `wuzhen`→乌镇、`beijing`→北京、`shaoxing`→绍兴市、`huaxicun`→华西村。
 *    （v95 的首版注释写的是「上游对拼音输入 0 条」，那是错的，已实测推翻。）
 * 2) 所以本表不是「拼音查不到时的唯一出路」，而是**精度与容错**：
 *    · 拼音同名多国（`dali` 可能先命中境外同名地）时，映射回中文能锚定中国地名；
 *    · 带空格/连字符的分词拼音（`heng dian`）上游查不到，本表能归一后命中。
 * 3) 仍只收实测过的：没验证过的拼音不放 —— 错映射比不映射更糟。
 * 4) 拼音带行政后缀照样 0 条（实测 `wuzhenzhen` 空、「乌镇镇」空），所以反查会先去后缀。
 * ★键必须是「小写、无空格、无声调」的归一形态 —— 查表前会把空格/连字符/下划线
 *   全部去掉，写成 `'heng dian'` 的键永远命中不了（v95 就踩过这个坑）。
 *
 * 覆盖原则：
 *   ① 知名县/镇/村（上游有中文条目，但拼音 0 条）
 *   ② 热门城市（上游有，但拼音输入方便）
 *   ③ 不造生僻词——没实测的不放
 */

const PINYIN_TABLE = {
  // —— 县/镇/村（上游有中文，拼音 0 条）——
  'wuzhen': '乌镇',
  'huaxicun': '华西村',
  'hengdian': '横店',
  'hengdianzhen': '横店镇',
  'zhouzhuang': '周庄',
  'tongli': '同里',
  'xidi': '西递',
  'hongcun': '宏村',
  'fenghuang': '凤凰',
  'lijiang': '丽江',
  'dali': '大理',
  'yangshuo': '阳朔',
  'pingyao': '平遥',
  'wuyuan': '婺源',
  'wuyishan': '武夷山',
  'zhangjiajie': '张家界',
  'jiuzhaigou': '九寨沟',
  'huangshan': '黄山',
  'guilin': '桂林',
  'sanya': '三亚',

  // —— 城市（上游有，但拼音输入高频）——
  'beijing': '北京',
  'shanghai': '上海',
  'guangzhou': '广州',
  'shenzhen': '深圳',
  'hangzhou': '杭州',
  'nanjing': '南京',
  'chengdu': '成都',
  'chongqing': '重庆',
  'wuhan': '武汉',
  'xian': '西安',
  'tianjin': '天津',
  'suzhou': '苏州',
  'xiamen': '厦门',
  'qingdao': '青岛',
  'dalian': '大连',
  'kunming': '昆明',
  'changsha': '长沙',
  'zhengzhou': '郑州',
  'jinan': '济南',
  'fuzhou': '福州',
  'hefei': '合肥',
  'nanchang': '南昌',
  'guiyang': '贵阳',
  'nanning': '南宁',
  'haikou': '海口',
  'taiyuan': '太原',
  'shijiazhuang': '石家庄',
  'harbin': '哈尔滨',
  'changchun': '长春',
  'shenyang': '沈阳',
  'hohhot': '呼和浩特',
  'yinchuan': '银川',
  'xining': '西宁',
  'urumqi': '乌鲁木齐',
  'lhasa': '拉萨',
  'lanzhou': '兰州',
};

/**
 * 归一化：trim + 小写 + 去掉空格/连字符/下划线。
 *
 * @param {string} s 原始输入。
 * @returns {string} 归一后的键。
 */
function _norm(s) {
  return String(s).trim().toLowerCase().replace(/[\s\-_]+/g, '');
}

/** 反向索引（中文 → 拼音），惰性构建：避免每次反查都遍历全表。 */
let _reverse = null;

/**
 * @returns {Map<string,string>} 中文 → 拼音。
 */
function _reverseTable() {
  if (!_reverse) {
    _reverse = new Map();
    // 同一个中文若有多个拼音键，保留先登记的（表内顺序即优先级）
    for (const [py, zh] of Object.entries(PINYIN_TABLE)) {
      if (!_reverse.has(zh)) _reverse.set(zh, py);
    }
  }
  return _reverse;
}

/**
 * 拼音转中文地名。
 *
 * @param {string} input 输入（任意大小写、可含空格/连字符）。
 * @returns {string|null} 中文地名；无映射时 null。
 */
export function pinyinToChinese(input) {
  if (!input || typeof input !== 'string') return null;
  return PINYIN_TABLE[_norm(input)] || null;
}

/**
 * 中文地名转拼音（用于兜底查询：用户输入中文，同时发拼音版本给上游）。
 *
 * ★带行政后缀的词先按原词查，查不到再去后缀重查（乌镇镇 → 乌镇 → wuzhen），
 *   否则「XX镇」「XX村」这类最需要拼音兜底的地名恰恰拿不到兜底词。
 *
 * @param {string} chinese 中文地名。
 * @returns {string|null} 拼音（小写、无空格）；无映射时 null。
 */
export function chineseToPinyin(chinese) {
  if (!chinese || typeof chinese !== 'string') return null;
  const rev = _reverseTable();
  const key = chinese.trim();
  if (rev.has(key)) return rev.get(key);
  const bare = key.replace(/(市|区|县|镇|乡|村)$/, '');
  if (bare !== key && bare.length >= 2 && rev.has(bare)) return rev.get(bare);
  return null;
}

/**
 * 判断输入是否像拼音：纯 ASCII 字母，或「两段字母 + 一个空格/连字符」的分词拼音
 * （如 `heng dian`）。每段至少 2 个字母。
 *
 * @param {string} input 输入。
 * @returns {boolean} 是否像拼音。
 */
export function looksLikePinyin(input) {
  if (!input || typeof input !== 'string') return false;
  const s = input.trim();
  return /^[a-zA-Z]{2,}$/.test(s) || /^[a-zA-Z]{2,}[\s-][a-zA-Z]{2,}$/.test(s);
}
