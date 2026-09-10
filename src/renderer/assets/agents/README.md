# AI Agent 官方 Logo 资产与溯源文档

本文档记录 Pulse 桌面端使用的三个 AI 编程助手（Claude Code、Codex、Antigravity）官方 Logo 的来源依据、获取方式与主题适配策略。

## 1. 资产与溯源清单

| Agent | 文件路径 | 格式 | 官方来源 URL | 获取方式 | 获取日期 | 品牌色 / 渲染规范 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Claude Code** | `src/renderer/assets/agents/claude.svg` | SVG (Vector) | `https://claude.com/` | 从 Anthropic 官方页面 Header `ClaudeWordmark` 提取原生 Spark Mark 矢量 | 2026-09-10 | 原生品牌色 `#D97757`，viewBox `0 0 125 125` |
| **Codex** | `src/renderer/assets/agents/codex.svg` / `AgentLogo.tsx` 内联 | SVG (Vector) | `https://platform.openai.com/` | 从 OpenAI 开发者平台 Header 提取原生 Rosette 矢量 | 2026-09-10 | 经典品牌色 `#10A37F`，viewBox `0 0 41 41`，内联 `fill="currentColor"` 解决浅色主题不可见问题 |
| **Antigravity** | `src/renderer/assets/agents/antigravity.png` | PNG (200×184) | `https://antigravity.google/assets/image/antigravity-logo.png` | Google Antigravity 官方 CDN 资源下载 | 2026-09-10 | 原版多彩渐变拱门标。已实测：与远端该 URL **SHA256 逐字节一致**；与手环端同款图标视觉一致但**不是同一个文件**（手环端为 32×32 重制版，SHA256 不同） |

## 2. 浅色与深色主题适配策略

1. **Codex 浅色主题可见性问题**：
   - 原版白色单色图标在浅色底色（如 MiniBar 浅色毛玻璃）上不可见。
   - 解决方案：采用官方原生花结几何路径（viewBox `0 0 41 41`），
     通过 `fill="currentColor"` 配合 `var(--codex-brand-color, #10A37F)` 渲染。
   - **注意**：这是**品牌色着色**，不是官方原始单色。几何形态保留官方矢量，
     颜色使用项目既有品牌色 `#10A37F`（与 `QuotaCards.tsx` 原有用色一致），
     目的是在浅色背景保持可见。**不要把这条描述成"保留原始配色"。**
2. **Claude 渲染策略**：
   - 保留 Anthropic 原生赤陶橙色 `#D97757`，未改色。
3. **Antigravity 渲染策略**：
   - 使用官方 200×184 PNG，`object-contain` 等比缩放，不改色、不加背景、不做合成。
