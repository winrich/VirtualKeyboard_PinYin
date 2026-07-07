# 拼音虚拟键盘输入法

面向触屏自助系统的 **Web 端中文拼音输入法**，支持智能拼音拆分、词组联想、行政区划快速输入与触屏友好的拆分方案切换。

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [架构设计](#架构设计)
- [核心算法](#核心算法)
  - [拼音音节智能拆分](#拼音音节智能拆分)
  - [触屏双通道拆分方案切换](#触屏双通道拆分方案切换)
  - [智能联想与上下文预测](#智能联想与上下文预测)
- [词库说明](#词库说明)
- [数据源与脚本](#数据源与脚本)
- [二次开发指南](#二次开发指南)
- [已知限制](#已知限制)
- [开发日志](#开发日志)

---

## 功能特性

| 特性 | 描述 |
|------|------|
| **触屏虚拟键盘** | 全键盘布局，支持拖拽移动，适配触屏自助终端 |
| **拼音输入** | 419 个标准拼音音节，覆盖全部常用汉字 |
| **英文输入** | 一键切换英文模式，支持大小写 |
| **标点符号** | 内置常用中文标点符号面板 |
| **智能拼音拆分** | 支持连续拼音输入（如 `nihao` → `ni` `hao` → "你好"），最长匹配优先 |
| **拆分方案切换** | 歧义拆分（如 `xian` → `xi an` 或 `xian`）支持触屏切换 |
| **词组联想** | 输入拼音后优先展示词组匹配（蓝色底标注） |
| **上下文预测** | 选中字/词后，根据上下文预测下一个常用字（绿色底标注） |
| **行政区划词库** | 内置全国 37 万条地名（省/市/区县/街道/社区），支持拼音快速输入 |
| **零依赖部署** | 纯前端实现，加载 jQuery CDN 即可运行，无需后端服务。词库通过 XHR 按需加载 `dict/` 分片 |

---

## 快速开始

### 1. 环境要求

- 现代浏览器（Chrome 80+ / Edge 80+ / Firefox 75+ / Safari 14+）
- 可访问 CDN（用于加载 jQuery 3.6.4）

### 2. 启动方式

直接在浏览器中打开 `virtual_keyboard_demo.html` 即可：

```
双击 virtual_keyboard_demo.html
```

或使用任意 HTTP 服务器托管项目目录：

```bash
# Python
python -m http.server 8080

# Node.js (npx)
npx serve .
```

然后访问 `http://localhost:8080/virtual_keyboard_demo.html`。

### 3. 嵌入已有项目

在目标 HTML 中按以下顺序加载：

```html
<!-- 1. jQuery -->
<script src="https://cdn.bootcdn.net/ajax/libs/jquery/3.6.4/jquery.min.js"></script>

<!-- 2. 桩函数（适配层） -->
<script>
  window.isDev = true;
  function topPage() { return { project: "" }; }
  function setInputValueAndSync(input, value) { /* 自定义写入逻辑 */ }
  // ... 详见 virtual_keyboard_demo.html
</script>

<!-- 3. 核心键盘引擎 -->
<script src="virtualkeyboard.js"></script>

<!-- 4. 智能联想模块（v19 异步 JIT 加载，仅 64KB） -->
<script src="pinyin_association.js"></script>
```

> **注意**：`pinyin_association.js` 本身体积仅 ~64KB，启动后通过 XHR 按需加载 `dict/{letter}.json` 分片（平均 ~400KB/个）。首次输入某首字母时需等待 ~50-200ms 加载对应分片（浏览器缓存的后续访问为 0ms）。需通过 HTTP 服务器（非 `file://`）访问以支持 XHR。

---

## 项目结构

```
.
├── dict/                           # 按首字母分片的外部词库（23 个 JSON 文件）
│   ├── a.json                      # 首字母 a 的词库 (~97KB)
│   ├── b.json                      # 首字母 b 的词库 (~484KB)
│   ├── ...
│   ├── z.json                      # 首字母 z 的词库 (~560KB)
│   └── index.json                  # 分片元数据索引
├── virtual_keyboard_demo.html      # 独立演示页面（含完整 CSS 样式）
├── virtualkeyboard.js              # 核心键盘引擎（419 音节字典）
├── pinyin_association.js           # 智能联想增强模块（64KB，含 JIT 加载引擎）
├── pinyin_association.js.bak_v4    # 联想模块 v4 版本备份
└── README.md                       # 本文件
```

### 核心文件职责

| 文件 | 大小 | 加载时机 | 职责 |
|------|------|----------|------|
| `virtual_keyboard_demo.html` | ~31KB | 浏览器直接渲染 | UI 入口、样式定义、桩函数、输入框管理 |
| `virtualkeyboard.js` | ~116KB | HTML `<script>` 加载 | 键盘引擎、拼音字典、键盘事件、候选区渲染 |
| `pinyin_association.js` | **~64KB**（v19） | 在 `virtualkeyboard.js` 之后加载 | 智能联想、拆分切换、JIT 词库加载引擎、展开式候选面板 |
| `dict/{letter}.json`（23 文件） | 平均 ~400KB | XHR 按需加载（JIT） | 按首字母分片的行政区划词库（262K 拼音键，372K 词条） |

---

## 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                   virtual_keyboard_demo.html             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  输入框 A    │  │   输入框 B    │  │   结果展示区   │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │               │                   │          │
│  ┌──────┴───────────────┴───────────────────┴───────┐  │
│  │                 桩函数适配层                       │  │
│  │  topPage()  setInputValueAndSync()  IFRamp_*()   │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │                              │
│  ┌──────────────────────┴───────────────────────────┐  │
│  │           virtualkeyboard.js（键盘引擎）           │  │
│  │  ┌──────────────┐  ┌──────────────────────────┐  │  │
│  │  │  键盘布局      │  │  拼音字典（419 音节）     │  │  │
│  │  │  中/EN/符 切换 │  │  候选字展示与选择         │  │  │
│  │  │  物理键盘事件  │  │  已选汉字回填             │  │  │
│  │  └──────┬───────┘  └──────────┬───────────────┘  │  │
│  │         │                     │                   │  │
│  │  ┌──────┴─────────────────────┴────────────────┐  │  │
│  │  │    pinyin_association.js（智能联想增强）      │  │  │
│  │  │  ┌──────────────┐  ┌────────────────────┐   │  │
│  │  │  │ 拼音音节拆分   │  │ JIT 词库加载引擎   │   │  │
│  │  │  │（最长匹配优先）│  │ XHR → JSON.parse   │   │  │
│  │  │  ├──────────────┤  ├────────────────────┤   │  │
│  │  │  │ 拆分方案切换   │  │ dict/{letter}.json │   │  │
│  │  │  │（双通道触屏）  │  │ ← 按首字母按需加载  │   │  │
│  │  │  ├──────────────┤  ├────────────────────┤   │  │
│  │  │  │ 上下文联想     │  │ 词组联想匹配        │   │  │
│  │  │  │（绿色预测字）  │  │（三级匹配策略）     │   │  │
│  │  │  └──────────────┘  └────────────────────┘   │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**数据流**：

```
用户按键 → keyboard.processKey()
  → 拼音缓冲区更新 → splitPinyinPartial() 智能拆分
  → ensurePinyinDictLoaded() 自动加载 dict/{letter}.json（JIT）
  → getWordCandidates() 词组匹配（字母分组遍历）→ showContextSuggestions() 上下文预测
  → updateKeyDisplay() 拼音区渲染（含可点击分隔符）
  → output() / _renderCandidatesToContainers() 候选区渲染（折叠/面板）
  → 用户选择候选字/词 → submitToInput() 写入目标输入框
```

---

## 核心算法

### 拼音音节智能拆分

**问题**：用户连续输入 `"nihao"`，需要拆分为 `["ni", "hao"]` 来匹配汉字"你好"。歧义输入如 `"xian"` 存在 `["xian"]` 和 `["xi", "an"]` 两种合法拆分。

**实现**：

```
splitPinyinPartial(input)
  ├── findAllPartialSplits(input)
  │   └── Backtracking 递归枚举所有与完整音节匹配的切分
  │       ├── 每次都尝试匹配「完整音节前缀」（如 "xi"、"xian"）
  │       ├── 也保留「残留前缀」作为部分匹配（如 "xi" → 剩余 "an"）
  │       └── 排序：（音节数升序 = 最长匹配优先）→ 剩余长度升序
  │
  └── [_splitIndex] 选择当前激活方案
      └── 默认 index=0 = 最长匹配方案
```

**合法音节判定**：从 `dictionary`（419 个拼音键）提取 `_validSyllables` 集合，O(1) 查表。

**歧义多候选**：当同一切分位置存在两种以上完整合法拆分时（如 `"yinan"` → `["yi","nan"]` 或 `["yin","an"]`），两种方案均保留供用户选择。

### 触屏双通道拆分方案切换

设计目标是让触屏用户无需物理键盘即可切换拼音拆分方案。

#### 通道一：分隔符点击切换（局部切换）

仅当 **相邻两个音节** 的拼接串存在多种合法拆分时，两者之间的 `'` 分隔符显示为可点击状态（珊瑚色虚线边框）。

**判定标准**：

```javascript
function checkAlternativeAt(sepIndex, syllables) {
  // 拼接相邻两个音节
  var pairText = syllables[sepIndex] + syllables[sepIndex + 1];
  // 检查 pairText 是否存在 ≥2 种完整合法拆分方案
  return _findCompleteSplits(pairText).length >= 2;
}
```

> **过滤规则**：单辅音字母（b-p-m-f-d-t-n-l-g-k-h-j-q-x-zh-ch-sh-r-z-c-s-w-y）不能独立成音节——即使 `"n"` 在字典中存在（映射到"嗯"），在连续拼音拆分中拆出孤立 `n` 被视为无意义。

**交互规格**：

| 属性 | 值 |
|------|-----|
| 可点击分隔符样式 | 珊瑚色底（`#ff6b6b`），虚线边框 |
| 最小触控区域 | 44×32px（符合触屏无障碍标准） |
| 点击行为 | 将相邻两个音节的拼接串重新拆分为另一种方案 |

**示例**（`youyinande` → `you|yi|nan|de`）：

| 分隔符位置 | 拼接串 | 合法拆分方案 | 可点击 |
|-----------|--------|-------------|--------|
| `you` \| `yi` | `youyi` | 仅 `[you,yi]` | 否 |
| `yi` \| `nan` | `yinan` | `[yi,nan]` + `[yin,an]` | **是** |
| `nan` \| `de` | `nande` | 仅 `[nan,de]` | 否 |

#### 通道二：全局循环切换按钮（⟳）

拼音符号区右侧的 ⟳ 按钮在所有有意义的完整拆分方案之间循环切换（如 `piao` → `pi|ao` → `pi|a|o` 三种完整方案）。

### 智能联想与上下文预测

**词组联想**（三级匹配策略）：

```
getWordCandidates(pinyin)
  ├── Level 1：精确匹配 wordDict[pinyin]
  ├── Level 2：拆分匹配（findAllPartialSplits → 重组键匹配）
  └── Level 3：前缀匹配（查找以 pinyin 开头的词库键）
```

**上下文预测**：选中字/词后，检查 `contextDict[selectedText]` 获取最常用的后接字列表，在候选区以绿色底展示。

---

## 词库说明

### 拼音字典（`virtualkeyboard.js`）

- 版本：2024-11-05
- 音节数：419 个（标准普通话拼音音节全覆盖）
- 数据格式：`{ "拼音": "汉字列表" }`
- 每个音节映射到对应汉字的 Unicode 字符串

### 行政区划词库（`pinyin_association.js`）

- 拼音键数：262,994 个
- 词条总数：372,535 条（含备用键）
- 五级覆盖：省(31) → 地级市(336) → 区/县(2,972) → 街道/乡镇(40,468) → 社区/村(607,238)
- 数据来源：民政部地名信息库 + GitHub `xiangyuecn/AreaCity-JsSpider-StatsGov`
- 生成脚本：`build_geo_worddict.py`

**双键策略**：每个地名同时生成两个拼音键：

```
"天津市河东区" → "tianjinshihedongqu"（完整键）
                + "tianjinhedong"（去行政后缀备用键）
```

- Level 5（社区/村）：仅保留去后缀单键（节省空间并提高命中率）
- 后缀去除：自动去除"社区居委会""村委会""社区"等行政后缀

---

## 数据源与脚本

### 数据源

| 数据 | 来源 | 用途 |
|------|------|------|
| `virtualkeyboard.js` 拼音字典 | 原始输入法文件（2024-11-05 版） | 核心拼音-汉字映射 |
| `ok_data_level3.csv` | 民政部地名信息库 | 省/市/区县三级地名 |
| `SysRegion.sql`（外部，652K 行） | GitHub `xiangyuecn/AreaCity` | 五级完整地名（含街道/社区） |

### Python 辅助脚本

| 脚本 | 输入 | 输出 | 用途 |
|------|------|------|------|
| `generate_geo_dict.py` | `ok_data_level3.csv` | 更新 `pinyin_association.js` | 生成省/市/区县词库 |
| `build_geo_worddict.py` | `SysRegion.sql` | 更新 `pinyin_association.js` | 生成五级完整词库 |
| `create_region_db.py` | `ok_data_level3.csv` | `china_regions.db` | 创建 SQLite 数据库 |
| `analyze_sql.py` | `SysRegion.sql` | 终端输出 | 预分析 SQL 数据 |

**运行方式**：

```bash
cd 项目目录
python build_geo_worddict.py
```

> 运行前需按脚本内的路径配置指向本地的 `SysRegion.sql` 和 `pinyin_association.js` 模板文件。

---

## 功能完善日志

> 以下记录了从 **2026-07-06 下午至 2026-07-07** 期间的所有功能新增、Bug 修复与性能优化。

### v1 — 拼音虚拟键盘独立封装（07-06 下午）

- **来源**：用户提供的 `virtualkeyboard.js`（1542 行，419 音节字典）
- **交付**：编写 `virtual_keyboard_demo.html`，包含完整 CSS 样式、桩函数适配层、双输入框示例
- **修复**：jQuery 依赖缺失导致键盘不弹出 → 引入 CDN 加载

### v2 — 智能联想功能（07-06 下午）

- **新增**：`pinyin_association.js` 增强模块，覆写 `updateVal`/`output`/`backspace` 等核心函数
- **三大增强**：
  - 拼音音节拆分算法（Backtracking + 最长匹配优先）
  - 词组候选三级匹配（精确 → 拆分 → 前缀），蓝色底展示
  - 上下文预测（80+ 常用字的后续字），绿色底展示
- **物理键盘增强**：空格选首选词，数字键 1-9 选候选，Backspace 删除

### v3 — 连续拼音输入与智能拆分（07-06 下午）

- **核心改造**：引入 `_pinyinBuffer` 全局变量作为真实数据源，`.key` 仅用于可视化展示
- **新增**：`splitPinyinPartial()` 支持部分拆分的回溯算法、`_syllablePrefixes` 前缀集合、`updateKeyDisplay()` 音节分隔渲染
- **消费规则**：单字消费 1 音节，词组消费匹配字数音节

### v4 — 候选字残留 Bug 修复（07-06 下午）

- **Bug**：逐音节选字后拼音缓冲已空，但原音节候选字仍残留在候选区
- **根因**：`output()` 中 buffer 清空后调用 `showContextSuggestions()` 未先清空候选区
- **修复**：联想展示前增加 `$('.fullKeyboard .word').remove()`，1 行代码

### v5 — 行政区划联想词库（07-06 下午 ~ 傍晚）

- **第一次扩充**：直辖市 + 23 省 + 5 自治区 + 2 特区 + 27 省会 + ~90 主要地级市 + ~30 区县地标
- **第二次扩充**：全国 **330+ 地级行政区全覆盖**（按华北/东北/华东等地理分区组织）
- **冲突修复**：伊春→`yichunhlj` vs 宜春→`yichun`；泰州/台州→共享 `taizhou` 键

### v6 — SQLite 行政区划数据库（07-06 傍晚）

- **交付**：`create_region_db.py` + `china_regions.db`（556 KB，3,635 条数据）
- **结构**：14 字段含 Code/Name/PinYin/Level/Lng/Lat，4 个索引
- **数据**：34 省级 + 392 地级 + 3,209 区县级

### v7 — 全量行政区划词库导入（07-06 傍晚）

- **数据源**：`SysRegion.sql`（652K 行，186MB），解析出 339,247 个唯一地名
- **拼音键**：262,994 个，词条总数 **372,535 条**（含双键策略）
- **文件大小**：`pinyin_association.js` 约 10.1MB
- **五级覆盖**：省(31) → 地级市(336) → 区县(2,972) → 街道(40,468) → 社区/村(607,238)

### v8 — 触屏双通道拆分切换（07-06 傍晚 ~ 夜间）

- **通道一**：分隔符热区点击 — 44×32px 触控区域，珊瑚色=有替代方案，灰色=无
- **通道二**：⟳ 全局循环切换按钮
- **迭代历程**（5 个版本子迭代）：

| 版本 | 改进内容 |
|------|---------|
| **v1** | 基础双通道实现（`checkAlternativeAt`/`toggleSplitAt`/`toggleSplit`） |
| **v2** | 轻量化：仅展示有意义的**完整**替代方案，过滤残余部分 |
| **v3** | 精准判定：从全局搜索改为**相邻音节对**拼接判定 |
| **v4** | 单辅音过滤（23 个辅音黑名单）+ 排序方向修正（音节数升序=最长匹配优先） |
| **v5** | 选字后拆分方案保持（不复位到默认方案） |

### v9 — 输入"ts"卡死修复（07-06 夜间）

- **v6 临时修复**：在 `updateKeyDisplay`/`output` 消费侧加防御（防崩溃）
- **v7 根因修复**：`findAllPartialSplits` 对非拼音前缀输入返回空数组 → 兜底逻辑确保永远返回 ≥1 条记录
- **效果**：7 个非拼音前缀（ts/tz/cs/zs/bz/pt/kk）不再崩溃，7 个正常音节 100% 向后兼容

### v10 — 单音节不可切换修复（07-06 夜间）

- **Bug**：`xian` 等单音节默认显示"未拆分"状态，无法切换到 `xi|an`
- **根因**：空音节条目排序优先于真实拆分方案
- **修复**：空音节条目**后移**（末尾而非首位）
- **影响**：`xian`/`mian`/`piao`/`shang`/`fangan` 等正常显示完整音节

### v11 — 拆分方案切换后联想词自适应（07-06 夜间）

- **Bug**：切换拆分方案后词组候选不变化（`syllables.join('')` 对同一输入始终相同）
- **修复**：多音节时词组字数须匹配音节数（`xi|an` → 仅展示 2 字词如"西安"）

### v12 — 候选区 UI 重构：分区 + 独立翻页（07-06 夜间）

- **设计**：将单一候选区拆分为**词组区**（上，蓝色系）和**单字区**（下，紫色系），各自独立翻页
- **实施**：修改 3 个文件（`virtualkeyboard.js` HTML 模板 + `virtual_keyboard_demo.html` CSS + `pinyin_association.js` 渲染逻辑）
- **翻页状态**：`phrasePage`/`charPage` 独立管理

### v13 — 四项关键优化（07-07 上午）

| # | 问题 | 修复 |
|---|------|------|
| 1 | 连续输入联想词消失（如"天津市"后输入"h"） | `sylCount` 过滤器 `!==` → `>`，允许字数 ≤ 音节数的词组显示 |
| 2 | 唯一拆分方案时分隔符仍可点击 | `meaningfulCount` 移至函数顶部 + 条件增加 `> 1` |
| 3 | 布局重构：候选词移至键盘右侧 | 新增 `.kb-candidates-row` 横向容器 + `.candidates-sidebar` 侧边栏（200px）；键盘宽度 850px→1080px；翻页按钮改为 ▲▼ |
| 4 | localStorage 缓存高频联想词 | `_recordWordSelection()`/`_sortCandidatesByFrequency()` 持久化用户选择频率 |

### v14 — 布局再调整：联想词右侧 + 候选字回上方（07-07 上午）

- 用户反馈后调整：单字区回到键盘上方横向平铺（紫色系），词组区留在右侧侧边栏与键盘等高
- 翻页按钮改回 ◀▶，宽屏 `num` 从 6 改回 10

### v15 — 展开式候选面板（07-07 上午 ~ 中午）

- **设计**：仿搜狗/百度输入法，折叠时单行候选栏 + 展开时全屏面板遮盖键盘
- **折叠状态**：联想词(蓝)+候选字(紫)同行，右侧 ▼ 展开按钮
- **展开面板三栏**：
  - **左栏**（110px）：拼音音节垂直排列，活跃 `#534AB7`/非活跃 `#7F77DD`
  - **中栏**（flex:1）：联想词(蓝,2行) → 分隔线 → 候选字(紫,2行,首选高亮 `#CECBF6`) → 翻页
  - **右栏**（100px）：返回(紫底▲) → 退格(灰底⌫) → 重输(灰底↻)
- **新增函数**：`togglePanel()`/`_getMeaningfulCount()`/`_renderPinyinSplit()`/`_renderCandidatesToContainers()`/`_buildCandidatesFromSyllables()`
- **覆写函数**：10 个核心函数（`_rebuildCandidates`/`updateVal`/`emptyZH`/`showContextSuggestions`/`output`/`backspace`/`closeVK`/`input`/`pageUp`/`pageDown`）

### v16 — 面板 Bug 修复与优化（07-07 中午）

| # | 问题 | 修复 |
|---|------|------|
| 1 | 选完候选后面板自动收起 | `output()` 末尾增加 `_pinyinBuffer` 空时自动 `togglePanel(false)` |
| 2 | "fankong"拆分为 fan'kong 后 fan 的候选不出现 | 排序改为「完整拆分优先 → 音节数升序 → 剩余长度升序」 |
| 3 | 展开面板翻页异常 | 不再使用 `vkHide` 初始隐藏，改用 `_applyPagination()` 统一 `.show()/.hide()` 控制 |
| 4 | 移除单字/词语切换按钮 | 删除了 `toggle-char`/`toggle-word` 两个事件及对应 HTML/CSS |
| 5 | 折叠状态单行显示 | `.output-ZH` 改为 `nowrap` + `overflow: hidden` |
| 6 | 面板候选数调整 | 展开模式 `num` 从 20 改为 24（匹配 4 行 × 6 列） |

### v17 — 三项关键修复（07-07 中午 ~ 下午）

| # | 问题 | 修复 |
|---|------|------|
| 1 | 清空重输后未返回主界面 | 重输按钮事件 + `togglePanel(false)` |
| 2 | 短拼音（如"t"）候选过多导致卡顿 | 前缀匹配增加 `charCandidates.length < 30` 限制 |
| 3 | 拼音输入中数字键直接上屏 | 新增 `_pendingDigits` 缓冲区+显示+自动提交+退格优先删除 |

### v18 — 折叠行溢出适配修复（07-07 下午）

- **新增**：`_fitAndHideOverflow()` 函数，动态测量实际宽度，超出容器时自动隐藏超出的候选词
- **flex-shrink 修复**：`.output-ZH .word` 添加 `flex-shrink: 0`，防止词被压缩

### v19 — 性能优化：wordDict JIT 异步加载（07-07 下午）

**问题诊断**：
- `pinyin_association.js` 10.1MB，其中 7.45MB (99.2%) 为内联 wordDict（262,994 个拼音键，372,535 个词条）
- 同步 `<script>` 加载阻塞 UI 渲染
- `for (var key in wordDict)` 前缀匹配遍历全部 262K 键，每键输入触发

**优化方案**：

| 优化项 | 优化前 | 优化后 | 效果 |
|--------|-------|-------|------|
| 词库存储 | 内联 JS 对象字面量 (7.45MB) | 26 个按首字母分片的 JSON 文件 | 异步加载，不阻塞 UI |
| 加载策略 | 页面加载时全部解析 | JIT 按需加载（输入首字母时触发） | 首次加载仅 ~400KB |
| 前缀匹配 | `for key in wordDict` 遍历 262K 键 | `_dictKeysByLetter[letter]` 遍历 ~10K 键 | 提升 26x |
| 文件大小 | `pinyin_association.js` 10.1MB | `pinyin_association.js` 64KB | 缩减 99.2% |

**新增模块**：
- `ensureDictLoaded(letter, callback)` — XHR + JSON.parse 异步加载指定首字母分片
- `loadAllDicts(onComplete)` — 预加载全部 23 个分片
- `ensurePinyinDictLoaded(pinyin)` — 智能触发所需分片加载
- `_dictKeysByLetter` — 字母分组索引（加载时自动构建），前缀匹配 262K → ~10K

---

## 二次开发指南

### 修改词库

1. **新增单个词条**：编辑 `dict/{letter}.json` 中对应首字母的文件，或直接添加到 `pinyin_association.js` 的全局 `_wordDict`（运行时）：

```javascript
// 运行时添加（持久化需同时修改对应 JSON 分片）
window._wordDict["pinyinkey"] = ["候选词1", "候选词2"];
```

2. **批量更新行政区划**：
   - 获取最新数据（如从民政部官网）
   - 替换 `ok_data_level3.csv` 或 `SysRegion.sql`
   - 运行对应 Python 脚本重新生成

### 自定义键盘样式

所有键盘样式定义在 `virtual_keyboard_demo.html` 的 `<style>` 标签中，主要 CSS 类：

| CSS 类 | 作用 |
|--------|------|
| `.keyboard-full` | 全键盘容器 |
| `.key-bg` | 按键通用样式 |
| `.pinyin-input` | 拼音显示/编辑区 |
| `.candidate-item` | 候选字/词项 |
| `.pinyin-sep-clickable` | 可点击拆分分隔符 |
| `.pinyin-toggle` | 拆分方案切换按钮 |

### 定制拆分过滤规则

拆分方案的过滤规则集中在 `pinyin_association.js` 的以下函数：

- `_findCompleteSplits(input)` — 完整方案过滤器（含单辅音黑名单）
- `checkAlternativeAt(sepIndex, syllables)` — 分隔符可点击判定
- `_singleConsonants` — 单辅音黑名单变量（按需增删）

### 减小 JS/JSON 体积

若不需要行政区划联想功能，可移除 `dict/` 目录，仅保留 `pinyin_association.js`（64KB） 和 `virtualkeyboard.js`。此时：

- 拼音输入正常运作
- 失去：词组联想、上下文预测、行政区划快速输入、拆分方案切换
- `pinyin_association.js` 启动时日志会报告已加载 0 个分片（无报错）

### 嵌入框架/平台

需要根据目标平台的 DOM 操作方式，重写 `virtual_keyboard_demo.html` 中的桩函数：

```javascript
// 核心桩函数
function topPage()       → 返回框架页面对象
function setInputValueAndSync(input, value) → 将键盘值写入目标字段
function IFRamp_callback(result) → 手写输入回调
```

### 性能优化方向

| 方向 | 方案 | 状态 |
|------|------|------|
| **减小 JS 体积** | 词库已外置为 JSON 分片，JIT 按需加载 | ✅ **已完成**（10.1MB → 64KB） |
| **前缀匹配加速** | 字母分组遍历（262K 键 → ~10K 键/次） | ✅ **已完成** |
| **减少重复计算** | 为 `findAllPartialSplits` 增加 LRU 缓存（已部分实现 `_splitPartialCache`） | 进行中 |
| **Web Worker** | 将 JSON 解析移至后台线程 | 待优化 |
| **触屏体验** | 增加键盘位置记忆（localStorage）、自适应屏幕尺寸 | 待优化 |

---

## 已知限制

| 限制 | 说明 | 影响 |
|------|------|------|
| **多音字** | 词库基于 pypinyin 自动生成，未标注实际读音。如"朝阳"可能被标注为 `zhaoyang` 而非 `chaoyang` | 用错拼音无法查到该地名 |
| **文件体积** | `dict/` 目录合计 ~8.7MB，但按需加载每分片仅 ~400KB | 首次输入某首字母需等待 XHR 加载 |
| **内存占用** | 浏览器解析后词典常驻内存 | 输入多个首字母后逐步累积，全量加载后 ~8.7MB |
| **浏览器兼容** | 依赖 ES5+ 特性（`Array.forEach`、对象字面量等） | IE11 及以下不支持 |
| **单字母元音** | `a`、`o`、`e` 等单字母元音音节不会从拆分方案中过滤 | 极少数情况（如 `piao` → `pi|a|o`）可切换至此罕见方案 |
| **数据时效** | 行政区划数据截至 2024 年 | 新设/撤销的行政区无法输入 |
| **无离线能力** | 依赖 jQuery CDN | 纯离线环境需本地托管 jQuery |
| **异步加载** | `pinyin_association.js` 通过 XHR 按需加载 `dict/{letter}.json` 分片 | 首次输入某个首字母时需等待 ~50-200ms 加载对应分片（仅首次，后续从缓存读取） |
| **部署要求** | `dict/` 目录需与 HTML 同目录部署 | 支持 HTTP/1.1 即可（XHR + JSON）|

---
