# 生成额度圆环的帧序列 PNG（Vela 渲染层画不出 SVG/原生环/帧序列组件，
# 用 <image> 换 src 的单帧 PNG，见 V3_PLAN_FOR_ZCODE.md 阶段 0/4 探针结论）
#
#   pwsh band-app/tools/make-ring-frames.ps1
#
# ⚠️ 两个实测约束（2026-09-06 深夜踩坑，别"优化"掉）：
# 1. 运行时图片解码器有 ~2KB 文件体积上限：3.5KB 的 72px RGBA PNG 渲染成「!」占位图，
#    ~1.3KB 以下正常。所以关掉抗锯齿直绘 72px（每张 ~725B）；
#    「144 绘制 → Bicubic 缩 72」的产物 3.5KB 会炸。
# 2. 弧矩形原点 = 线宽一半（3~7），不是 R - 线宽/2 —— 写错会把圆心推出画布，只剩四分之一弧
#    （这个 bug 曾被连环误判成「解码器坏了 / 缓存了旧图」）。
#
# 底环 #2c2c2e 烘进每一帧，0 帧 = 只有底环（0% 画不出弧，也是数据缺失时的「空环」）。
# 输出到 band-app/src/common/ring2/：normal-0..20.png / warn-* / danger-*
# （normal 绿 #30d158 / warn 琥珀 #ff9f0a / danger 红 #ff453a）

Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutDir = Join-Path $Root "src\common\ring2"
New-Item -ItemType Directory -Force $OutDir | Out-Null
Get-ChildItem $OutDir -Filter "*.png" | Remove-Item -Force

$F = 72
$STROKE = 7
$R = ($F - $STROKE) / 2
$BASE = [System.Drawing.ColorTranslator]::FromHtml("#2c2c2e")
$FRAMES = 21         # 0,5,10,...100
$levels = @(
  @{ name = 'normal'; hex = '#30d158' },
  @{ name = 'warn';   hex = '#ff9f0a' },
  @{ name = 'danger'; hex = '#ff453a' }
)

$total = 0
foreach ($lv in $levels) {
  $color = [System.Drawing.ColorTranslator]::FromHtml($lv.hex)

  for ($i = 0; $i -lt $FRAMES; $i++) {
    $bmp = New-Object System.Drawing.Bitmap $F, $F
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
    $g.Clear([System.Drawing.Color]::Transparent)

    $box = [int]($STROKE / 2)
    $basePen = New-Object System.Drawing.Pen $BASE, $STROKE
    $g.DrawArc($basePen, $box, $box, 2 * $R, 2 * $R, 0, 360)
    $basePen.Dispose()

    $pct = $i * 5
    if ($pct -gt 0) {
      $pen = New-Object System.Drawing.Pen $color, $STROKE
      $sweep = [Math]::Min(360, $pct * 3.6)
      $g.DrawArc($pen, $box, $box, 2 * $R, 2 * $R, -90, $sweep)
      $pen.Dispose()
    }

    $g.Dispose()
    $out = Join-Path $OutDir ("{0}-{1}.png" -f $lv.name, $i)
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $total++
  }
}
Write-Host "$total frames -> $OutDir"
