# 主窗口 UI 重构记录 — 2026-09-11

基线 `4b43428`。本次只动桌面端（`src/main`、`src/preload`、`src/renderer`），
手环端与 `core/` 的 Rust 代码不在范围内。

---

## 一、做了什么

### 1. 视觉世界替换：bento → flush split

改之前是「白卡浮在 `#e9ece9` 灰底上」——侧栏、顶栏、内容区三个 18px 圆角块被 10px 灰槽隔开。
问题不在好看与否，在于：

- 三个 shadow token 定义了却只被用了 2 次，卡片并不真的靠阴影浮起，只是被灰槽隔开。
  **「浮」是假的**，于是浮起的视觉语言和实现自相矛盾。
- 灰槽吃掉的不是像素，是视觉连续性。扫视时每个区块都要单独建立一次上下文，
  工具型界面（Operate 模式）最不需要这个。
- 18px 圆角在 44px 高的顶栏上占了 40% 高度，顶栏读起来像药丸不像栏。

改之后是三级明度 + 1px 实线分割，零槽沟、零阴影：

| 层级 | token | 承载 |
|---|---|---|
| 底层 chrome | `--bg-canvas` | 侧栏，右侧 `border-r border-strong` |
| 主操作面 | `--bg-surface` | 顶栏（`border-b`）+ 内容区底 |
| 内容区块 | `--bg-subtle` | 所有页面内的卡片/区块，`rounded-[10px]`，**无边框** |

Agent 卡保留但降级：圆角 18→10px、去掉自身边框、底色改 `--bg-subtle`，锚点卡仍用
`--anchor-wash`。**没有拍平**——三张卡是并列同构的独立数据单元，
36px 的大数字去掉边界会糊成一片。

> **未闭环**：三级明度在浅色主题下拉得不够开。`--bg-canvas` `#e9ece9` 与
> `--bg-subtle` `#f5f8f6` 在白底旁边差不到一档，而 `--border-strong`
> （浅色 10% alpha）画出来的 1px 线几乎不可见。flush split 的全部分层责任压在这两条线上。
> 下一轮需要：侧栏底色再压深一档、分割线单开一个更重的 `--border-divider` token。

### 2. 字体：汉字宋体 + 拉丁无衬线

```css
--pulse-font-sans:
  "Noto Sans", "Segoe UI Variable Text", "Segoe UI",
  "Noto Serif SC Light", "Noto Serif SC", "Source Han Serif SC", "思源宋体", serif;
```

浏览器按字符逐个回退：Noto Sans 不含汉字，所以中文自动落到后面的宋体。

选 Noto Sans 而不是继续用宋体跑数字，有三个具体理由：

1. Noto Sans 与 Noto Serif SC 同属 Noto 超级家族，垂直度量与笔形逻辑天生对齐。
2. 界面里有 8 处 `tabular-nums`，只有字体真带 tabular figures 才生效；
   宋体数字不等宽，`62%` 跳到 `100%` 时整块会抖。
3. 21 处 `text-[10px]` + 3 处 `text-[9px]` 全是标签与倒计时，这个尺度衬线数字是糊的。

`body` 设 `font-weight: 300`（汉字要 Light）并加 `font-synthesis-weight: none`，
禁止浏览器给 Noto Sans 合成假细体——否则 10px 的拉丁会虚掉。

### 3. 缺陷修复

| 问题 | 位置 | 处理 |
|---|---|---|
| 主窗口拖不动 | `frame: false` 但顶栏无拖拽 | 顶栏加 `.titlebar-drag` 原生拖拽 |
| 跨屏拖动界面整体放大 | 手动 `setPosition` 跟随 | 同上，交还系统处理 DPI 过渡 |
| 浅色滚动条不可见 | `.custom-scrollbar` 从未定义 | 补定义，thumb 走语义 token |
| 冷启动闪一帧近黑 | `backgroundColor: '#0d0f14'` | 改 `#e9ece9`，与 `--bg-canvas` 对齐 |
| `--text-muted` 白底 2.7:1 | 低于 AA 4.5:1，且用在最小字号 | 浅色 `#6f7d76`、深色 `#8b9a93` |
| 全渲染层仅 1 处焦点样式 | — | `:where(...)` 零特异性全局焦点环 |
| Toggle 读屏读出空 | `sr-only` 无 label | 新增 `label` prop → `aria-label` |
| 首帧就渲染「未检测到 Agent」 | `state` 初值 null | 新增 `loading`，渲染同构骨架卡 |
| 刷新按钮点了没反应 | `refresh` 无进行中状态 | 新增 `refreshing` + 旋转 + 禁用 |
| Live/估算 语义色反了 | 权威数据用了警告琥珀 | 对调 |
| 顶栏状态点常绿 | 硬编码 `--status-success` | 跟随 `updatedAt` 与 `agentCount` |
| 死按钮当成品摆着 | 「导出记录」「检查更新」 | `aria-disabled` + 禁用样式 + tooltip |
| 「重置于 今天 X:XX」跨天写错 | 无条件写「今天」 | 按相对倒计时算目标日期 |
| 概览页跑两份 15s 轮询 | `AgentSection` 无条件调 hook | 拆组件，有 `state` prop 就不调 |
| 悬浮窗停在上/下边回不去 | 持久化覆盖默认值 | 右键菜单新增「重置到右侧」 |

---

## 二、踩的坑

### 1. 手动窗口拖拽跨不了 DPI 边界

本机双屏：主屏 `1920×1080 @100%`，副屏在右侧 `X=1920`、`1536×864` 逻辑
（= 1920 物理 @125%）。**手动 `setPosition` 跟随在窗口跨过 DPI 边界时会让整个界面突然放大**，
因为渲染进程重新按 125% 绘制，而手动跟随对这次过渡一无所知。

原生 `-webkit-app-region: drag` 由 Windows 负责过渡，没有这个问题，
还白送贴边吸附和双击最大化。

**但原生 drag 会吞掉该区域的右键与所有指针事件**——项目里侧栏因此踩过一次坑（整条侧栏无法右键呼出菜单），
所以 `.drag-region` 才被改成手动拖拽。结论是**分开处理**：

- 顶栏（44px，不需要右键）→ 新增 `.titlebar-drag`，原生拖拽
- 侧栏与 MiniBar → 继续 `.drag-region` 手动拖拽

副作用要认：顶栏上的 `title` 气泡不再弹出，文字不可选。标题栏上可以接受。

### 2. Chromium 的 click 没有移动阈值

桌面端只要 `pointerdown` 和 `pointerup` 落在同一元素上就算一次 click，**拖完松手也算**。
所以「拖一下、马上再拖一下」会凑成一次 `dblclick`。
自己写标题栏双击最大化时必须加位移守卫（记录起点，超过 ~4px 就把这次 dblclick 挡掉）。

本次最终改成原生拖拽，守卫代码已移除，但这条规律值得记住。

### 3. Tailwind 类名写错是静默失效

`custom-scrollbar` 在 9 个地方使用，**全项目从未定义过**——不在 `index.css`，也不在
`tailwind.config.js`。Tailwind 不会报错，它只是个空类。
唯一生效的是全局 `::-webkit-scrollbar-thumb: rgba(255,255,255,.15)`，
白色 15% alpha 在浅色主题上等于透明，于是浅色下根本看不见滚动条。

### 4. `disabled` 按钮上的 `title` 永远不会弹出

Chromium 对 `disabled` 元素不派发鼠标事件，tooltip 不会出现。
要禁用视觉又要提示，用 `aria-disabled="true"` + `onClick` 阻止默认 + 常量禁用类
（此时 `disabled:` 变体也失效了，别再用），或者把 `title` 放到外层包裹元素上。

### 5. Tailwind 的 `ring-offset` 默认是白色

`--tw-ring-offset-color` 默认 `#fff`，深色主题下 `ring-offset-2` 会画出一圈白色光晕。
而且同一个组件在不同底色上（侧栏 `--accent-wash` / 设置页 `--bg-surface`）写死哪个都错。

**跨主题的焦点环用 `outline` + `outline-offset`**，offset 区域是透明的，露出的是真实背景。

### 6. 纯函数一旦变成时间敏感，既有测试就成了 flaky

`parseResetTimeInfo` 加上今天/明天判断后，`scripts/test-minibar-layout.mjs` 那条
硬编码断言「重置于 今天 20:15」变成了**看几点跑决定成败**：
19:1x 跑通过，19:4x 跑失败（`now + 4h22min` 跨过了午夜）。

修法是给函数加 `now: Date = new Date()` 参数，测试里注入固定时刻。
**任何引入「当前时间」的改动，都要顺手检查既有断言是不是变成了时间炸弹。**

### 7. React hooks 不能条件调用，只能拆组件

`AgentSection` 无条件调 `useQuotaState()`，即使上层已经把 `state` 传进来了，
于是概览页同时跑着两份 15s 轮询 + 两份 IPC 订阅——
而 `App.tsx` 的注释还写着「不再起第二个订阅」。

不能写 `if (props.state) {} else { useQuotaState() }`。
正确做法是拆成「纯渲染组件」+「自带 hook 的子组件」，由外层按 prop 是否存在来选渲染哪个。

### 8. frameless 窗口不要在 CSS 里加圆角

Windows 11 的 DWM 会自动给 frameless 窗口加圆角。在 `html/body/#root` 上再加一层
`border-radius` 只会在四角露出黑边。

### 9. `backgroundColor` 必须和 CSS 画布色对齐

`BrowserWindow` 的 `backgroundColor` 是 React 挂载前那一帧的颜色。
它和 `--bg-canvas` 不一致时，每次冷启动都会闪一下旧色。改主题色时容易漏掉这一处。

### 10. 语义色 token 的含义必须稳定

「Live」（权威实时数据，好状态）曾被涂成 `--quota-warning-wash` 琥珀色，
「估算」（本地兜底，可信度低）反而是绿色 accent。
琥珀在这套色板里就是警告色，**颜色含义一旦在某处反转，整套 token 的可信度就没了**。

### 11. 注释会说谎，对比度要实测

`index.css` 里那句「WCAG 2.1 AA+ 实测达标」是假的：
`--text-muted: #93a099` 在白底上只有 **2.72:1**，而它正好用在
21 处 `text-[10px]` 和 3 处 `text-[9px]` 上——**最小的字配了最低的对比度**。

### 12. `PULSE_SCREEN` 调试截图会被单实例锁挡住

`src/main/index.ts` 有个 `PULSE_SCREEN=1` 的调试钩子，在 React 首帧后自动截图到
`debug-window-main.png`，不用手动操作窗口就能看到真实渲染结果，非常好用。

**但是**：本应用「关闭 = 隐藏到托盘」，进程不退出，会一直占着 single-instance lock。
上一次跑完没清干净的话，下一次启动会**静默退出**（exit 0、无日志、不写截图）。
抓图前先确认没有残留进程：

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

---

## 三、遗留问题

1. ~~**MiniBar 圆环数值与详情卡对不上**~~ —— **已排查，判定为旧构建的常驻进程**。

   现象：圆环 Codex 64%，同一时刻详情卡 5 小时剩余 100%。

   排查过程（结论按证据强度排序）：
   - 拉 `http://127.0.0.1:8765/status` 取实时真值，**详情卡与服务端逐字段吻合**
     （`pct5h=0` → 剩余 100%、`pct7d=75` → 剩余 25%、`authoritative=true`），
     说明数据层当时是健康的，错的是圆环。
   - 圆环（`MiniBar.tsx` 竖向 / 横向两处）与详情卡读的是**同一个 `quotas` 变量、
     同一个 `pct5h` 字段、同一次 React 渲染**，`renderCardBody` 也不是 memo 的。
     一次渲染物理上不可能从一个字段读出两个值。
   - 数据层逐条排除：`refreshLive` 失败只退避、从不清空 `this.live[key]`，
     不存在 live↔兜底来回跳；`expire()` 把 `pct` 归零时会连带把 `resetText` 变成
     `'ready'`，而截图里卡片写的是「5 小时后重置」，说明 `expire()` 根本没触发；
     `getQuotas()` 的缓存按引用返回同一个对象，给不出两个版本。
   - 当前构建实测：圆环 53 / 100 / 73，与服务端三个 `pct5h` 完全一致。

   结论：截图时圆环跑的是**另一份代码**。本应用「关闭 = 隐藏到托盘、进程不退出」，
   `dist` 被重建多次而托盘里那个实例仍是早上的 bundle（同一天内因此撞过一次静默启动失败，
   见踩坑第 12 条）。**改完代码要验证时，先确认没有残留进程。**

   遗留的预防措施：`MiniBar.tsx` 里「5 小时剩余」的推导重复了 3 处
   （竖向圆环、横向圆环、详情卡）。抽成一个函数后这类漂移就不可能发生。

2. **浅色三级明度拉不开**，见上文第一节的未闭环说明。

3. **「手环」卡未连接时中间空约 130px**，需要补居中状态区或压矮卡片。

4. **`重置于 2 天后 15:30`** 措辞别扭（相对 + 绝对混用），待定。

5. **6 个死文件无人 import**，仍带着旧 sky/zinc/violet 配色：
   `pulse/Sidebar.tsx`、`pulse/TitleBar.tsx`、`SettingsScreen.tsx`、`DeviceScreen.tsx`、
   `QuotaCards.tsx`、`BandConnectionCard.tsx`。保留待人工确认后再删。

6. **字号没有阶**：13 个不同值，含 11.5 / 10.5 / 9.5 / 12.5 半像素。

7. **圆角双轨**：`var(--radius-*)` 与硬编码 `rounded-[Npx]` 并存。
