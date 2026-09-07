# 抓模拟器画面。
#
#   pwsh band-app/tools/grab-emulator.ps1 [-Out shot.png] [-Crop]
#
# 为什么不用别的办法：
#   - `adb shell screencap` —— NuttX 上没这个命令
#   - emulator gRPC (127.0.0.1:8554) 的 getScreenshot —— 对这个 vela 镜像返回空帧，
#     拿到的是纯黑图（实测 1373 字节的全黑 PNG，唤醒屏幕也没用）
#   - 找模拟器窗口句柄 —— 它没有独立顶层窗口，是嵌在 AIoT IDE 里渲染的
#
# 能用的办法：对 AIoT IDE 的主窗口做 PrintWindow，且必须带
# PW_RENDERFULLCONTENT (flag = 2)，否则拿到的也是黑的。

param(
  [string]$Out = "emulator.png",
  [switch]$Crop,   # 只保留右侧模拟器那一栏（AIoT IDE 窗口专用）
  [string]$Title = "AIoT IDE"   # 目标窗口标题片段；抓独立 qemu 窗口用 -Title "Android Emulator"
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GrabWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$proc = Get-Process | Where-Object { $_.MainWindowTitle -match $Title } | Select-Object -First 1
if (-not $proc) { Write-Error "找不到窗口标题匹配 '$Title' 的进程"; exit 1 }

$h = $proc.MainWindowHandle
$r = New-Object GrabWin+RECT
[void][GrabWin]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$ht = $r.B - $r.T

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][GrabWin]::PrintWindow($h, $hdc, 2)   # 2 = PW_RENDERFULLCONTENT，缺了就是黑图
$g.ReleaseHdc($hdc)
$g.Dispose()

if ($Crop) {
  # 模拟器面板在窗口右侧。按比例取，窗口尺寸变了也大致对得上；
  # 位置不准就去掉 -Crop 拿整窗图自己看。
  $cx = [int]($w * 0.76)
  $cw = [int]($w * 0.17)
  $cy = [int]($ht * 0.30)
  $ch = [int]($ht * 0.68)
  $rect = New-Object System.Drawing.Rectangle $cx, $cy, $cw, $ch
  $c = $bmp.Clone($rect, $bmp.PixelFormat)
  $big = New-Object System.Drawing.Bitmap ($cw * 2), ($ch * 2)
  $bg = [System.Drawing.Graphics]::FromImage($big)
  $bg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $bg.DrawImage($c, 0, 0, $cw * 2, $ch * 2)
  $bg.Dispose()
  $big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $big.Dispose(); $c.Dispose()
} else {
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
}
$bmp.Dispose()

$size = (Get-Item $Out).Length
"saved $Out  ($([Math]::Round($size / 1KB, 1)) KB)"
if ($size -lt 5KB) { Write-Warning "文件很小，可能又是黑图 —— 确认 IDE 窗口没被最小化" }
