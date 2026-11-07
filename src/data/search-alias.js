/**
 * 地名搜索别名表（**唯一数据源**）
 *
 * 职责：把「用户可能输入的写法」映射到「上游地理编码能命中的写法」。
 *   ★2026-11 v99 收口：此前同一张表存在两份 —— 同名 `search-alias.json`（已删除）
 *   与 `src/ui/placesearch.js` 里的内置副本，靠 "JSON 加载失败回退内置表" 兜底。
 *   两份同时维护必然漂移（改一处忘另一处，线上与离线给出不同的搜索结果），
 *   因此删除 JSON，只保留本模块；顺带省掉一次运行时 fetch、3 s 超时与离线降级分支。
 *
 * 约定：
 *   - 键必须**小写**（查表前输入已 trim + toLowerCase）；
 *   - 值是候选写法数组，按优先级排列，第一个通常是最可能命中的英文全名；
 *   - 只收录**实测过**的条目（上游 0 条 / 命中错误条目才值得收），不凭猜测添加。
 *
 * 依赖：无（纯数据模块，不 import 任何东西），ui 层可直接 import。
 */

/** 别名表：小写关键词 → 上游可命中的写法数组。 */
export const ALIAS_TABLE = {
  // —— 城市缩写（用户最可能输入的）——
  'la': ['Los Angeles', '洛杉矶', '洛杉磯'],
  'l.a.': ['Los Angeles', '洛杉矶', '洛杉磯'],
  'sf': ['San Francisco', '旧金山', '舊金山'],
  'nyc': ['New York City', '纽约市', '紐約市'],

  // —— 美国州两字母缩写 → 该州最大城市（上游几乎全废，必须兜底）——
  //   实测：NY→比利时 Ny 村、CA→印尼、NJ→0 条、TX→0 条… 用户要的是州，
  //   但 GeoNames 没建州索引；按「该州最大城市」返回，比空结果/外国小村诚实。
  //   ★注意歧义：`la` 已被上面洛杉矶占用；`me`（缅因）、`in`（印第安纳）、`or`
  //   （俄勒冈）同时是英文常用词，但城市人口会盖过同名词条，仍收录。
  'ny': ['New York City'], 'ca': ['Los Angeles'], 'tx': ['Houston'], 'fl': ['Miami'],
  'il': ['Chicago'], 'pa': ['Philadelphia'], 'oh': ['Columbus'], 'ga': ['Atlanta'],
  'nc': ['Charlotte'], 'mi': ['Detroit'], 'nj': ['Newark'], 'va': ['Virginia Beach'],
  'wa': ['Seattle'], 'az': ['Phoenix'], 'ma': ['Boston'], 'tn': ['Nashville'],
  'mo': ['Kansas City'], 'md': ['Baltimore'], 'wi': ['Milwaukee'], 'co': ['Denver'],
  'mn': ['Minneapolis'], 'sc': ['Charleston'], 'al': ['Birmingham'], 'ky': ['Louisville'],
  'or': ['Portland'], 'ok': ['Oklahoma City'], 'ct': ['Hartford'], 'ut': ['Salt Lake City'],
  'ia': ['Des Moines'], 'nv': ['Las Vegas'], 'ar': ['Little Rock'], 'ms': ['Jackson'],
  'ks': ['Wichita'], 'nm': ['Albuquerque'], 'ne': ['Omaha'], 'id': ['Boise'],
  'hi': ['Honolulu'], 'ri': ['Providence'], 'mt': ['Billings'], 'de': ['Wilmington'],
  'sd': ['Sioux Falls'], 'nd': ['Fargo'], 'ak': ['Anchorage'], 'dc': ['Washington'],
  'vt': ['Burlington'], 'wy': ['Cheyenne'], 'nh': ['Manchester'], 'wv': ['Charleston'],
  'in': ['Indianapolis'],
  'louisiana': ['New Orleans'], 'maine': ['Portland'],

  // —— 加拿大省两字母缩写 → 该省最大城市 ——
  'on': ['Toronto'], 'qc': ['Montreal'], 'bc': ['Vancouver'], 'ab': ['Calgary'],
  'mb': ['Winnipeg'], 'sk': ['Saskatoon'], 'ns': ['Halifax'], 'nb': ['Moncton'],

  // —— 中文热门城市：简体/繁体上游都 0 条时，直接给英文全名 ——
  '纽约': ['New York City', '纽约市', '紐約市'],
  '紐約': ['New York City', '紐約市'],
  '洛杉矶': ['Los Angeles', '洛杉磯'],
  '洛杉磯': ['Los Angeles'],
  '旧金山': ['San Francisco', '舊金山'],
  '舊金山': ['San Francisco'],
  '温哥华': ['Vancouver'],
  '温哥華': ['Vancouver'],
  '溫哥華': ['Vancouver'],
  '西雅图': ['Seattle', '西雅圖'],
  '西雅圖': ['Seattle'],
  '首尔': ['Seoul', '首爾', '漢城'],
  '首爾': ['Seoul'],
};
