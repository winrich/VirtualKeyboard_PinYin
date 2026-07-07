/**
 * pinyin_association.js
 * 智能联想增强模块 —— 为 virtualkeyboard.js 添加词组联想与上下文预测
 *
 * 三大增强：
 *   1. 拼音音节拆分：输入 "nihao" → 拆分为 ["ni","hao"] → 匹配词组 "你好"
 *   2. 词组候选优先：候选区先展示词组，再展示单字
 *   3. 上下文联想：选中一个词/字后，根据已上屏内容预测下一个常用字/词
 *
 * 加载顺序：jQuery → 桩函数 → virtualkeyboard.js → 本文件
 */

/*================================================================
 * 一、常用词词库（异步 JIT 加载模块）
 * key = 去空格拼音（全小写），value = 该拼音对应的词组数组（按频率排序）
 *
 * 优化：原 10.1MB 内联 wordDict -> 26 个按首字母分片的 JSON 文件
 * 加载策略：JIT（Just-In-Time）按需加载
 * 前缀匹配优化：字母分组遍历（262K -> ~10K）
 *================================================================*/

window._wordDict = window._wordDict || {};
window._dictOrder = window._dictOrder || [];
window._dictKeysByLetter = window._dictKeysByLetter || {};
window._dictLoaded = window._dictLoaded || {};
window._dictLoading = window._dictLoading || {};
window._dictCallbacks = window._dictCallbacks || {};

function ensureDictLoaded(letter, callback) {
  letter = letter.toLowerCase();
  if (!letter.match(/^[a-z]$/)) {
    if (callback) setTimeout(callback, 0);
    return;
  }
  if (window._dictLoaded[letter]) {
    if (callback) setTimeout(callback, 0);
    return;
  }
  if (!window._dictCallbacks[letter]) window._dictCallbacks[letter] = [];
  if (callback) window._dictCallbacks[letter].push(callback);
  if (window._dictLoading[letter]) return;

  window._dictLoading[letter] = true;
  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'dict/' + letter + '.json', true);
  xhr.overrideMimeType('application/json');
  xhr.onload = function () {
    if (xhr.status === 200 || xhr.status === 0) {
      try {
        var data = JSON.parse(xhr.responseText);
        var keys = [];
        for (var key in data) {
          if (data.hasOwnProperty(key)) {
            window._wordDict[key] = data[key];
            window._dictOrder.push(key);
            keys.push(key);
          }
        }
        window._dictKeysByLetter[letter] = keys;
        window._dictLoaded[letter] = true;
        window._dictLoading[letter] = false;
        var cbs = window._dictCallbacks[letter] || [];
        delete window._dictCallbacks[letter];
        for (var i = 0; i < cbs.length; i++) {
          try { cbs[i](); } catch(e) {}
        }
      } catch (e) {
        console.error('[dict] JSON parse error:', e);
        window._dictLoading[letter] = false;
      }
    } else {
      console.error('[dict] Failed to load:', xhr.status);
      window._dictLoading[letter] = false;
    }
  };
  xhr.onerror = function () {
    console.error('[dict] Network error');
    window._dictLoading[letter] = false;
  };
  xhr.send();
}

function loadAllDicts(onComplete) {
  var letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  var total = letters.length;
  var loaded = 0;
  letters.forEach(function(l) {
    ensureDictLoaded(l, function() {
      loaded++;
      if (loaded === total && onComplete) onComplete();
    });
  });
}

function _getDictValue(key) {
  return window._wordDict ? window._wordDict[key] : undefined;
}

function ensurePinyinDictLoaded(pinyin, callback) {
  if (!pinyin) { if (callback) setTimeout(callback, 0); return; }
  ensureDictLoaded(pinyin.charAt(0).toLowerCase(), callback);
}
/*================================================================
 * 二、拼音音节拆分算法
 * 将连续拼音（如 "nihao"）拆分为有效音节数组（如 ["ni","hao"]）
 * 算法：递归回溯 + 最长匹配优先
 *================================================================*/

// 从 dictionary 提取所有合法音节集合（去重）
var _validSyllables = (function() {
  var set = {};
  var keys = Object.keys(dictionary);
  for (var i = 0; i < keys.length; i++) {
    set[keys[i]] = true;
  }
  return set;
})();

// 缓存：避免对相同输入重复计算
var _splitCache = {};

/**
 * 拼音音节拆分（递归回溯，最长匹配优先）
 * @param {string} input 纯小写拼音串，如 "nihao"
 * @returns {Array<string>} 拆分结果，如 ["ni","hao"]；无法拆分时返回 []
 */
function splitPinyin(input) {
  if (!input) return [];
  input = input.toLowerCase();

  // 命中缓存
  if (_splitCache[input]) return _splitCache[input];

  var result = null;

  function backtrack(str, parts) {
    if (result) return;        // 已找到一组解，停止
    if (str.length === 0) {
      result = parts.slice();   // 记录第一组有效拆分
      return;
    }
    // 从最长（str.length）到最短（1）尝试匹配音节
    for (var len = str.length; len >= 1; len--) {
      var prefix = str.substring(0, len);
      if (_validSyllables[prefix]) {
        parts.push(prefix);
        backtrack(str.substring(len), parts);
        parts.pop();
      }
    }
  }

  backtrack(input, []);

  var finalResult = result || [];
  _splitCache[input] = finalResult;
  return finalResult;
}

/*================================================================
 * 三、词组候选获取
 * 给定当前拼音输入，返回匹配的词组候选列表
 * 策略：
 *   1. 精确匹配 wordDict[input] → 高优先
 *   2. 音节拆分后拼接 → 查 wordDict → 中优先
 *   3. 前缀匹配（input 是某 wordDict key 的前缀）→ 低优先
 *================================================================*/

/**
 * 获取词组候选
 * @param {string} pinyin 当前拼音缓冲区内容
 * @returns {Array<{word:string, source:string}>} 候选词组列表
 */
function getWordCandidates(pinyin) {
  if (!pinyin) return [];

  pinyin = pinyin.toLowerCase();
  var candidates = [];
  var seen = {};

  ensurePinyinDictLoaded(pinyin);
  var wd = window._wordDict;

  // 1. exact match
  if (wd && wd[pinyin]) {
    var exact = wd[pinyin];
    for (var i = 0; i < exact.length; i++) {
      if (!seen[exact[i]]) {
        candidates.push({ word: exact[i], source: 'exact' });
        seen[exact[i]] = true;
      }
    }
  }

  // 2. syllable split + join
  var syllables = splitPinyin(pinyin);
  if (syllables.length > 1) {
    var joined = syllables.join('');
    if (wd && wd[joined]) {
      var splitMatch = wd[joined];
      for (var j = 0; j < splitMatch.length; j++) {
        if (!seen[splitMatch[j]]) {
          candidates.push({ word: splitMatch[j], source: 'split' });
          seen[splitMatch[j]] = true;
        }
      }
    }
    for (var k = 1; k < syllables.length; k++) {
      var partial = syllables.slice(0, k).join('');
      if (wd && wd[partial]) {
        var partMatch = wd[partial];
        for (var m = 0; m < partMatch.length; m++) {
          if (!seen[partMatch[m]]) {
            candidates.push({ word: partMatch[m], source: 'partial' });
            seen[partMatch[m]] = true;
          }
        }
      }
    }
  }

  // 3. prefix match (letter-grouped: 262K -> ~10K)
  if (pinyin.length >= 2 && wd) {
    var prefixCount = 0;
    var firstL = pinyin.charAt(0);
    var groupKeys = window._dictKeysByLetter[firstL];
    if (groupKeys) {
      for (var gi = 0; gi < groupKeys.length && prefixCount < 20; gi++) {
        var key = groupKeys[gi];
        if (key !== pinyin && key.indexOf(pinyin) === 0) {
          var prefixWords = wd[key];
          if (prefixWords) {
            for (var n = 0; n < prefixWords.length && prefixCount < 20; n++) {
              if (!seen[prefixWords[n]]) {
                candidates.push({ word: prefixWords[n], source: 'prefix' });
                seen[prefixWords[n]] = true;
                prefixCount++;
              }
            }
          }
        }
      }
    }
  }

  return candidates;
}

/*================================================================
 * 四、上下文联想
 * 根据已上屏的最后一个字/词，预测下一个常用字/词
 * 数据结构：contextDict[最后一字] = [常用后续字数组]
 *================================================================*/

var contextDict = {
  // —— "你" 的常见后续 ——
  "你": ["好", "们", "的", "是", "看", "说", "能", "要", "想", "去"],
  // —— "好" 的常见后续 ——
  "好": ["的", "了", "吗", "啊", "人", "事", "看", "像", "久", "处"],
  // —— "我" 的常见后续 ——
  "我": ["的", "们", "是", "在", "有", "不", "要", "想", "看", "去", "也"],
  // —— "他" 的常见后续 ——
  "他": ["的", "们", "是", "在", "说", "也", "有", "不", "就", "去"],
  // —— "她" 的常见后续 ——
  "她": ["的", "是", "在", "说", "也", "有", "不", "就", "看", "去"],
  // —— "们" 的常见后续 ——
  "们": ["的", "是", "在", "都", "都", "一", "要", "有", "就", "去"],
  // —— "的" 的常见后续 ——
  "的": ["是", "人", "时", "话", "事", "地", "方", "名", "字", "一"],
  // —— "是" 的常见后续 ——
  "是": ["的", "不", "一", "在", "我", "他", "你", "有", "就", "也"],
  // —— "不" 的常见后续 ——
  "不": ["是", "会", "能", "要", "对", "好", "同", "过", "在", "了"],
  // —— "在" 的常见后续 ——
  "在": ["的", "了", "是", "不", "这", "那", "哪", "家", "学", "上"],
  // —— "有" 的常见后续 ——
  "有": ["的", "不", "了", "是", "一", "些", "什", "么", "关", "系"],
  // —— "了" 的常见后续 ——
  "了": ["。", "，", "的", "一", "不", "是", "吗", "吧", "啊", "呢"],
  // —— "这" 的常见后续 ——
  "这": ["是", "个", "里", "样", "些", "时", "次", "是", "件", "个"],
  // —— "那" 的常见后续 ——
  "那": ["是", "个", "里", "样", "些", "时", "次", "么", "天", "边"],
  // —— "中" 的常见后续 ——
  "中": ["国", "文", "心", "间", "的", "部", "学", "华", "秋", "年"],
  // —— "国" 的常见后续 ——
  "国": ["家", "的", "人", "内", "际", "庆", "都", "语", "民", "产"],
  // —— "人" 的常见后续 ——
  "人": ["的", "民", "生", "才", "们", "类", "口", "事", "心", "物"],
  // —— "大" 的常见后续 ——
  "大": ["的", "学", "家", "概", "约", "小", "量", "多", "会", "院"],
  // —— "小" 的常见后续 ——
  "小": ["的", "学", "时", "孩", "说", "心", "姐", "伙", "路", "子"],
  // —— "上" 的常见后续 ——
  "上": ["的", "了", "学", "面", "班", "海", "午", "去", "来", "看"],
  // —— "下" 的常见后续 ——
  "下": ["了", "的", "面", "午", "来", "去", "次", "一", "班", "雨"],
  // —— "说" 的常见后续 ——
  "说": ["的", "了", "是", "过", "过", "道", "明", "出", "不", "也"],
  // —— "看" 的常见后续 ——
  "看": ["的", "了", "见", "出", "来", "是", "过", "书", "上", "好"],
  // —— "想" 的常见后续 ——
  "想": ["的", "了", "到", "要", "不", "是", "过", "来", "起", "法"],
  // —— "去" 的常见后续 ——
  "去": ["了", "的", "看", "年", "过", "做", "买", "哪", "来", "一"],
  // —— "来" 的常见后续 ——
  "来": ["的", "了", "是", "不", "看", "过", "说", "到", "一", "去"],
  // —— "做" 的常见后续 ——
  "做": ["的", "了", "事", "到", "不", "过", "好", "人", "出", "一"],
  // —— "会" 的常见后续 ——
  "会": ["的", "了", "不", "是", "有", "议", "场", "上", "在", "来"],
  // —— "能" 的常见后续 ——
  "能": ["的", "不", "够", "力", "是", "有", "到", "让", "会", "可"],
  // —— "要" 的常见后续 ——
  "要": ["的", "是", "不", "在", "有", "去", "来", "做", "看", "说"],
  // —— "和" 的常见后续 ——
  "和": ["的", "是", "平", "了", "我", "他", "你", "在", "一", "谐"],
  // —— "与" 的常见后续 ——
  "与": ["的", "是", "其", "众", "时", "会", "否", "其", "同", "共"],
  // —— "或" 的常见后续 ——
  "或": ["者", "是", "许", "的", "将", "需", "要", "不", "能", "可"],
  // —— "很" 的常见后续 ——
  "很": ["好", "的", "多", "快", "高", "大", "小", "少", "久", "远"],
  // —— "也" 的常见后续 ——
  "也": ["是", "的", "不", "有", "就", "要", "在", "会", "能", "很"],
  // —— "都" 的常见后续 ——
  "都": ["是", "的", "有", "在", "不", "要", "会", "能", "就", "很"],
  // —— "就" 的常见后续 ——
  "就": ["是", "的", "在", "不", "要", "会", "能", "有", "去", "来"],
  // —— "还" 的常见后续 ——
  "还": ["是", "有", "在", "要", "不", "会", "能", "就", "好", "很"],
  // —— "只" 的常见后续 ——
  "只": ["是", "有", "要", "不", "能", "为", "好", "是", "在", "会"],
  // —— "又" 的常见后续 ——
  "又": ["是", "有", "不", "在", "一", "的", "来", "去", "看", "说"],
  // —— "再" 的常见后续 ——
  "再": ["来", "的", "是", "不", "也", "有", "就", "要", "看", "说"],
  // —— "对" 的常见后续 ——
  "对": ["的", "了", "不", "是", "说", "方", "面", "比", "象", "手"],
  // —— "多" 的常见后续 ——
  "多": ["的", "了", "少", "大", "好", "年", "次", "种", "么", "快"],
  // —— "少" 的常见后续 ——
  "少": ["的", "了", "数", "年", "女", "多", "有", "是", "在", "就"],
  // —— "好" 重复已在上面 ——
  // —— "天" 的常见后续 ——
  "天": ["的", "气", "上", "下", "空", "才", "真", "长", "时", "下"],
  // —— "年" 的常见后续 ——
  "年": ["的", "了", "轻", "度", "级", "终", "初", "底", "纪", "限"],
  // —— "时" 的常见后续 ——
  "时": ["候", "间", "的", "代", "期", "光", "尚", "而", "不", "一"],
  // —— "地" 的常见后续 ——
  "地": ["的", "方", "上", "球", "图", "位", "下", "震", "理", "面"],
  // —— "一" 的常见后续 ——
  "一": ["个", "的", "些", "样", "直", "起", "切", "般", "点", "次"],
  // —— "二" 的常见后续 ——
  "二": ["十", "人", "月", "次", "十", "年", "一", "百", "十", "日"],
  // —— "三" 的常见后续 ——
  "三": ["个", "十", "人", "月", "次", "十", "年", "百", "十", "日"],
  // —— "个" 的常见后续 ——
  "个": ["的", "人", "月", "星", "多", "好", "什", "是", "一", "大"],
  // —— "什" 的常见后续 ——
  "什": ["么", "的", "事", "么", "事", "样", "时", "人", "一", "么"],
  // —— "么" 的常见后续 ——
  "么": ["的", "了", "是", "样", "多", "说", "呢", "啊", "吧", "事"],
  // —— "怎" 的常见后续 ——
  "怎": ["么", "样", "能", "说", "可", "奈", "办", "么", "样", "了"],
  // —— "可" 的常见后续 ——
  "可": ["以", "能", "的", "是", "不", "爱", "能", "要", "会", "就"],
  // —— "以" 的常见后续 ——
  "以": ["的", "为", "后", "前", "上", "下", "及", "来", "是", "往"],
  // —— "及" 的常见后续 ——
  "及": ["的", "时", "格", "其", "以", "至", "了", "物", "他", "早"],
  // —— "为" 的常见后续 ——
  "为": ["的", "了", "什", "么", "是", "以", "此", "之", "人", "大"],
  // —— "从" 的常见后续 ——
  "从": ["的", "而", "不", "中", "前", "来", "去", "小", "上", "事"],
  // —— "向" 的常见后续 ——
  "向": ["的", "上", "前", "来", "着", "往", "方", "大", "一", "看"],
  // —— "到" 的常见后续 ——
  "到": ["的", "了", "来", "去", "在", "是", "说", "看", "上", "处"],
  // —— "给" 的常见后续 ——
  "给": ["的", "了", "你", "我", "他", "她", "大", "人", "一", "出"],
  // —— "让" 的常见后续 ——
  "让": ["的", "了", "人", "我", "你", "他", "她", "大", "是", "看"],
  // —— "被" 的常见后续 ——
  "被": ["的", "了", "人", "是", "我", "他", "她", "称", "为", "迫"],
  // —— "把" 的常见后续 ——
  "把": ["的", "它", "他", "她", "这", "那", "门", "手", "握", "自"],
  // —— "使" 的常见后续 ——
  "使": ["的", "人", "用", "了", "得", "命", "者", "节", "臣", "之"],
  // —— "令" 的常见后续 ——
  "令": ["人", "的", "了", "牌", "月", "人", "天", "旗", "爱", "尊"],
  // —— "其" 的常见后续 ——
  "其": ["的", "他", "中", "实", "次", "余", "间", "为", "乐", "他"],
  // —— "此" 的常见后续 ——
  "此": ["的", "时", "刻", "外", "地", "人", "事", "即", "举", "一"],
  // —— "些" 的常见后续 ——
  "些": ["的", "人", "时", "事", "话", "地", "方", "什", "么", "好"]
};

/**
 * 获取上下文联想候选
 * @param {string} lastChar 已上屏文本的最后一个字符
 * @returns {Array<string>} 后续常用字列表
 */
function getNextSuggestions(lastChar) {
  if (!lastChar) return [];
  return contextDict[lastChar] || [];
}

/**
 * 从已上屏文本中提取最后一个字符（处理4字节汉字）
 * @param {string} text 已上屏文本
 * @returns {string} 最后一个字符
 */
function getLastChar(text) {
  if (!text || text.length === 0) return '';
  var last = text.substr(-1);
  if (check4ByteHZ(last)) {
    return text.substr(-2);
  }
  return last;
}

/*================================================================
 * 五、连续拼音输入与智能拆分
 *
 * 核心增强：支持连续拼音输入，自动拆分音节
 *   输入 "tij"      → 拆分为 ["ti"] + 剩余 "j"  → 展示 "ti" 的候选字
 *   输入 "tianjinshi" → 拆分为 ["tian","jin","shi"] → 逐音节选择候选字
 *
 * 原理：用 _pinyinBuffer 全局变量替代 .key 文本作为拼音缓冲的真实数据源，
 *       .key 元素仅用于可视化展示（带音节分隔符）。
 *================================================================*/

// 全局拼音缓冲区（真实数据源，替代 .key 文本）
var _pinyinBuffer = '';

// 拆分方案切换相关状态
var _splitAlternatives = [];    // 所有可用拆分方案 [{syllables, remaining}, ...]
var _splitIndex = 0;            // 当前激活的方案索引

// 音节前缀集合：用于 O(1) 判断一个字符串是否是某个合法音节的前缀
var _syllablePrefixes = (function () {
  var set = {};
  for (var syllable in _validSyllables) {
    for (var j = 1; j <= syllable.length; j++) {
      set[syllable.substring(0, j)] = true;
    }
  }
  return set;
})();

// 缓存
var _splitPartialCache = {};

/**
 * 拼音智能拆分（支持部分拆分）
 *
 * 与 splitPinyin 不同，本函数允许最后一个音节不完整：
 *   "tij"        → { syllables: ["ti"],  remaining: "j"  }
 *   "tianjinshi" → { syllables: ["tian","jin","shi"], remaining: "" }
 *   "tianjins"   → { syllables: ["tian","jin"], remaining: "s" }
 *   "j"          → { syllables: [], remaining: "j" }
 *
 * 算法：递归回溯 + 最长匹配优先
 *   1. 先尝试完整拆分（调用 splitPinyin）
 *   2. 若失败，回溯寻找最长的完整音节序列，剩余部分必须是某音节的前缀
 *
 * @param {string} input 纯小写拼音串
 * @returns {{syllables: string[], remaining: string}}
 */
/**
 * 收集所有可能的拼音拆分方案（含部分拆分）
 * 与 splitPinyinPartial 使用相同的回溯算法，但不提前终止
 *
 * @param {string} input 纯小写拼音串
 * @returns {Array<{syllables:string[], remaining:string}>} 所有有效拆分方案
 */
function findAllPartialSplits(input) {
  if (!input) return [{ syllables: [], remaining: '' }];
  input = input.toLowerCase();

  var results = [];
  var seen = {};  // 去重：key = "syl1|syl2|...|rem"

  function backtrack(str, parts) {
    if (str.length === 0) {
      var key = parts.join('|');
      if (!seen[key]) {
        seen[key] = true;
        results.push({ syllables: parts.slice(), remaining: '' });
      }
      return;
    }

    // 检查剩余部分是否是某音节的前缀（保留此部分拆分方案）
    if (_syllablePrefixes[str]) {
      var key2 = parts.join('|') + '|r' + str;
      if (!seen[key2]) {
        seen[key2] = true;
        results.push({ syllables: parts.slice(), remaining: str });
      }
    }

    // 从最长到最短尝试匹配音节
    for (var len = str.length; len >= 1; len--) {
      var prefix = str.substring(0, len);
      if (_validSyllables[prefix]) {
        parts.push(prefix);
        backtrack(str.substring(len), parts);
        parts.pop();
      }
    }
  }

  backtrack(input, []);

  // 🔧 兜底保护：当输入不是任何合法拼音前缀时（如 "ts", "tz", "cs" 等），
  //             backtrack 不会产生任何记录。此时补一条 {syllables:[], remaining:input}
  //            以避免 _splitAlternatives=[] 导致后续所有索引访问崩溃。
  if (results.length === 0) {
    results.push({ syllables: [], remaining: input });
  }

  // 排序：完整拆分（无剩余）优先, 其次音节数升序, 剩余长度升序
  results.sort(function (a, b) {
    // 无剩余的完整拆分优先
    if (a.remaining === '' && b.remaining !== '') return -1;
    if (a.remaining !== '' && b.remaining === '') return 1;
    // 音节数少的优先
    if (a.syllables.length !== b.syllables.length) {
      return a.syllables.length - b.syllables.length;
    }
    // 剩余长度短者优先
    return a.remaining.length - b.remaining.length;
  });

  // 去重：相同音节组合只保留一个
  var unique = [];
  var seenKeys = {};
  for (var i = 0; i < results.length; i++) {
    var sk = results[i].syllables.join('|') + '|r' + results[i].remaining;
    if (!seenKeys[sk]) {
      seenKeys[sk] = true;
      unique.push(results[i]);
    }
  }

  // 🔧 空音节条目后移：当输入本身是合法音节（如 "xian"）时，
  //   _syllablePrefixes[input] 为 true → backtrack 产生 {syllables:[],remaining:input}
  //   排序后 0 音节排第一，导致 _splitIndex=0 始终指向空白条目而非真正的完整拆分。
  //   例如 "xian"：[{syl:[],rem:"xian"}, {syl:[xian],""}, {syl:[xi,an],""}, ...]
  //   修复：若首条为空音节且还有其他条目，将其移至末尾，让真正的拆分方案前置。
  if (unique.length > 1 && unique[0].syllables.length === 0 && unique[0].remaining === input) {
    var emptyEntry = unique.shift();
    unique.push(emptyEntry);
  }

  return unique;
}

function splitPinyinPartial(input) {
  if (!input) return { syllables: [], remaining: '' };
  input = input.toLowerCase();

  if (_splitPartialCache[input]) return _splitPartialCache[input];

  // 使用 findAllPartialSplits 获取所有方案
  var all = findAllPartialSplits(input);
  _splitAlternatives = all;
  _splitIndex = 0;

  var result = all.length > 0 ? all[0] : { syllables: [], remaining: input };
  _splitPartialCache[input] = result;
  return result;
}

/**
 * 计算文本中的汉字数量（正确处理4字节汉字）
 * @param {string} text 汉字文本
 * @returns {number} 汉字个数
 */
function countChineseChars(text) {
  if (!text) return 0;
  var count = 0;
  for (var i = 0; i < text.length; i++) {
    if (check4ByteHZ(text[i])) {
      i++; // 跳过4字节汉字的第二个字符
    }
    count++;
  }
  return count;
}

/**
 * 用户规则：声母表单个辅音字母不能独立成音节
 * b p m f d t n l g k h j q x zh ch sh r z c s
 * 注意：虽然 "n" 在字典中映射到"嗯"，但在连续拼音拆分中，
 *       单独拆出 "n" 是无意义的（如 youyinande → you|yi|na|n|de）
 */
var _singleConsonants = {b:1,c:1,d:1,f:1,g:1,h:1,j:1,k:1,l:1,m:1,n:1,p:1,q:1,r:1,s:1,t:1,w:1,x:1,y:1,z:1};

/**
 * 辅助函数：找出一个拼音字符串的所有完整合法拆分方案（无残留）
 * 基于用户定义的规则：
 *   1. 拆分后每一段必须是普通话合法完整拼音音节
 *   2. 单个辅音字母不能单独作为音节（即使字典中有该音节）
 *
 * @param {string} input 拼音字符串
 * @returns {Array<{syllables:string[], remaining:''}>} 完整拆分方案列表
 */
function _findCompleteSplits(input) {
  var all = findAllPartialSplits(input);
  var complete = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].remaining !== '') continue;
    var ok = true;
    for (var s = 0; s < all[i].syllables.length; s++) {
      var syl = all[i].syllables[s];
      // 条件1：必须是合法音节
      if (!_validSyllables[syl]) { ok = false; break; }
      // 条件2：单辅音字母不可独立成音节（如 n、m、c 等单独拆出无意义）
      if (syl.length === 1 && _singleConsonants[syl]) { ok = false; break; }
    }
    if (ok) complete.push(all[i]);
  }
  return complete;
}

/**
 * 检测指定分隔符位置是否存在**有意义的**替代拆分方案。
 *
 * 核心判定标准（基于用户定义的"相邻音节对"规则）：
 *   将相邻两个音节拼接后，该拼接串本身是否存在多种合法拆分。
 *   只有紧邻的两个音节之间才可能存在拆分歧义。
 *
 * 反例：niou → ni'ou 拼接串 "niou" 只有一种合法拆法 → 不显示可点击
 * 正例：youyinande 拆为 you|yi|nan|de：
 *       分隔符 0 (you|yi)：拼接串 "youyi" 仅 [you,yi] 一种 → 不显示可点击
 *       分隔符 1 (yi|nan)：拼接串 "yinan" 有 [yi,nan] 和 [yin,an] → 显示可点击
 *       分隔符 2 (nan|de)：拼接串 "nande" 仅 [nan,de] 一种 → 不显示可点击
 *
 * @param {number} sepIndex  分隔符索引（0 = 第 1 个 '）
 * @param {string[]} syllables  当前激活方案的音节数组
 * @param {string} remaining  当前激活方案的剩余部分（本函数不使用，保留接口兼容性）
 * @returns {boolean} 是否存在有意义的替代拆分
 */
function checkAlternativeAt(sepIndex, syllables, remaining) {
  if (sepIndex < 0 || sepIndex >= syllables.length - 1) return false;

  // 仅检查相邻两个音节的拼接串是否有多解
  var pairText = syllables[sepIndex] + syllables[sepIndex + 1];
  var complete = _findCompleteSplits(pairText);

  if (complete.length < 2) return false;

  // 确认存在与当前拆法不同的方案
  var currentPair = syllables[sepIndex] + '|' + syllables[sepIndex + 1];
  for (var i = 0; i < complete.length; i++) {
    if (complete[i].syllables.join('|') !== currentPair) return true;
  }
  return false;
}

/**
 * 在指定分隔符位置执行局部重新拆分（相邻音节对交换）
 *
 * 原理：仅重新拆分相邻两个音节的拼接串（如 "yinan" → [yi,nan] ↔ [yin,an]），
 *       不重新分析整个输入串，确保仅切换用户精确点击的那个拆分点。
 *
 * @param {number} sepIndex 分隔符索引（0 = 第 1 个 '）
 */
function toggleSplitAt(sepIndex) {
  if (!_splitAlternatives || _splitAlternatives.length <= 1) return;

  var current = _splitAlternatives[_splitIndex];
  var syllables = current.syllables;
  var remaining = current.remaining;

  if (sepIndex < 0 || sepIndex >= syllables.length - 1) return;

  // 相邻两个音节拼接
  var pairText = syllables[sepIndex] + syllables[sepIndex + 1];
  var complete = _findCompleteSplits(pairText);
  if (complete.length < 2) return;

  var currentPair = syllables[sepIndex] + '|' + syllables[sepIndex + 1];

  // 找到第一个不同于当前的完整拆分方案
  var nextAlt = null;
  for (var i = 0; i < complete.length; i++) {
    if (complete[i].syllables.join('|') !== currentPair) {
      nextAlt = complete[i];
      break;
    }
  }
  if (!nextAlt) return;

  // 构建新的音节数组：替换相邻两个音节
  var newSyllables = syllables.slice(0, sepIndex)
    .concat(nextAlt.syllables)
    .concat(syllables.slice(sepIndex + 2));

  // 重建拆分方案全局状态
  var fullText = newSyllables.join('') + remaining;
  _splitAlternatives = findAllPartialSplits(fullText);
  _splitPartialCache[fullText] = { syllables: newSyllables.slice(), remaining: remaining };

  // 找到匹配的方案索引
  var targetSig = newSyllables.join('|') + '|' + remaining;
  var found = false;
  for (var k = 0; k < _splitAlternatives.length; k++) {
    var sig = _splitAlternatives[k].syllables.join('|') + '|' + _splitAlternatives[k].remaining;
    if (sig === targetSig) {
      _splitIndex = k;
      found = true;
      break;
    }
  }
  if (!found) {
    // 未精确命中（罕见：因 remaining 差异），使用第一个完整方案
    _splitIndex = 0;
  }

  updateKeyDisplay(newSyllables, remaining);
  _rebuildCandidates(newSyllables, remaining);
}

/**
 * 全局拆分方案循环切换（⟳ 按钮触发）
 *
 * 仅在有意义的完整方案（remaining === ''）之间循环，跳过残留方案。
 */
function toggleSplit() {
  // 收集有意义的完整替代方案（与 _findCompleteSplits 使用相同过滤标准）
  var meaningful = [];
  if (_splitAlternatives) {
    for (var i = 0; i < _splitAlternatives.length; i++) {
      var alt = _splitAlternatives[i];
      if (alt.remaining !== '') continue;
      var ok = true;
      for (var s = 0; s < alt.syllables.length; s++) {
        var syl = alt.syllables[s];
        if (!_validSyllables[syl]) { ok = false; break; }
        // 单辅音字母不可独立成音节
        if (syl.length === 1 && _singleConsonants[syl]) { ok = false; break; }
      }
      if (ok) meaningful.push(alt);
    }
  }

  if (meaningful.length <= 1) return;

  // 找到当前方案在有意义列表中的位置
  var curSig = _splitAlternatives[_splitIndex].syllables.join('|') + '|' +
               _splitAlternatives[_splitIndex].remaining;
  var curIdx = 0;
  for (var j = 0; j < meaningful.length; j++) {
    var msig = meaningful[j].syllables.join('|') + '|' + meaningful[j].remaining;
    if (msig === curSig) { curIdx = j; break; }
  }

  var nextIdx = (curIdx + 1) % meaningful.length;
  _splitAlternatives = meaningful;
  _splitIndex = nextIdx;
  var chosen = meaningful[nextIdx];

  updateKeyDisplay(chosen.syllables, chosen.remaining);
  _rebuildCandidates(chosen.syllables, chosen.remaining);
}

/**
 * 基于拆分方案重建候选区（与 updateVal 后半部分逻辑一致，但使用指定拆分方案）
 *
 * @param {string[]} syllables 拆分后的音节数组
 * @param {string} remaining 未完成部分
 */
function _rebuildCandidates(syllables, remaining) {
  $('.fullKeyboard .word').remove();

  if (syllables.length === 0 && !remaining) {
    showContextSuggestions();
    return;
  }

  var wordCount = 0;
  var charCount = 0;

  if (syllables.length > 0) {
    // 词组候选（基于完整拼音，按音节数过滤以适配不同拆分方案）
    var fullPinyin = syllables.join('');
    var wordCandidates = getWordCandidates(fullPinyin);
    var sylCount = syllables.length;  // 当前拆分方案的音节数
    wordCandidates.forEach(function (item) {
      // 多音节拆分时，词组字数须匹配音节数（如 xi|an → 仅展示 2 字词如"西安"）
      if (sylCount > 1 && countChineseChars(item.word) !== sylCount) return;
      var hide = wordCount >= keyboard.setting.num ? ' vkHide' : '';
      $('<li class="word word-phrase' + hide + '">')
        .appendTo('.output-ZH')
        .text(item.word);
      wordCount++;
    });

    // 第一个音节的单字候选
    var firstSyllable = syllables[0];
    keyboard.setting.key.forEach(function (val) {
      if (val === firstSyllable) {
        for (var i = 0; i < dictionary[val].length; i++) {
          charCount++;
          var totalCount = wordCount + charCount;
          var hide = totalCount > keyboard.setting.num ? ' vkHide' : '';
          var hz = '';
          if (check4ByteHZ(dictionary[val][i])) {
            hz = dictionary[val][i] + dictionary[val][i + 1];
            i++;
          } else {
            hz = dictionary[val][i];
          }
          $('<li class="word' + hide + '">').appendTo('.output-ZH').text(hz);
        }
      }
    });

    if (charCount === 0 && wordCount === 0) {
      keyboard.setting.key.forEach(function (val) {
        if (val.indexOf(firstSyllable) === 0) {
          for (var i = 0; i < dictionary[val].length; i++) {
            charCount++;
            var totalCount = wordCount + charCount;
            var hide = totalCount > keyboard.setting.num ? ' vkHide' : '';
            var hz = '';
            if (check4ByteHZ(dictionary[val][i])) {
              hz = dictionary[val][i] + dictionary[val][i + 1];
              i++;
            } else {
              hz = dictionary[val][i];
            }
            $('<li class="word' + hide + '">').appendTo('.output-ZH').text(hz);
          }
        }
      });
    }
  }

  var total = wordCount + charCount;
  if (total < keyboard.setting.num) {
    $('.fullKeyboard .outputZoneDown').addClass('unclick');
  } else {
    $('.fullKeyboard .outputZoneDown').removeClass('unclick');
  }
  keyboard.setting.page = 1;
  $('.fullKeyboard .outputZoneUp').addClass('unclick');
  pageUpdate(total);
}

/**
 * 更新 .key 元素的显示，用音节分隔符可视化拆分结果
 *
 * 增强：每个 ' 分隔符变为可点击热区（触屏 ≥ 44px）。
 *       有替代方案的分隔符显示为珊瑚色，点击触发局部重新拆分。
 *       .key 栏末尾追加 ⟳ 全局切换按钮。
 *
 * @param {string[]} syllables 已拆分的完整音节数组
 * @param {string} remaining 不完整的剩余部分
 */
function updateKeyDisplay(syllables, remaining) {
  var syls = syllables;
  var rem = remaining;

  // 提前计算 meaningfulCount：用于判断分隔符是否可点击
  var mc = _getMeaningfulCount();
  var meaningfulCount = mc.count;
  var curMeaningfulIdx = mc.currentIdx;

  var html = '';
  for (var i = 0; i < syls.length; i++) {
    if (i > 0) {
      // 分隔符可点击条件：全局有多套有意义的完整拆分方案 && 此位置有局部替代
      var hasAlt = meaningfulCount > 1 && checkAlternativeAt(i - 1, syls, rem);
      var sepClass = hasAlt ? 'pinyin-sep pinyin-sep-clickable' : 'pinyin-sep';
      var onclick = hasAlt ? ' onclick="toggleSplitAt(' + (i - 1) + ')"' : '';
      var title = hasAlt ? ' title="点击切换拆分方式"' : '';
      html += '<span class="' + sepClass + '"' + onclick + title + '>\'</span>';
    }
    if (i === 0) {
      html += '<span class="pinyin-active">' + syls[i] + '</span>';
    } else {
      html += '<span class="pinyin-pending">' + syls[i] + '</span>';
    }
  }
  if (rem) {
    if (syls.length > 0) html += '<span class="pinyin-sep">\'</span>';
    html += '<span class="pinyin-partial">' + rem + '</span>';
  }

  // 全局切换按钮：仅当存在多种有意义的完整拆分方案时显示
  if (meaningfulCount > 1) {
    html += '<span class="pinyin-toggle" onclick="toggleSplit()" title="切换拆分方案 (' +
      (curMeaningfulIdx + 1) + '/' + meaningfulCount + ')">&#x27F3; ' +
      (curMeaningfulIdx + 1) + '/' + meaningfulCount + '</span>';
  }

  $('.fullKeyboard .key').html(html);
}

/*================================================================
 * 六、覆写核心函数 —— 集成连续拼音输入
 * 以下函数覆写 virtualkeyboard.js 中的同名全局函数
 *================================================================*/

/**
 * 覆写 input()
 * 中文模式下追加字母到 _pinyinBuffer（而非直接操作 .key 文本）
 */
function input(type, keyValue) {
  if (keyboard.setting.ZH) {
    _pinyinBuffer += keyValue;
    updateVal();
  } else {
    if (type == 'vkletter') {
      $('.vktext').val($('.vktext').val() + keyValue);
    } else if (type == 'vknum') {
      $('.numtext').val($('.numtext').val() + keyValue);
    }
  }
}

/**
 * 覆写 updateVal()
 * 增强版候选区更新：
 *   1. 用 splitPinyinPartial 拆分拼音缓冲
 *   2. 若有完整音节 → 展示第一个音节的单字候选 + 词组候选
 *   3. 若无完整音节但有剩余 → 回退到原始前缀匹配
 *   4. 缓冲为空 → 展示上下文联想
 */
function updateVal() {
  $('.fullKeyboard .word').remove(); // 清空所有候选

  var inputVal = _pinyinBuffer;
  if (!inputVal) {
    // 拼音缓冲为空时，展示上下文联想
    $('.fullKeyboard .key').html('');
    showContextSuggestions();
    return;
  }

  // 智能拆分
  var split = splitPinyinPartial(inputVal);
  var syllables = split.syllables;
  var remaining = split.remaining;

  // 更新 .key 显示（带音节分隔符）
  updateKeyDisplay(syllables, remaining);

  var wordCount = 0;
  var charCount = 0;

  if (syllables.length > 0) {
    // ---- 有完整音节：展示词组候选 + 第一个音节的单字候选 ----

    // 词组候选（基于完整拼音，按音节数过滤以适配不同拆分方案）
    var fullPinyin = syllables.join('');
    var wordCandidates = getWordCandidates(fullPinyin);
    var sylCount = syllables.length;  // 当前拆分方案的音节数

    wordCandidates.forEach(function (item) {
      // 多音节拆分时，词组字数须匹配音节数（如 xi|an → 仅展示 2 字词如"西安"）
      if (sylCount > 1 && countChineseChars(item.word) !== sylCount) return;
      var hide = wordCount >= keyboard.setting.num ? ' vkHide' : '';
      $('<li class="word word-phrase' + hide + '">')
        .appendTo('.output-ZH')
        .text(item.word);
      wordCount++;
    });

    // 第一个音节的单字候选
    var firstSyllable = syllables[0];
    keyboard.setting.key.forEach(function (val, index) {
      if (val === firstSyllable) {
        for (var i = 0; i < dictionary[val].length; i++) {
          charCount++;
          var totalCount = wordCount + charCount;
          var hide = totalCount > keyboard.setting.num ? ' vkHide' : '';

          var hz = '';
          if (check4ByteHZ(dictionary[val][i])) {
            hz = dictionary[val][i] + dictionary[val][i + 1];
            i++;
          } else {
            hz = dictionary[val][i];
          }

          $('<li class="word' + hide + '">').appendTo('.output-ZH').text(hz);
        }
      }
    });

    // 如果第一个音节没有匹配到候选（理论上不应该），回退到前缀匹配
    if (charCount === 0 && wordCount === 0) {
      keyboard.setting.key.forEach(function (val, index) {
        if (val.indexOf(firstSyllable) === 0) {
          for (var i = 0; i < dictionary[val].length; i++) {
            charCount++;
            var totalCount = wordCount + charCount;
            var hide = totalCount > keyboard.setting.num ? ' vkHide' : '';

            var hz = '';
            if (check4ByteHZ(dictionary[val][i])) {
              hz = dictionary[val][i] + dictionary[val][i + 1];
              i++;
            } else {
              hz = dictionary[val][i];
            }

            $('<li class="word' + hide + '">').appendTo('.output-ZH').text(hz);
          }
        }
      });
    }
  } else {
    // ---- 无完整音节：回退到原始前缀匹配 ----
    keyboard.setting.key.forEach(function (val, index) {
      if (val.indexOf(inputVal) === 0) {
        for (var i = 0; i < dictionary[val].length; i++) {
          charCount++;
          var hide = charCount > keyboard.setting.num ? ' vkHide' : '';

          var hz = '';
          if (check4ByteHZ(dictionary[val][i])) {
            hz = dictionary[val][i] + dictionary[val][i + 1];
            i++;
          } else {
            hz = dictionary[val][i];
          }

          $('<li class="word' + hide + '">').appendTo('.output-ZH').text(hz);
        }
      }
    });
  }

  var total = wordCount + charCount;

  // 更新翻页按键状态
  if (total < keyboard.setting.num) {
    $('.fullKeyboard .outputZoneDown').addClass('unclick');
  } else {
    $('.fullKeyboard .outputZoneDown').removeClass('unclick');
  }

  keyboard.setting.page = 1;
  $('.fullKeyboard .outputZoneUp').addClass('unclick');
  pageUpdate(total);
}

/**
 * 覆写 output()
 * 候选词上屏后，从 _pinyinBuffer 中消费对应音节，保留剩余拼音
 *
 * 消费规则：
 *   - 单字候选 → 消费 1 个音节
 *   - 词组候选 → 消费与词组字数相同的音节数
 */
function output(keyValue) {
  // 上屏
  $('.vktext').val($('.vktext').val() + keyValue);

  if (!_pinyinBuffer) {
    // 无拼音缓冲，直接展示上下文联想
    showContextSuggestions();
    return;
  }

  // 计算需要消费的音节数
  var charCount = countChineseChars(keyValue);

  // 使用当前激活的拆分方案（而非重新计算）
  var split = (_splitAlternatives.length > 0)
    ? _splitAlternatives[_splitIndex]
    : splitPinyinPartial(_pinyinBuffer);
  var syllables = split.syllables;

  // 消费前 N 个音节
  var consumeCount = Math.min(charCount, syllables.length);
  var consumedLength = 0;
  for (var i = 0; i < consumeCount; i++) {
    consumedLength += syllables[i].length;
  }

  // 从缓冲中移除已消费部分
  _pinyinBuffer = _pinyinBuffer.substring(consumedLength);

  if (_pinyinBuffer) {
    // 还有剩余拼音，更新候选
    // 🔧 修复：不再直接调用 updateVal()（它会重新 splitPinyinPartial → _splitIndex=0 → 丢失用户选择）
    // 改为：强制重拆分 → 按音节前缀逐项匹配用户之前的选择 → 保持拆分偏好
    // 注意：不能用字符串签名（如 "yi|nan|de"）匹配，因为
    //   {syllables:[yi,nan],remaining:"de"} 和 {syllables:[yi,nan,de],remaining:""} 签名相同

    // 计算剩余音节（从当前激活方案中截取）
    var remainingSyllables = syllables.slice(consumeCount);
    var oldRemaining = split.remaining;

    // 强制重新拆分剩余缓冲（绕过 splitPinyinPartial 缓存，确保 _splitAlternatives 更新）
    var newBuffer = _pinyinBuffer.toLowerCase();
    var newAll = findAllPartialSplits(newBuffer);
    _splitAlternatives = newAll;
    _splitIndex = 0;
    _splitPartialCache[newBuffer] = newAll.length > 0 ? newAll[0] : { syllables: [], remaining: newBuffer };

    // 两轮匹配，优先完整拆分（remaining=""），回退到部分拆分
    var found = false;
    for (var pass = 0; pass < 2 && !found; pass++) {
      for (var k = 0; k < newAll.length; k++) {
        // 第一轮：只接受 remaining="" 的完整拆分
        if (pass === 0 && newAll[k].remaining !== '') continue;
        // 第二轮：接受任何匹配

        // 音节前缀逐项比较
        var matched = true;
        for (var m = 0; m < remainingSyllables.length; m++) {
          if (!newAll[k].syllables[m] || newAll[k].syllables[m] !== remainingSyllables[m]) {
            matched = false;
            break;
          }
        }
        // 如果原方案有 remaining，检查额外剩余音节是否匹配
        if (matched && oldRemaining) {
          // 原方案的 remaining 应在新方案的后续音节或 remaining 中体现
          // 通过比较新方案的剩余部分来验证
          var consumedInMatch = 0;
          for (var p = 0; p < remainingSyllables.length; p++) {
            consumedInMatch += remainingSyllables[p].length;
          }
          var newRemaining = newBuffer.substring(consumedInMatch);
          // 允许新方案的后续音节吸收部分 remaining
          var extraSyls = newAll[k].syllables.slice(remainingSyllables.length);
          var extraText = extraSyls.join('') + newAll[k].remaining;
          if (extraText !== oldRemaining) matched = false;
        }
        if (matched) {
          _splitIndex = k;
          found = true;
          break;
        }
      }
    }

    // 用选定的拆分方案更新显示和候选区
    var chosen = (_splitAlternatives.length > 0)
      ? _splitAlternatives[_splitIndex]
      : { syllables: [], remaining: _pinyinBuffer };
    updateKeyDisplay(chosen.syllables, chosen.remaining);
    _rebuildCandidates(chosen.syllables, chosen.remaining);
  } else {
    // 缓冲已空，展示上下文联想
    _splitAlternatives = [];
    _splitIndex = 0;
    $('.fullKeyboard .key').html('');
    showContextSuggestions();
  }
}

/**
 * 覆写 emptyZH()
 * 清空候选区和拼音缓冲
 */
function emptyZH() {
  _pinyinBuffer = '';
  _splitAlternatives = [];
  _splitIndex = 0;
  $('.fullKeyboard .word').remove();
  $('.fullKeyboard .key').html('');
}

/**
 * 覆写 backspace()
 * 删除逻辑：先删拼音缓冲，缓冲空时删上屏内容
 */
function backspace(type) {
  if (_pinyinBuffer) {
    // 删除拼音缓冲的最后一个字符
    _pinyinBuffer = _pinyinBuffer.substring(0, _pinyinBuffer.length - 1);
    if (_pinyinBuffer) {
      updateVal();
    } else {
      emptyZH();
      showContextSuggestions();
    }
  } else {
    // 拼音缓冲为空，删除上屏内容
    if (type == 'vkletter') {
      var num = check4ByteHZ($('.vktext').val().substr(-1)) ? 2 : 1;
      var newText = $('.vktext')
        .val()
        .substring(0, $('.vktext').val().length - num);
      $('.vktext').val(newText);

      emptyZH();
      showContextSuggestions();
    } else if (type == 'vknum') {
      $('.numtext').val(
        $('.numtext').val().substring(0, $('.numtext').val().length - 1)
      );
    }
  }
}

/**
 * 覆写 closeVK()
 * 关闭键盘时清空缓冲
 */
function closeVK(entry, cbFun) {
  _pinyinBuffer = '';
  _splitAlternatives = [];
  _splitIndex = 0;
  var inputValue = '';

  if (entry == true) {
    inputValue = $('.vktext').val();
    setInputValueAndSync($(keyboard.setting.el), inputValue);
  }

  $('.virtualkeyboard').remove();
  topPage().hideMaskLayer();

  if (cbFun != null && cbFun != undefined && typeof cbFun === 'function') {
    cbFun(inputValue);
  }
}

/**
 * 展示上下文联想（拼音缓冲为空时触发）
 */
function showContextSuggestions() {
  if ($('.fullKeyboard').length === 0) return;
  if (!keyboard.setting.ZH) return;

  var currentText = $('.vktext').val();
  if (!currentText) return;

  var lastChar = getLastChar(currentText);
  var suggestions = getNextSuggestions(lastChar);

  // 清空候选区（output() 的 buffer 清空路径不会经过 updateVal/emptyZH，需在此处清理）
  $('.fullKeyboard .word').remove();

  suggestions.forEach(function (char, index) {
    var hide = index >= keyboard.setting.num ? ' vkHide' : '';
    $('<li class="word word-context' + hide + '">').appendTo('.output-ZH').text(char);
  });

  var total = suggestions.length;
  if (total < keyboard.setting.num) {
    $('.fullKeyboard .outputZoneDown').addClass('unclick');
  } else {
    $('.fullKeyboard .outputZoneDown').removeClass('unclick');
  }

  keyboard.setting.page = 1;
  $('.fullKeyboard .outputZoneUp').addClass('unclick');
  pageUpdate(total);
}

/*================================================================
 * 七、物理键盘支持（isDev 模式下）
 *================================================================*/
$(document).on('keydown', function (e) {
  if ($('.fullKeyboard').length === 0) return;
  if (!isDev) return;

  // 字母键 A-Z
  if (e.keyCode >= 65 && e.keyCode <= 90) {
    if (keyboard.setting.ZH) {
      var letter = e.key.toLowerCase();
      _pinyinBuffer += letter;
      updateVal();
      e.preventDefault();
    }
  }
  // Backspace
  else if (e.keyCode === 8) {
    backspace('vkletter');
    e.preventDefault();
  }
  // Enter
  else if (e.keyCode === 13) {
    closeVK(true, null);
    e.preventDefault();
  }
  // Space → 选择第一个候选词
  else if (e.keyCode === 32) {
    if (keyboard.setting.ZH && _pinyinBuffer) {
      var firstWord = $('.fullKeyboard .word').not('.vkHide').first();
      if (firstWord.length) {
        output(firstWord.text());
        e.preventDefault();
      }
    }
  }
  // 数字键 1-9 → 选择对应候选
  else if (e.keyCode >= 49 && e.keyCode <= 57) {
    if (keyboard.setting.ZH) {
      var num = e.keyCode - 48;
      var candidate = $('.fullKeyboard .word').not('.vkHide').eq(num - 1);
      if (candidate.length) {
        output(candidate.text());
        e.preventDefault();
      }
    }
  }
});

/*================================================================
 * 八、展开式候选面板 —— 两态切换 + 分区渲染 + 频率缓存
 *
 * 架构：
 *   - 折叠状态：联想词+候选字混合在 .output-ZH 单行展示
 *   - 展开状态：三栏面板（左拼音拆分 + 中候选列表 + 右功能按钮）
 *   - panelExpanded 布尔状态控制两态切换
 *   - candidateMode 控制候选显示模式（all/char/word）
 *   - localStorage 缓存用户选词频率，用于排序
 *   - _pendingExtra 暂存拼音未完成时输入的字母/数字/符号，拼音上屏后自动追加到输入区
 *================================================================*/

// ===== 状态变量 =====
keyboard.setting.panelExpanded = false;
keyboard.setting.candidateMode = 'all';  // 'all' | 'char' | 'word'
var _pendingExtra = '';  // 拼音未完成时暂存的非拼音字符

// ===== 频率缓存 =====
var _wordFreqCache = null;

function _loadWordFreq() {
  if (_wordFreqCache !== null) return;
  try {
    var stored = localStorage.getItem('pinyin_word_freq');
    _wordFreqCache = stored ? JSON.parse(stored) : {};
  } catch (e) {
    _wordFreqCache = {};
  }
}

function _saveWordFreq() {
  try {
    localStorage.setItem('pinyin_word_freq', JSON.stringify(_wordFreqCache));
  } catch (e) {}
}

function _recordWordSelection(word) {
  if (!word || word.length === 0) return;
  _loadWordFreq();
  _wordFreqCache[word] = (_wordFreqCache[word] || 0) + 1;
  _saveWordFreq();
}

function _sortCandidatesByFrequency(candidates) {
  _loadWordFreq();
  return candidates.slice().sort(function (a, b) {
    var freqA = _wordFreqCache[a.word] || 0;
    var freqB = _wordFreqCache[b.word] || 0;
    return freqB - freqA;
  });
}

// ===== 面板切换 =====

/**
 * 展开/收起候选面板
 * @param {boolean} expand true=展开, false=收起
 */
function togglePanel(expand) {
  keyboard.setting.panelExpanded = expand;

  if (expand) {
    // 展开：隐藏折叠栏和键盘，显示面板
    $('.candidate-bar').hide();
    $('.inputZone').hide();
    $('.candidate-panel').show();
    // 动态计算面板候选数：根据容器实际宽高自适应
    keyboard.setting.num = _calcPanelNum();
    // 始终从 _pinyinBuffer 重新拆分，确保状态同步
    var split = splitPinyinPartial(_pinyinBuffer);
    _renderPinyinSplit(split.syllables, split.remaining);
    _rebuildCandidates(split.syllables, split.remaining);
  } else {
    // 收起：隐藏面板，显示折叠栏和键盘
    $('.candidate-panel').hide();
    $('.candidate-bar').show();
    $('.inputZone').show();
    // 恢复折叠模式每页候选数
    var pageWidth = $(document.body).width();
    keyboard.setting.num = pageWidth > 1080 ? 10 : 8;
    // 始终从 _pinyinBuffer 重新拆分，确保状态同步
    var split2 = splitPinyinPartial(_pinyinBuffer);
    updateKeyDisplay(split2.syllables, split2.remaining);
    _rebuildCandidates(split2.syllables, split2.remaining);
  }
}

// ===== 左栏拼音拆分渲染 =====

/**
 * 计算有意义的完整拆分方案数量
 * @returns {{count: number, currentIdx: number}}
 */
function _getMeaningfulCount() {
  var count = 0;
  var currentIdx = 0;
  var curSig = (_splitAlternatives && _splitAlternatives.length > 0 && _splitAlternatives[_splitIndex])
    ? _splitAlternatives[_splitIndex].syllables.join('|') + '|' + _splitAlternatives[_splitIndex].remaining : '';
  if (_splitAlternatives) {
    for (var ai = 0; ai < _splitAlternatives.length; ai++) {
      var aiAlt = _splitAlternatives[ai];
      if (aiAlt.remaining !== '') continue;
      var aiOk = true;
      for (var as = 0; as < aiAlt.syllables.length; as++) {
        var aiSyl = aiAlt.syllables[as];
        if (!_validSyllables[aiSyl]) { aiOk = false; break; }
        if (aiSyl.length === 1 && _singleConsonants[aiSyl]) { aiOk = false; break; }
      }
      if (aiOk) {
        var aSig = aiAlt.syllables.join('|') + '|' + aiAlt.remaining;
        if (aSig === curSig) currentIdx = count;
        count++;
      }
    }
  }
  return { count: count, currentIdx: currentIdx };
}

/**
 * 渲染展开面板左栏的拼音拆分列表
 * @param {string[]} syllables 音节数组
 * @param {string} remaining 未完成部分
 */
function _renderPinyinSplit(syllables, remaining) {
  var mc = _getMeaningfulCount();
  var html = '';
  for (var i = 0; i < syllables.length; i++) {
    if (i > 0) {
      // 分隔符可点击条件：全局有多套方案 && 此位置有局部替代
      var hasAlt = mc.count > 1 && checkAlternativeAt(i - 1, syllables, remaining);
      var sepClass = hasAlt ? 'pinyin-separator clickable' : 'pinyin-separator';
      var onclick = hasAlt ? ' onclick="toggleSplitAt(' + (i - 1) + ')"' : '';
      var title = hasAlt ? ' title="点击切换拆分方式"' : '';
      html += '<div class="' + sepClass + '"' + onclick + title + '">\'</div>';
    }
    // 第一个音节高亮（活跃），其余次级高亮
    var sylStyle = i === 0 ? '' : ' style="background:#7F77DD;"';
    html += '<div class="pinyin-syllable"' + sylStyle + '>' + syllables[i] + '</div>';
  }
  if (remaining) {
    html += '<div class="pinyin-separator">\'</div>';
    html += '<div class="pinyin-syllable" style="background:#B0B0B0;font-style:italic;">' + remaining + '</div>';
  }
  $('.pinyin-split-list').html(html);
}

// ===== 统一候选渲染 =====

/**
 * 根据面板状态将候选词渲染到对应容器
 *
 * 折叠模式：所有候选混合渲染到 .output-ZH
 * 展开模式：词组→.panel-phrase-list，单字→.panel-char-list
 *
 * @param {Array} wordCandidates 词组候选 [{word, source}]
 * @param {Array} charCandidates 单字候选 [string]
 * @param {Array} contextSuggestions 上下文联想 [string]（可选）
 */
function _renderCandidatesToContainers(wordCandidates, charCandidates, contextSuggestions) {
  var expanded = keyboard.setting.panelExpanded;

  if (expanded) {
    // ===== 展开模式：分区渲染，所有候选无 vkHide =====
    $('.panel-phrase-list').empty();
    $('.panel-char-list').empty();

    // 词组（按频率排序）
    if (wordCandidates.length > 0) {
      var sortedWords = _sortCandidatesByFrequency(wordCandidates);
      sortedWords.forEach(function (item) {
        $('<div class="word word-phrase">')
          .appendTo('.panel-phrase-list')
          .text(item.word);
      });
    }

    // 单字
    if (charCandidates.length > 0) {
      charCandidates.forEach(function (hz) {
        $('<div class="word">')
          .appendTo('.panel-char-list')
          .text(hz);
      });
    } else if (contextSuggestions && contextSuggestions.length > 0) {
      contextSuggestions.forEach(function (char) {
        $('<div class="word word-context">')
          .appendTo('.panel-char-list')
          .text(char);
      });
    }

    // 初始翻页状态：从第1页开始，用 .show()/.hide() 控制显示
    keyboard.setting.page = 1;
    _applyPagination();
    // 面板无候选时自动收起
    _checkPanelAutoCollapse();

  } else {
    // ===== 折叠模式：混合渲染到 .output-ZH =====
    $('.output-ZH').empty();

    // 先全部渲染可见（不设 vkHide），再由 _fitAndHideOverflow 动态适配宽度
    // 词组（按频率排序）
    if (wordCandidates.length > 0) {
      var sortedWords2 = _sortCandidatesByFrequency(wordCandidates);
      sortedWords2.forEach(function (item) {
        $('<li class="word word-phrase">')
          .appendTo('.output-ZH')
          .text(item.word);
      });
    }

    // 单字
    if (charCandidates.length > 0) {
      charCandidates.forEach(function (hz) {
        $('<li class="word">')
          .appendTo('.output-ZH')
          .text(hz);
      });
    } else if (contextSuggestions && contextSuggestions.length > 0) {
      contextSuggestions.forEach(function (char) {
        $('<li class="word word-context">')
          .appendTo('.output-ZH')
          .text(char);
      });
    }

    // 动态适配宽度：隐藏超出一行的候选
    var visibleCount = _fitAndHideOverflow('.output-ZH');
    var totalCandidates = $('.output-ZH .word').length;

    // 更新翻页状态
    $('.fullKeyboard .outputZoneUp').addClass('unclick');
    if (totalCandidates > visibleCount) {
      $('.fullKeyboard .outputZoneDown').removeClass('unclick');
    } else {
      $('.fullKeyboard .outputZoneDown').addClass('unclick');
    }
    keyboard.setting.page = 1;
    pageUpdate(totalCandidates);
  }
  // 更新展开按钮状态
  _updateExpandButton();
}

/**
 * 折叠状态按实际宽度适配：测量每个词的实际渲染宽度，超出一行时自动隐藏
 * @param {string} containerSelector 容器选择器，如 '.output-ZH'
 * @returns {number} 当前可见的词数
 */
function _fitAndHideOverflow(containerSelector) {
  var $container = $(containerSelector + ':visible');
  if ($container.length === 0) return 0;

  var containerLeft = $container.offset().left;
  var availWidth = $container.width();
  var $words = $container.find('.word:visible');
  var visibleCount = 0;

  $words.each(function () {
    var wordRight = $(this).offset().left + $(this).outerWidth(true);
    if (wordRight <= containerLeft + availWidth) {
      visibleCount++;
    } else {
      $(this).hide();
    }
  });

  // 至少保留第一个词
  if (visibleCount === 0 && $words.length > 0) {
    $container.find('.word').first().show();
    visibleCount = 1;
  }

  return visibleCount;
}

/**
 * 展开面板分页控制：根据当前 page 用 .show()/.hide() 控制显示
 */
function _applyPagination() {
  var allWords = $('.fullKeyboard .word');
  var total = allWords.length;
  var page = keyboard.setting.page;
  var num = keyboard.setting.num;

  allWords.each(function (index) {
    if (index < num * page && index >= num * (page - 1)) {
      $(this).show();
    } else {
      $(this).hide();
    }
  });

  // 翻页按钮状态
  $('.panel-page-up, .panel-page-down').removeClass('unclick');
  if (page <= 1) {
    $('.panel-page-up').addClass('unclick');
  }
  if (page >= Math.ceil(total / num) || total < num) {
    $('.panel-page-down').addClass('unclick');
  }

  pageUpdate(total);
}

/**
 * 动态计算展开面板每页可显示的候选数（根据面板高度估算，不依赖单个词宽采样）
 */
function _calcPanelNum() {
  var $pCenter = $('.panel-center');
  if ($pCenter.length === 0 || !$pCenter.is(':visible')) return 30; // fallback

  var panelH = $pCenter.height();
  if (panelH <= 0) return 30;

  // 可用高度 = 面板高 - 标签(30) - 分隔线(13) - 翻页(27) - 上下padding(16)
  var availH = panelH - 86;
  // 每行约 40px（字体17 + padding + gap）
  var rows = Math.max(2, Math.floor(availH / 40));
  // 每行平均7个候选（混合词组和单字）
  return rows * 7;
}

/**
 * 更新展开按钮(▼)的可用状态：联想词+候选字全空时禁用
 */
function _updateExpandButton() {
  var hasWords = $('.output-ZH .word').not('.vkHide').length > 0;
  $('.panel-expand-btn').toggleClass('disabled', !hasWords);
}

/**
 * 展开面板中无候选时自动收起
 */
function _checkPanelAutoCollapse() {
  if (keyboard.setting.panelExpanded && $('.fullKeyboard .word').length === 0) {
    togglePanel(false);
  }
}

/**
 * 根据当前未完成拼音片段，预测合法后续字母，禁用无效键
 * @param {string} remaining 未完成音节片段
 */
function _updateKeyState(remaining) {
  if (!keyboard.setting.ZH) {
    $('.letterWrap li.letter').removeClass('VK_disabled');
    return;
  }
  if (!remaining) {
    // 无未完成拼音 → 所有字母可用
    $('.letterWrap li.letter').removeClass('VK_disabled');
    return;
  }
  // 检查每个字母是否可形成合法拼音前缀
  $('.letterWrap li.letter').each(function () {
    var letter = $(this).text().toLowerCase();
    if (letter.length !== 1) return; // 跳过非字母键
    var test = remaining + letter;
    if (_syllablePrefixes[test]) {
      $(this).removeClass('VK_disabled');
    } else {
      $(this).addClass('VK_disabled');
    }
  });
}

/**
 * 从音节列表构建候选（词组+单字），不含渲染逻辑
 *
 * @param {string[]} syllables 音节数组
 * @returns {{wordCandidates: Array, charCandidates: Array}}
 */
function _buildCandidatesFromSyllables(syllables) {
  var wordCandidates = [];
  var charCandidates = [];

  if (syllables.length === 0) return { wordCandidates: wordCandidates, charCandidates: charCandidates };

  // 词组候选
  var fullPinyin = syllables.join('');
  var sylCount = syllables.length;
  var rawWords = getWordCandidates(fullPinyin);
  rawWords.forEach(function (item) {
    if (sylCount > 1 && countChineseChars(item.word) > sylCount) return;
    if (sylCount > 1 && item.source === 'prefix') return;
    wordCandidates.push(item);
  });

  // 第一个音节的单字候选
  var firstSyllable = syllables[0];
  var foundDict = false;
  keyboard.setting.key.forEach(function (val) {
    if (val === firstSyllable) {
      foundDict = true;
      for (var i = 0; i < dictionary[val].length; i++) {
        var hz = '';
        if (check4ByteHZ(dictionary[val][i])) {
          hz = dictionary[val][i] + dictionary[val][i + 1];
          i++;
        } else {
          hz = dictionary[val][i];
        }
        charCandidates.push(hz);
      }
    }
  });

  // 如果第一个音节没有精确匹配，回退到前缀匹配（限30字，避免卡顿）
  if (charCandidates.length === 0 && wordCandidates.length === 0) {
    keyboard.setting.key.forEach(function (val) {
      if (val.indexOf(firstSyllable) === 0 && charCandidates.length < 30) {
        for (var i = 0; i < dictionary[val].length && charCandidates.length < 30; i++) {
          var hz = '';
          if (check4ByteHZ(dictionary[val][i])) {
            hz = dictionary[val][i] + dictionary[val][i + 1];
            i++;
          } else {
            hz = dictionary[val][i];
          }
          charCandidates.push(hz);
        }
      }
    });
  }

  if (charCandidates.length === 0 && wordCandidates.length === 0) {
    console.warn('[pinyin_association] No candidates for syllables:', JSON.stringify(syllables), 'firstSyllable:', firstSyllable, 'foundDict:', foundDict, 'keyHasSyl:', keyboard.setting.key.indexOf(firstSyllable) >= 0);
  }

  return { wordCandidates: wordCandidates, charCandidates: charCandidates };
}

// ===== 覆写核心渲染函数 =====

/**
 * 覆写 _rebuildCandidates() —— 支持面板两态渲染
 */
function _rebuildCandidates(syllables, remaining) {
  // 清空所有候选容器
  $('.fullKeyboard .word').remove();
  $('.panel-phrase-list').empty();
  $('.panel-char-list').empty();

  if (syllables.length === 0 && !remaining) {
    // 无拼音输入，展示上下文联想
    showContextSuggestions();
    return;
  }

  // 渲染左栏拼音拆分（展开模式）
  if (keyboard.setting.panelExpanded) {
    _renderPinyinSplit(syllables, remaining);
  }

  // 构建候选
  var result = _buildCandidatesFromSyllables(syllables);

  // 渲染到对应容器
  _renderCandidatesToContainers(result.wordCandidates, result.charCandidates, null);
  // 根据未完成拼音更新键盘键状态
  _updateKeyState(remaining);
}

/**
 * 覆写 updateVal() —— 增强版候选区更新，支持面板两态
 */
function updateVal() {
  // 清空所有候选容器
  $('.fullKeyboard .word').remove();
  $('.panel-phrase-list').empty();
  $('.panel-char-list').empty();

  var inputVal = _pinyinBuffer;
  if (!inputVal) {
    // 拼音缓冲为空，展示上下文联想
    $('.fullKeyboard .key').html('');
    $('.pinyin-split-list').empty();
    $('.letterWrap li.letter').removeClass('VK_disabled');
    showContextSuggestions();
    return;
  }

  // 智能拆分
  var split = splitPinyinPartial(inputVal);
  var syllables = split.syllables;
  var remaining = split.remaining;
  
  // 根据未完成拼音预测后续合法字母，禁用无效键
  _updateKeyState(remaining);

  // 更新拼音显示（含待填数字）
  if (_pendingExtra) {
    updateKeyDisplayWithExtra();
  } else {
    updateKeyDisplay(syllables, remaining);
  }

  // 渲染左栏拼音拆分（展开模式）
  if (keyboard.setting.panelExpanded) {
    _renderPinyinSplit(syllables, remaining);
  }

  if (syllables.length > 0) {
    // 有完整音节：构建并渲染候选
    var result = _buildCandidatesFromSyllables(syllables);
    _renderCandidatesToContainers(result.wordCandidates, result.charCandidates, null);
  } else {
    // 无完整音节：前缀匹配单字（限30字，避免卡顿）
    var charCandidates = [];
    keyboard.setting.key.forEach(function (val, index) {
      if (val.indexOf(inputVal) === 0 && charCandidates.length < 30) {
        for (var i = 0; i < dictionary[val].length && charCandidates.length < 30; i++) {
          var hz = '';
          if (check4ByteHZ(dictionary[val][i])) {
            hz = dictionary[val][i] + dictionary[val][i + 1];
            i++;
          } else {
            hz = dictionary[val][i];
          }
          charCandidates.push(hz);
        }
      }
    });
    _renderCandidatesToContainers([], charCandidates, null);
  }
}

/**
 * 覆写 emptyZH() —— 清空所有候选容器
 */
function emptyZH() {
  _pinyinBuffer = '';
  _pendingExtra = '';
  _splitAlternatives = [];
  _splitIndex = 0;
  $('.fullKeyboard .word').remove();
  $('.fullKeyboard .key').html('');
  $('.panel-phrase-list').empty();
  $('.panel-char-list').empty();
  $('.pinyin-split-list').empty();
  // 拼音清空后恢复所有字母键
  $('.letterWrap li.letter').removeClass('VK_disabled');
  _updateExpandButton();
}

/**
 * 覆写 showContextSuggestions() —— 支持面板两态渲染
 */
function showContextSuggestions() {
  if ($('.fullKeyboard').length === 0) return;
  if (!keyboard.setting.ZH) return;

  var currentText = $('.vktext').val();
  if (!currentText) {
    // 无上屏内容，清空候选区
    _renderCandidatesToContainers([], [], []);
    return;
  }

  var lastChar = getLastChar(currentText);
  var suggestions = getNextSuggestions(lastChar);

  // 按频率排序上下文联想
  _loadWordFreq();
  suggestions = suggestions.slice().sort(function (a, b) {
    return (_wordFreqCache[b] || 0) - (_wordFreqCache[a] || 0);
  });

  _renderCandidatesToContainers([], [], suggestions);
}

/**
 * 覆写 output() —— 候选词上屏 + 频率记录 + 面板感知渲染
 */
function output(keyValue) {
  // 记录选词频率
  _recordWordSelection(keyValue);

  // 上屏
  $('.vktext').val($('.vktext').val() + keyValue);

  if (!_pinyinBuffer) {
    // 无拼音缓冲，直接展示上下文联想
    showContextSuggestions();
    return;
  }

  // 计算需要消费的音节数
  var charCount = countChineseChars(keyValue);

  // 使用当前激活的拆分方案
  var split = (_splitAlternatives.length > 0)
    ? _splitAlternatives[_splitIndex]
    : splitPinyinPartial(_pinyinBuffer);
  var syllables = split.syllables;

  // 消费前 N 个音节
  var consumeCount = Math.min(charCount, syllables.length);
  var consumedLength = 0;
  for (var i = 0; i < consumeCount; i++) {
    consumedLength += syllables[i].length;
  }

  // 从缓冲中移除已消费部分
  _pinyinBuffer = _pinyinBuffer.substring(consumedLength);

  if (_pinyinBuffer) {
    // 还有剩余拼音，更新候选
    var remainingSyllables = syllables.slice(consumeCount);
    var oldRemaining = split.remaining;

    // 强制重新拆分剩余缓冲
    var newBuffer = _pinyinBuffer.toLowerCase();
    var newAll = findAllPartialSplits(newBuffer);
    _splitAlternatives = newAll;
    _splitIndex = 0;
    _splitPartialCache[newBuffer] = newAll.length > 0 ? newAll[0] : { syllables: [], remaining: newBuffer };

    // 两轮匹配，优先完整拆分
    var found = false;
    for (var pass = 0; pass < 2 && !found; pass++) {
      for (var k = 0; k < newAll.length; k++) {
        if (pass === 0 && newAll[k].remaining !== '') continue;
        var matched = true;
        for (var m = 0; m < remainingSyllables.length; m++) {
          if (!newAll[k].syllables[m] || newAll[k].syllables[m] !== remainingSyllables[m]) {
            matched = false;
            break;
          }
        }
        if (matched && oldRemaining) {
          var consumedInMatch = 0;
          for (var p = 0; p < remainingSyllables.length; p++) {
            consumedInMatch += remainingSyllables[p].length;
          }
          var newRemaining = newBuffer.substring(consumedInMatch);
          var extraSyls = newAll[k].syllables.slice(remainingSyllables.length);
          var extraText = extraSyls.join('') + newAll[k].remaining;
          if (extraText !== oldRemaining) matched = false;
        }
        if (matched) {
          _splitIndex = k;
          found = true;
          break;
        }
      }
    }

    // 用选定的拆分方案更新显示和候选区
    var chosen = (_splitAlternatives.length > 0)
      ? _splitAlternatives[_splitIndex]
      : { syllables: [], remaining: _pinyinBuffer };
    updateKeyDisplay(chosen.syllables, chosen.remaining);
    if (keyboard.setting.panelExpanded) {
      _renderPinyinSplit(chosen.syllables, chosen.remaining);
    }
    _rebuildCandidates(chosen.syllables, chosen.remaining);
    
    // 如果展开面板中已无候选字词，自动收起
    if (keyboard.setting.panelExpanded && $('.fullKeyboard .word').length === 0) {
      togglePanel(false);
    }
  } else {
    // 缓冲已空，展示上下文联想
    // 自动上屏暂存的数字
    if (_pendingExtra) {
      $('.vktext').val($('.vktext').val() + _pendingExtra);
      _pendingExtra = '';
    }
    _splitAlternatives = [];
    _splitIndex = 0;
    $('.fullKeyboard .key').html('');
    $('.pinyin-split-list').empty();
    showContextSuggestions();
    // 缓冲已空时自动收起面板
    if (keyboard.setting.panelExpanded) {
      togglePanel(false);
    }
  }
}

/**
 * 覆写 backspace() —— 删除逻辑 + 面板感知 + 数字暂存
 */
function backspace(type) {
  // 有待填数字时，优先删除数字
  if (_pendingExtra) {
    _pendingExtra = _pendingExtra.substring(0, _pendingExtra.length - 1);
    if (_pinyinBuffer) {
      updateKeyDisplayWithExtra();
    }
    return;
  }

  if (_pinyinBuffer) {
    // 删除拼音缓冲的最后一个字符
    _pinyinBuffer = _pinyinBuffer.substring(0, _pinyinBuffer.length - 1);
    // 清除拆分缓存以确保重新拆分
    _splitPartialCache = {};
    _splitAlternatives = [];
    _splitIndex = 0;
    if (_pinyinBuffer) {
      updateVal();
    } else {
      emptyZH();
      showContextSuggestions();
    }
    // 退格后无候选时自动收起面板
    _checkPanelAutoCollapse();
  } else {
    // 拼音缓冲为空，删除上屏内容
    if (type == 'vkletter') {
      var num = check4ByteHZ($('.vktext').val().substr(-1)) ? 2 : 1;
      var newText = $('.vktext')
        .val()
        .substring(0, $('.vktext').val().length - num);
      $('.vktext').val(newText);

      emptyZH();
      showContextSuggestions();
      _checkPanelAutoCollapse();
    } else if (type == 'vknum') {
      $('.numtext').val(
        $('.numtext').val().substring(0, $('.numtext').val().length - 1)
      );
    }
  }
}

/**
 * 覆写 closeVK() —— 关闭键盘时清空缓冲和面板状态
 */
function closeVK(entry, cbFun) {
  _pinyinBuffer = '';
  _pendingExtra = '';
  _splitAlternatives = [];
  _splitIndex = 0;
  keyboard.setting.panelExpanded = false;

  var inputValue = '';

  if (entry == true) {
    inputValue = $('.vktext').val();
    setInputValueAndSync($(keyboard.setting.el), inputValue);
  }

  $('.virtualkeyboard').remove();
  topPage().hideMaskLayer();

  if (cbFun != null && cbFun != undefined && typeof cbFun === 'function') {
    cbFun(inputValue);
  }
}

/**
 * 覆写 input() —— 中文模式追加到缓冲区
 */
function input(type, keyValue) {
  if (keyboard.setting.ZH) {
    _pinyinBuffer += keyValue;
    updateVal();
  } else {
    if (type == 'vkletter') {
      $('.vktext').val($('.vktext').val() + keyValue);
    } else if (type == 'vknum') {
      $('.numtext').val($('.numtext').val() + keyValue);
    }
  }
}

// ===== 翻页（支持折叠栏和面板内翻页） =====

/**
 * 覆写 pageUp() —— 支持折叠栏和面板内翻页
 */
function pageUp(e) {
  var list = $('.fullKeyboard .word');

  if (keyboard.setting.page > 1) {
    keyboard.setting.page--;

    if (keyboard.setting.panelExpanded) {
      // 展开面板：使用统一分页控制
      _applyPagination();
    } else {
      // 折叠模式：保持原有逻辑
      list.each(function (index, el) {
        if (index < keyboard.setting.num * keyboard.setting.page && index >= keyboard.setting.num * (keyboard.setting.page - 1)) {
          $(el).show();
        } else {
          $(el).hide();
        }
      });

      // 动态适配宽度，隐藏超出一行的候选
      _fitAndHideOverflow('.output-ZH');

      $('.outputZoneUp, .outputZoneDown').removeClass('unclick');
      if (keyboard.setting.page == 1) {
        $('.outputZoneUp').addClass('unclick');
      }
      pageUpdate(list.length);
    }
  }
}

/**
 * 覆写 pageDown() —— 支持折叠栏和面板内翻页
 */
function pageDown(e) {
  var list = $('.fullKeyboard .word');
  var len = Math.ceil(list.length / keyboard.setting.num);

  if (keyboard.setting.page < len) {
    keyboard.setting.page++;

    if (keyboard.setting.panelExpanded) {
      // 展开面板：使用统一分页控制
      _applyPagination();
    } else {
      // 折叠模式：保持原有逻辑
      list.each(function (index, el) {
        if (index < keyboard.setting.num * keyboard.setting.page && index >= keyboard.setting.num * (keyboard.setting.page - 1)) {
          $(el).show();
        } else {
          $(el).hide();
        }
      });

      // 动态适配宽度，隐藏超出一行的候选
      _fitAndHideOverflow('.output-ZH');

      $('.outputZoneUp, .outputZoneDown').removeClass('unclick');
      if (keyboard.setting.page == len) {
        $('.outputZoneDown').addClass('unclick');
      }
      pageUpdate(list.length);
    }
  }
}

// ===== 物理键盘增强：Esc 收起面板 =====
$(document).on('keydown', function (e) {
  if ($('.fullKeyboard').length === 0) return;
  // Esc → 收起面板
  if (e.keyCode === 27 && keyboard.setting.panelExpanded) {
    togglePanel(false);
    e.preventDefault();
  }
});

// ===== 数字/符号键处理：暂存到拼音区后面，拼音完整上屏后自动填入 =====
/**
 * 覆写 symbolOutput() — 拼音模式下符号暂存
 */
function symbolOutput(keyValue) {
  if (keyboard.setting.ZH && _pinyinBuffer) {
    // 拼音未完成时，符号暂存
    _pendingExtra += keyValue;
    updateKeyDisplayWithExtra();
    return;
  }
  // 无拼音缓冲：直接输出
  $(".vktext").val($(".vktext").val() + keyValue);
}

/**
 * 覆写 inputNum() — 拼音模式下数字暂存，拼音完成后自动上屏
 */
function inputNum(type, keyValue) {
  if (type !== 'vkletter') {
    $('.numtext').val($('.numtext').val() + keyValue);
    return;
  }

  // 拼音模式下有未完成的拼音时，数字暂存到缓冲区
  if (keyboard.setting.ZH && _pinyinBuffer) {
    _pendingExtra += keyValue;
    // 更新拼音显示区，追加待填数字
    updateKeyDisplayWithExtra();
    return;
  }

  // 无拼音缓冲：直接输出数字
  $('.vktext').val($('.vktext').val() + keyValue);
}

/**
 * 更新拼音显示（含待填数字/符号）
 */
function updateKeyDisplayWithExtra() {
  if (!_pinyinBuffer) return;
  var split = splitPinyinPartial(_pinyinBuffer);
  updateKeyDisplay(split.syllables, split.remaining);
  // 在拼音显示后面追加待填数字
  if (_pendingExtra) {
    $('.fullKeyboard .key').append('<span class="pending-digits"> ' + _pendingExtra + '</span>');
  }
  // 面板内的拼音拆分也显示数字
  if (keyboard.setting.panelExpanded && _pendingExtra) {
    $('.pinyin-split-list').append('<div class="pending-digits" style="text-align:center;color:#534AB7;font-weight:700;padding:4px;">' + _pendingExtra + '</div>');
  }
}

// ===== 性能优化：首字母输入防抖 =====
var _initLayoutDone = false;

/**
 * 覆写 _fitAndHideOverflow() —— 增加布局未就绪保护
 */
function _fitAndHideOverflow(containerSelector) {
  var $container = $(containerSelector + ':visible');
  if ($container.length === 0) return 0;

  var availWidth = $container.width();
  // 容器未布局（宽0或负值）跳过适配
  if (availWidth <= 0) return 0;

  var $words = $container.find('.word:visible');
  if ($words.length === 0) return 0;

  var containerLeft = $container.offset().left;
  var visibleCount = 0;

  $words.each(function () {
    var wordRight = $(this).offset().left + $(this).outerWidth(true);
    if (wordRight <= containerLeft + availWidth) {
      visibleCount++;
    } else {
      $(this).hide();
    }
  });

  // 至少保留第一个词
  if (visibleCount === 0 && $words.length > 0) {
    $container.find('.word').first().show();
    visibleCount = 1;
  }

  return visibleCount;
}

console.log('[pinyin_association] 智能联想模块已加载（含连续拼音输入）');
  var _dictKeysCount = 0;
  for (var _dl in window._dictLoaded) {
    if (window._dictLoaded[_dl]) {
      _dictKeysCount += (window._dictKeysByLetter[_dl] || []).length;
    }
  }
  console.log('[pinyin_association] 词库词条数: ' + _dictKeysCount + ' (JIT 已加载分片: ' + Object.keys(window._dictLoaded).length + '/23)');
console.log('[pinyin_association] 上下文字典条目数: ' + Object.keys(contextDict).length);
console.log('[pinyin_association] 合法音节数: ' + Object.keys(_validSyllables).length);
console.log('[pinyin_association] 音节前缀数: ' + Object.keys(_syllablePrefixes).length);
console.log('[pinyin_association] 展开式候选面板模块已加载');
