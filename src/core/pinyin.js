/**
 * 拼音 → 中文地名映射（高频县/镇/村/城市）
 *
 * 只放实测过的：上游 geocoding 对拼音输入 0 条，但用户可能直接打拼音。
 * 键必须小写、无空格、无声调。
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
  'heng dian': '横店',
  'heng dian zhen': '横店镇',
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
 * 拼音转中文地名。
 *
 * @param {string} input 输入（任意大小写、可含空格/连字符）。
 * @returns {string|null} 中文地名；无映射时 null。
 */
export function pinyinToChinese(input) {
  if (!input || typeof input !== 'string') return null;
  const key = input.trim().toLowerCase().replace(/[\s\-_]+/g, '');
  return PINYIN_TABLE[key] || null;
}

/**
 * 中文地名转拼音（用于兜底查询：用户输入中文，同时发拼音版本给上游）。
 *
 * 只处理高频词，生僻词返回 null。
 *
 * @param {string} chinese 中文地名。
 * @returns {string|null} 拼音（小写、无空格）；无映射时 null。
 */
export function chineseToPinyin(chinese) {
  if (!chinese || typeof chinese !== 'string') return null;
  const key = chinese.trim();
  for (const [py, zh] of Object.entries(PINYIN_TABLE)) {
    if (zh === key) return py;
  }
  return null;
}

/**
 * 判断输入是否像拼音（纯 ASCII 字母、无空格、长度 >= 2）。
 *
 * @param {string} input 输入。
 * @returns {boolean} 是否像拼音。
 */
export function looksLikePinyin(input) {
  if (!input || typeof input !== 'string') return false;
  const s = input.trim();
  return /^[a-zA-Z]+$/.test(s) && s.length >= 2;
}
