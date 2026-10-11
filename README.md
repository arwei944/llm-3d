# 大语言模型内部机制 · 推理 + 训练全流程 3D 可视化

在浏览器里**真的训练**一个微型 Transformer，再把它的**真实中间张量**逐格渲染成 3D 动画。
推理与训练两个模式都不是预编排的假动画 —— 画面上的每个数字都来自同一次真实前向 / 反向计算。

> 核心原则：**不使用假数据**。页面上出现的注意力矩阵、MLP 激活、梯度范数、权重值、loss，
> 全部由 `src/model.js` 现场算出，并与 `tools/trace.js` 在 Node 端独立计算的参考值逐项比对（当前 13/13 组张量，最大绝对误差 0）。

---

## 界面结构（三栏）

```
┌──────────┬────────────────────────┬───────────────┐
│ 左栏     │ 中栏：3D 舞台          │ 右栏          │
│ 品牌     │                        │ 互动参数      │
│ 模块导航 │  真实张量实时渲染      │ 当前步骤      │
│ 讲解动画 │                        │ 层进度 / 序列 │
│ 状态     │                        │ 视角 / 播放   │
│ 图例     │                        │ 真实运算示例  │
│ 快捷键   │                        │ 说明          │
└──────────┴────────────────────────┴───────────────┘
```

- 栅格 `264px / 1fr / 392px`，**行高显式锁 `minmax(0, 1fr)`**：
  隐式行默认 `auto` 会被内容撑高，子栏的 `height:100%` 就会解析成行高（实测撑到 2895px，
  两栏出现整页滚动条）。子栏一律带 `min-height: 0`，各自内部滚动。
- 断点：1360px 收窄为 232/340；1100px 变成「左栏 + 上舞台下控制」两列；820px 以下单列堆叠。
- 影片模式（讲解动画）同时收起左右两栏，3D 占满全屏。
- 所有图标为**内联 SVG**（`src/icons.js`，24×24 视框、1.7px 线宽、`stroke=currentColor`），
  任意 DPI 下都是矢量清晰的，且能跟随状态变色；模块用 `icon: 'gear'` 这样的名字声明，
  引擎渲染导航时按名字取图标。页面上不存在任何 emoji / 文字符号充当的图标。

---

## 快速开始

### 方式一：直接双击（file://）

打开 `dist/index.html` 即可。单文件、零依赖、离线可用（776 KB）。
所有脚本已内联，无需服务器、无需构建。

### 方式二：模块化开发

```bash
node server.js          # 静态服务 http://127.0.0.1:8712
```

然后访问 `http://127.0.0.1:8712/`。这样修改 `src/*.js` 后刷新即可生效，不改动 `dist/`。

### 重新打包单文件

```bash
node build.js           # 把 CSS + 全部 JS 内联进 dist/index.html
```

---

## 模型规格

| 项 | 值 |
|---|---|
| 词表 V | 12（`0-9` `·` `\|`） |
| 隐藏维 D | 32 |
| 注意力头 NH | 4（每头 d_h = 8） |
| 前馈维 FF | 64 |
| 层数 NL | 2 |
| 上下文 CTX | 16（可视化用 14） |
| 位置编码 | RoPE（theta = 10000，成对旋转） |
| 归一化 | RMSNorm（带可学习增益 g） |
| 激活 | GELU（tanh 近似） |
| 优化器 | AdamW（β₁=0.9, β₂=0.999, ε=1e-8, weight decay 1e-4） |
| 梯度裁剪 | 全局范数裁剪，阈值 0.5 |
| 学习率 | 3e-3，带 warmup |
| 数值精度 | 全程 `Float64Array` |

**为什么必须 Float64**：用 Float32 时数值梯度校验会被精度噪声淹没（相对误差 ~1e-3），
无法验证反向传播是否真的写对。改成 Float64 后解析梯度与有限差分才能对到 1e-9 量级。

**为什么用 `1/√fan_in` 初始化**：RMSNorm 输出是单位尺度，若线性层仍用 0.02 的小尺度初始化，
前向尺度会逐层放大约 4–5 倍，两层之后 logits 直接爆成 NaN（实测）。

**语料是一门"微型语言"，不是随机数字**（`model.js` 的 `WORDS`）：
词表里有 6 个三字符词 `[159] [207] [381] [649] [025] [738]`，语料就是它们随机拼接。
早期版本是"每个数字独立随机的块"，那其实没有任何可学结构 —— 数字位的条件熵就是 ln(10)，
训练再久 loss 也只能在熵底附近抖动，"它怎么学会的"讲出来毫无说服力。
换成有限词表后（词内可预测、词尾必接 SEP、SEP 后必是新词首字符），这些模式是真的能学出来的：

| 指标 | 随机基线 | 训练 900 步后 |
|---|---|---|
| 下一 token 预测准确率 | 8.3% | **82.6%** |
| 平均交叉熵 | 2.48（= ln 12） | **0.39** |

具体例子：`15920738164` → `9`（99.9%），正好补全词块"649"；词块结束后 → `|`（99.9%）。
页面默认提示 `159207381649` 恰好就是前四个词块，与语料是同一门语言。

---

## 科普引擎（模块系统）

整个项目是一台**模块化的科普引擎**：一个模块 = 一个文件 + 一次 `LLMEngine.register({...})`。
引擎负责生成导航按钮、注入参数面板、生成相机行、驱动主循环 tick、切换 3D root 与 overlay，
所以新增功能**不需要改动 `app.js` / `index.html`**（除了加一行 `<script>` 和打包清单）。

| 模块 | id | 类型 | 内容 |
|---|---|---|---|
| ⚙ 推理 | `fwd` | 内置 | 前向传播 25 个原子步骤 |
| 🔥 训练 | `train` | 内置 | 训练闭环 7 阶段 + loss 曲线 |
| 🎛 采样实验室 | `explore` | 3D 互动 | 温度 / Top-K / Top-P 实时驱动真实 forward，概率条 + 采样 + 熵读数 |
| 🔎 注意力探针 | `attn` | 3D 互动 | 选层 / 头 / 查询位置，逐格看真实注意力概率与 top-3 |
| 📚 上下文与缓存 | `kv` | 3D 互动 | 拖 T 看因果掩码三角 + 真实 K/V 缓存墙，O(T²) vs O(T) |
| 🗺 科普图谱 | `topics` | overlay | 十个维度横向扩展，3 张卡带真实计算 demo |

**新增一个模块**（示例）：

```js
// src/viz-demo.js
(function () {
  window.DemoViz = {
    boot(ctx) {                       // ctx = { model, core, LM, el }
      const root = new THREE.Group(); ctx.core.scene.add(root);
      // …搭自己的 3D 场景…
      return {
        root,                          // 引擎负责显隐
        tick(dt, now) { },             // 主循环钩子
        applyCam(name) { window.LLMEngine.setCam(ctx.core, CAMS[name]); },
        getHud() { return { stage, desc, formula, pill }; },
        getLayers() { return [{ n, p, val }]; },   // 侧栏「层进度」通用行
        getSeq() { return '文本'; },
        panelHTML: '<div class="mod-sec">…你的控件…</div>',
        panelInit(host) { /* 绑定控件，改完调 recompute() */ },
      };
    },
  };
  window.LLMEngine.register({
    id: 'demo', title: '我的模块', icon: '🧪', kind: 'viz3d',
    tagline: '一句话说明', hint: '切到该模块时的提示',
    camRows: [['overview', '全景'], ['close', '特写']],
    boot: (ctx) => window.DemoViz.boot(ctx),
  });
})();
```

`kind: 'overlay'` 的模块改为返回 `{ el, onShow }`（普通 DOM，可覆盖在画布上），
引擎会自动给页面加 `body.mod-overlay` 隐藏 3D 相关侧栏区块。

相机助手：`LLMEngine.setCam(core, { pos: [x,y,z], tgt: [x,y,z] })`
—— 自研 OrbitControls 用球坐标（`theta = atan2(dx, dz)`，`phi = acos(dy/r)`），
不要直接写 `controls.target.set()`（`target` 是普通对象，没有 `.set`）。

---

## 内置模式详解

### 推理模式（前向传播）

把一次完整前向拆成 **25 个原子步骤**（`src/viz-forward.js` 的 `STEPS`），每层 9 步：

```
① Token → Embedding 查表
② 位置编码 RoPE
  ┌─ 每层（×2）────────────────────────────
  │ ③ RMSNorm 归一化
  │ ④ QKV 投影
  │ ⑤ 多头因果注意力
  │ ⑥ 注意力权重可视化      ← 三角热力图，格子 = 真实 softmax 概率
  │ ⑦ 残差连接①
  │ ⑧ RMSNorm②
  │ ⑨ MLP 前馈（64 维）
  │ ⑩ 神经元激活            ← 64 个球的高度 = 真实 h_act
  │ ⑪ 残差连接②
  └───────────────────────────────────────
⑫ 最终 RMSNorm
⑬ LM Head 投影
⑭ Softmax 转概率
⑮ Top-p 采样
⑯ 采样出下一个 token     → 自回归追加，循环
```

**视角预设**：全景 / 层内 / 矩阵 / MLP / 输出头 / Token。

### 训练模式（完整闭环）

每跑完一轮脚本，就**真的执行一次 `trainStep()`** —— 权重与 loss 同步变化，跑得越久 loss 越低：

```
① 采样训练批次 (x, y)     ← 真实语料窗口，y 是"下一个 token"
② 前向传播               ← 与推理共用同一条前向路径
③ 计算交叉熵损失 L = -log p(y|x)
④ 反向传播 ∂L/∂θ         ← 梯度柱高度 = 各参数块真实 ‖∂L/∂θ‖
⑤ 梯度裁剪               ← 显示真实 ‖g‖ 与裁剪系数
⑥ AdamW 更新权重         ← 立方体 = W₁ 真实权重；橙色块 = 真实 Adam 一阶矩
⑦ 记录 loss，下一轮
```

**视角预设**：全景 / 批次 / 前向 / 损失 / 反向 / 优化器 / Loss 曲线。

---

## 讲解动画（MP4 + 回放页，带中文语音解说）

约 536 秒的完整讲解片，四幕：**原理 → 走完一次推理 → 这些数是真的 → 它怎么学会的**，
共 28 个场景、81 句台词，配音为微软 Edge 神经语音（zh-CN-XiaoxiaoNeural，+20% 语速）。
渲染分辨率 1920×1080 / 24fps。

| 交付物 | 位置 | 说明 |
|---|---|---|
| 视频（含语音） | `out/llm-narration.mp4` | h264 / yuv420p / faststart，AAC 128k |
| 视频（无声版） | `out/llm-narration-novoice.mp4` | 合流前的画面母版 |
| 回放页 | `dist/film.html` | 双击即看，带 28 个章节导航、字幕、倍速、快捷键 |
| 字幕 | `out/llm-narration.srt` / `.vtt` | 通用 SRT 与网页 VTT 各一份 |
| 章节 | `out/chapters.json` | 每个场景的起止时间与标题 |

回放页 `dist/film.html` 与 `dist/llm-narration.mp4`、`dist/llm-narration.vtt` 同目录，
`dist/` 整个文件夹拷走即可分享（离线、零依赖）。字幕不走 `<track>`（file:// 下会被 CORS 拦），
而是把台词内联进页面由 JS 按 `currentTime` 渲染，所以双击打开也能正常显示。

**重新生成**（改了 `src/narration.js` 的脚本之后）：

```bash
node build.js          # 1. 重新打包 index.html
node extract-lines.js  # 2. 提取台词行 → out/_lines.json
python retime-film.py  # 3. TTS 重合成(+20%)，按语音时长重解各场景 dur 并写回 narration.js
node build.js          # 4. 用新 dur 再打包一次（retime 改了脚本）
node make-subs.js      # 5. 生成 SRT / VTT / chapters.json
node render-all.js     # 6. 逐帧导出并拼接无声 MP4（分段防崩，约 45 分钟）
python assemble-vo.py  # 7. 逐行铺轨 373→536s 音轨并与视频合流（AAC）
node build-film.js     # 8. 生成 dist/film.html 并拷贝媒体
```

**配音管线**（`retime-film.py` / `assemble-vo.py`，需要 edge-tts + numpy + ffmpeg）：
81 句台词逐行 TTS（微软 Edge 神经语音）后实测时长；台词密度高于画面时长时，
`retime-film.py` 按「每行语音 + 0.4s 呼吸必须装进本行到下一行的窗口」逐场景解出最小 `dur`
（只增不减）写回 `src/narration.js`，再全量重渲染 —— 这是让语音不漂移、不截断的根本手段
（实测：默认语速语音总长 498s，硬塞 373s 视频会平均漂移 16s 且尾部截断 37s）。
`assemble-vo.py` 把各行音频按字幕时间精确铺进 24kHz 单声道音轨（10ms 淡入淡出防咔哒），
与画面合流；若个别行仍溢出会自动提速重合成（上限 +70%）兜底。

**离线导出的原理**：`src/narration.js` 的 `seek(t)` 是纯函数 —— 给定时刻 t，画面（相机、
步骤、训练阶段、字幕）完全确定。因此同一套脚本既能驱动页面里的实时播放，也能驱动
逐帧离线导出，两者逐帧一致。导出走 CDP 逐帧截图 → `ffmpeg image2pipe` 管道，
中间帧不落盘（`record-film.js`）；渲染前主循环置 `App.recFreeze` 让出 CPU。

---

## 真实运算示例面板

左侧「真实运算示例」面板对固定输入 `1592`（token id `[1,5,9,2]`）实时跑一遍前向，
把 13 组中间张量逐个摊开显示，并与 Node 端参考值比对：

- ① Embedding 查表
- ② RMSNorm 归一化系数与结果
- ③ Q/K/V 投影
- ③′ RoPE 旋转后 Q
- ④ 注意力原始分数 `score = q·k/√d_h`（缩放后，softmax 前）
- ④′ 减最大值（数值稳定）：`e = exp(score - max)`
- ④″ 归一化：`p = e/Σe`
- ④‴ softmax 结果（模型内部张量）—— 与 ④″ 手算值应完全一致
- ⑤ 加权求和 V
- ⑥ MLP 升维预激活
- ⑥′ GELU 激活后
- ⑦ 输出 logits
- ⑦′ Softmax 概率（Σp 应为 1）

面板底部会给出两处自检：
- `softmax 手算一致性 ✓` —— 用**全精度**重算 softmax 与模型内部 `probs` 张量比对（容差 1e-6）
- `✓ 与 Node 端参考值一致` —— 与 `data/trace.json` 逐项比对

两处自检都必须在**未舍入**的前提下判定：面板上显示的数字为了可读性做了 4 位舍入，
若直接拿舍入值比对，累计误差可达 ~2e-4，会误报不一致。

---

## 文件结构

```
llm-3d/
├── index.html              模块化入口（开发用）
├── styles.css              浅色主题样式（宣纸 / 水墨配色）
├── build.js                打包：内联成 dist/index.html 单文件
├── server.js               静态服务（127.0.0.1:8712）
├── README.md
│
├── src/                    ← 权威源码
│   ├── model.js            ★ 核心：手写 forward / backward / AdamW / 采样
│   ├── icons.js            全站内联 SVG 图标库（currentColor）
│   ├── core.js             共享层：调色板、文字精灵、圆角盒、场景工厂
│   ├── engine.js           ★ 科普引擎：模块注册表 / 导航 / 面板托管 / 相机助手
│   ├── viz-forward.js      推理模式可视化（25 个原子步骤）
│   ├── viz-train.js        训练模式可视化（闭环 7 阶段）
│   ├── viz-explore.js      🎛 采样实验室（温度 / Top-K / Top-P 实时调参）
│   ├── viz-attn.js         🔎 注意力探针（选层 / 头 / 位置看真实概率）
│   ├── viz-kv.js           📚 上下文窗口与 KV 缓存（掩码三角 + 真实缓存墙）
│   ├── topics.js           🗺 科普图谱（十维度卡片墙，含 3 个真实计算 demo）
│   ├── narration.js        讲解动画脚本（28 场景 / 81 句台词 / seek(t) 纯函数）
│   ├── trace.js            「真实运算示例」面板 + 与参考值比对
│   ├── app.js              启动、引擎装配、HUD、交互绑定、主循环
│   ├── three.min.js        three.js r160（UMD）
│   └── orbit-controls.js   自实现轻量轨道控制器（r160 UMD 不含 addons）
│
├── data/
│   ├── trace.json          Node 端独立算出的参考值
│   └── trace.js            同上，浏览器可直接加载的版本（自动生成）
│
├── tools/
│   └── trace.js            生成上述参考值：node tools/trace.js
│
├── dist/
│   └── index.html          ★ 唯一交付物（883 KB 单文件，双击即用）
│
├── verify-dist.js          验证：模式切换 + 真实运算比对 + 异常捕获
├── verify-engine.js        验证：科普引擎 6 个模块、互动控件真实计算、科普图谱 demo、零异常
├── verify-layout.js        验证：三栏几何、矢量图标覆盖、影片模式收起两栏、窄屏折叠
├── verify-views.js         验证：逐视角取景截图（停在"该视角真正要看的那个步骤"上）
├── verify-final.js         验证：长序列下量矩阵/MLP 的屏幕包围盒
├── probe-cam.js            探针：量化各相机预设下目标物的屏幕范围与偏移
│
├── shots/                  验证截图
└── archive/                早期单文件版与脚手架存档（不作为交付物）
```

> `archive/` 里是早期的单文件版本（`llm-3d-visualization.html`）与当时的 `viz.js` / `model.js` /
> `test-*.js` 脚手架。它们**未同步本次的数值修复**，仅作历史存档。当前以 `src/` + `dist/` 为准。

---

## 验证方式

### 数值正确性：数值梯度校验

反向传播是否写对，用有限差分对照解析梯度：

- 解析梯度 vs 数值梯度，相对误差应 < 1e-6
- 逐层检查；**若第 1 层对、第 0 层错，问题一定在跨层传导处**

这套方法实测抓到过一个真 bug：多头注意力拼接后回传时，
`dhead` 被误从 `dv` 读取，而正确做法是从 `dcat` 按多头分片播种。层 0 解析梯度恒为 0 才暴露出来。

### 端到端验证（CDP 驱动 headless Chrome）

`verify-dist.js` / `verify-views.js` 通过 Chrome DevTools Protocol 无依赖地驱动 headless Chrome
（Node 22 内置 `WebSocket` + `fetch`，不需要 playwright/puppeteer）：

```bash
# 先起一个 headless Chrome（后台常驻）
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --headless=new --remote-debugging-port=9334 \
  --user-data-dir=C:\temp\cdp-llm3d --disable-gpu --window-size=1600,1000 about:blank

NO_PROXY='*' node verify-dist.js     # 模式切换 / 真实运算比对 / 异常捕获
PORT=9334 NO_PROXY='*' node verify-engine.js   # 科普引擎：6 模块 / 互动控件 / 科普图谱 demo
PORT=9334 NO_PROXY='*' node verify-layout.js    # 三栏布局 / 矢量图标 / 响应式折叠
NO_PROXY='*' node verify-views.js    # 逐视角取景截图
```

**几个踩过的坑（写在这里省得再踩）：**

- **相机目标不是 Vector3**。自研 `OrbitControls` 的 `controls.target` 是普通对象 `{x,y,z}`
  且相机用球坐标描述，写 `controls.target.set(...)` 会直接抛
  `TypeError: controls.target.set is not a function`。用引擎的
  `LLMEngine.setCam(core, {pos, tgt})` 统一换算（`theta=atan2(dx,dz)`、`phi=acos(dy/r)`）。
- **在 XY 平面上摆的矩阵要正对镜头看**。注意力网格活在 XY 平面，
  「俯视」对它来说是掠射角，会读成阶梯而不是矩阵 —— 相机放在 +Z 轴正前方才看得清。
- **`tok()` 只接受单个字符**，整串转 id 序列要用 `tokSeq(str)`（否则 `forward()` 里
  `ids.slice is not a function`）。
- **模块的面板 HTML 挂在实例上**（`inst.panelHTML`），引擎按实例注入并调 `inst.panelInit`；
  写在模块定义对象上不会生效，参数面板会静默不出现。

- **必须清空旧页面再导航**。同一 `file://` URL 再次导航可能命中内存缓存，
  上一次构建的异常会混进本次日志，造成「明明已经修好却仍报错」的假象。
  做法：先 `Page.navigate('about:blank')`，清空日志数组，再导航到产物。
- **截图前要先把动画停在对应步骤**。在「① Embedding」就点「矩阵」视角，
  注意力矩阵还没画出来，截出来的图没有参考价值。
- **`Vector3.project()` 依赖上一次渲染缓存的 `matrixWorldInverse`**。
  在 `Runtime.evaluate` 里刚改完相机就投影，量到的可能是上一帧的状态——
  需要在同一次求值内手动 `camera.updateMatrixWorld(true)` + 反转矩阵。
- **别用「两端点投影取平均」估算屏幕中心**。透视投影下，端点投影的均值
  ≠ 中点的投影。要判断取景是否居中，直接投影相机目标点，它必然落在画布中心。
- **矩阵在序列短时只显示网格一角**。格子位置编码 token 索引，`i >= T` 的格子隐藏，
  16×16 网格在 4 token 序列下只有左上角 4×4 三角亮起，看起来"相机太远"，其实是内容太少。

当前结果：

```
推理步骤总数: 25                    ← 2 全局 + 2 层 × 9 + 5 输出
真实运算比对: 比对 13/13 组张量，最大绝对误差 0.00e+0 | ok=true
             attnConsistent=true | pSum=1
mode: train（切换生效）
错误总数: 0
```

> CDP 连接时必须 `NO_PROXY='*'`：本机环境会注入 `http_proxy`，该代理访问 `127.0.0.1` 会返回 502。

---

## 已知限制

- 训练模式的 loss 曲线在前 200 步按「当前历史长度」铺满整宽，攒满后等价于固定窗口滚动。
- `dist/index.html` 是构建产物；**改源码后必须重跑 `node build.js`**。
- 若修改了 `src/model.js`（影响前向数值），**必须重跑 `node tools/trace.js`** 重新生成参考值，
  否则「真实运算示例」面板的一致性自检会失败。
- 训练模式每轮脚本约 6 秒执行一次真实 `trainStep()`，所以「迭代数」增长较慢——这是刻意的，
  为了让人看清每一步在做什么；调高「速度」可加快。
- 矩阵热力图在序列较短时只点亮 16×16 网格的一角（格子位置编码 token 索引），
  随着自回归生成推进会逐渐铺满。
- `archive/` 里的早期单文件版未同步本次数值修复，仅作历史存档。
