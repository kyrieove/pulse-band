# Antigravity 指令 —— 修复「固定靠左/靠右」跑到副显示器

> 贴「======」之间的内容。你在 **feat/watchface-ui 分支**上工作。

======

## 缺陷（真机实测复现，根因已定位，不用重新调查）

用户在设置里选「固定靠左」或「固定靠右」，MiniBar 停靠到了**副显示器**，不是主显示器。两个选项都是。

### 用户的显示器布局

```
DISPLAY2  Bounds X=0,    Y=0,   1920×1080   Primary=True    ← Windows 主显示器
DISPLAY1  Bounds X=1920, Y=-64, 1536×864    Primary=False
```

### 根因链

1. `minibar-window.ts:409` 的 `screen.getPrimaryDisplay()` **只在 `defaultX === undefined` 时才走**，也就是只在没有持久化坐标时。
2. 有持久化坐标时走 else 分支 → `clampToVisibleArea()`（`minibar-window.ts:165-172`），它用**保存的 x/y** 去 `displays.find()` 出窗口当前所在的那块屏。
3. 再把那块屏的 `workArea` 传给 `clampBoundsToWorkArea()`，由 `minibar-geometry.ts:215-216` 算边缘：
   ```ts
   if (dockSide === 'left')  clampedX = workArea.x;
   if (dockSide === 'right') clampedX = rightEdge - width;
   ```

用户曾把 MiniBar 拖到 DISPLAY1，坐标存进了 `minibar-bounds.json`。此后「固定靠左」算出的是 **DISPLAY1 的左边缘 x=1920**，「固定靠右」算出 DISPLAY1 的右边缘。**「固定靠左/右」实际含义变成了「贴到窗口当前所在那块屏的左/右边」。**

## 要做的事

把三个偏好的语义定清楚并实现：

| 偏好 | 期望语义 |
|---|---|
| `left` | 每次启动固定在**主显示器**（`screen.getPrimaryDisplay()`）的左边缘 |
| `right` | 每次启动固定在**主显示器**的右边缘 |
| `remember` | 沿用上次所在的显示器与停靠边；上次若是 top/bottom 则归到该显示器的 right |

理由：用户显式选了「固定靠左/靠右」，就是要覆盖记忆行为；而 `remember` 要继续尊重「我把它放在副屏」这个偏好。**如果你认为这个语义划分有问题，先说出来再动手，不要默默改成别的。**

实现要点：`left` / `right` 分支下，显示器的选择**不能**再依赖保存的 x/y，必须直接取主显示器的 `workArea`。持久化坐标在这两个模式下只有 y 还有参考价值（保持垂直位置），x 必须重算。

## 边角（想清楚再写，处理不了的写进报告）

1. **主显示器变更**：用户在 Windows 里换了主屏，下次启动应落到新的主屏。
2. **显示器热插拔**：`remember` 模式下记住的那块屏被拔掉了，要回落到主显示器而不是定位到不存在的坐标。
3. **DPI 缩放不一致**：两块屏缩放比不同时，`workArea` 是 DIP 值，跨屏搬运窗口尺寸会变；只需保证不出屏，不要求像素级完美。
4. **不要把修好的位置又被旧逻辑覆盖**：改完检查 `saveBounds()` 不会把中间态写回文件。

## 范围

- **你负责**：`src/main/minibar-window.ts`、`src/main/services/minibar-geometry.ts`
- **不要碰**：`src/renderer/components/pulse/SettingsPage.tsx`（另一个 agent 的文件）、`src/renderer/index.css`、`src/renderer/components/pulse/AgentCard.tsx`、`AgentSection.tsx`、`OverviewPage.tsx`

设置页那三个选项的文案现在没说清是哪块屏。**不要自己去改 SettingsPage.tsx**，在报告里给出你建议的文案，交给另一个 agent 或主线改。

## 要求

1. 单独 commit，前缀 `fix(minibar-dock)`。
2. `npm run build` 必须退出 0。**不要用管道取退出码**，单独跑一次。
3. 工作区有一批与本任务无关的已有改动，**只 stage 你自己改的文件**。
4. 本机偏好文件在 `%APPDATA%\pulse-band-v2\minibar-bounds.json`，测试时自己删掉重建。

## 交付要求

1. 改了哪些文件哪几行。
2. 四个边角你各自怎么处理的；处理不了的明说。
3. 建议的设置页文案。
4. `npm run build` 的真实退出码。
5. 没验证的东西。**这个缺陷是真机实测出来的，只有再次真机实测才算修好**——你没有双显示器环境的话，明说「未实测」，不要写「已修复」。

======
