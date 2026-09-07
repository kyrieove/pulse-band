# 生成手环上用的三个 agent 图标：品牌色圆角方块 + 白色标志剪影
#
#   pwsh band-app/tools/make-agent-icons.ps1
#
# 标志不是画的，是从本机装的三个应用里抠出来的：
#   Claude       Microsoft Store 包 assets/Square44x44Logo.scale-200.png（本身就是橙色方块+白星芒，直接缩放）
#   Codex        Microsoft Store 包 assets/Square44x44Logo.scale-200.png（白色绳结压透明底）
#   Antigravity  Antigravity.exe 的程序图标（白底板 + 彩色 A，取彩色部分当剪影）
#
# 输出 28x28 PNG 到 band-app/src/common/，手环上按 14px（hero）和 11px（额度行）显示。

Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutDir = Join-Path $Root "src\common"
$Tmp = Join-Path $env:TEMP "agent-icon-src"
New-Item -ItemType Directory -Force $Tmp | Out-Null

$SIZE = 28      # 14px 显示的 2 倍
$RADIUS = 6     # 圆角约 21%，照 Claude 官方图标的比例
$GLYPH = 20     # 标志占的边长，约 71%

# --- 1. 找源图 -------------------------------------------------------------
function Get-StoreAsset([string]$pkgName, [string]$dest) {
  $pkg = Get-AppxPackage -Name $pkgName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $pkg) { Write-Warning "没装 $pkgName，跳过"; return $null }
  $p = Join-Path $pkg.InstallLocation "assets\Square44x44Logo.scale-200.png"
  if (-not (Test-Path $p)) { Write-Warning "$pkgName 里找不到 Square44x44Logo.scale-200.png"; return $null }
  Copy-Item $p $dest -Force
  return $dest
}

$claudeSrc = Get-StoreAsset "Claude" "$Tmp\claude.png"
$codexSrc = Get-StoreAsset "OpenAI.Codex" "$Tmp\codex.png"

$agExe = "$env:LOCALAPPDATA\Programs\antigravity\Antigravity.exe"
$agSrc = $null
if (Test-Path $agExe) {
  $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($agExe)
  $b = $ico.ToBitmap(); $b.Save("$Tmp\antigravity.png", [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
  $agSrc = "$Tmp\antigravity.png"
} else { Write-Warning "没装 Antigravity，跳过" }

# --- 2. 合成 ---------------------------------------------------------------
function Copy-AsIs([string]$src, [string]$out) {
  if (-not $src) { return }
  $img = [System.Drawing.Image]::FromFile($src)
  $bmp = New-Object System.Drawing.Bitmap $SIZE, $SIZE
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img, 0, 0, $SIZE, $SIZE)
  $g.Dispose(); $img.Dispose()
  $bmp.Save((Join-Path $OutDir $out), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  "$out  (原图缩放)"
}

function New-Squircle([string]$src, [string]$hex, [string]$mode, [string]$out) {
  if (-not $src) { return }
  $bg = [System.Drawing.ColorTranslator]::FromHtml($hex)

  $img = [System.Drawing.Image]::FromFile($src)
  $small = New-Object System.Drawing.Bitmap $GLYPH, $GLYPH
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $sg.Clear([System.Drawing.Color]::Transparent)
  $sg.DrawImage($img, 0, 0, $GLYPH, $GLYPH)
  $sg.Dispose(); $img.Dispose()

  $bmp = New-Object System.Drawing.Bitmap $SIZE, $SIZE
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $RADIUS * 2
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($SIZE - $d, 0, $d, $d, 270, 90)
  $p.AddArc($SIZE - $d, $SIZE - $d, $d, $d, 0, 90)
  $p.AddArc(0, $SIZE - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $bg), $p)
  $g.Dispose(); $p.Dispose()

  $off = [int](($SIZE - $GLYPH) / 2)
  for ($y = 0; $y -lt $GLYPH; $y++) {
    for ($x = 0; $x -lt $GLYPH; $x++) {
      $c = $small.GetPixel($x, $y)
      if ($mode -eq 'colored') {
        # 源是「白底板 + 彩色标志」，只取彩色那部分（否则整块会变成白方块）
        $isWhite = ($c.R -gt 210 -and $c.G -gt 210 -and $c.B -gt 210)
        $strength = if ($c.A -lt 100 -or $isWhite) { 0 } else { $c.A / 255.0 }
      } else {
        # 源本身就是白标志压透明底
        $strength = $c.A / 255.0
      }
      if ($strength -le 0.02) { continue }
      if ($strength -gt 1) { $strength = 1 }
      $bgp = $bmp.GetPixel($x + $off, $y + $off)
      $r = [int][Math]::Round(255 * $strength + $bgp.R * (1 - $strength))
      $gg = [int][Math]::Round(255 * $strength + $bgp.G * (1 - $strength))
      $b2 = [int][Math]::Round(255 * $strength + $bgp.B * (1 - $strength))
      $a = [Math]::Max($bgp.A, [int]($strength * 255))
      $bmp.SetPixel($x + $off, $y + $off, [System.Drawing.Color]::FromArgb($a, $r, $gg, $b2))
    }
  }
  $small.Dispose()
  $bmp.Save((Join-Path $OutDir $out), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  "$out  bg=$hex mode=$mode"
}

Copy-AsIs    $claudeSrc            "agent-claude.png"
New-Squircle $codexSrc  "#10A37F" "white"   "agent-codex.png"
New-Squircle $agSrc     "#4285F4" "colored" "agent-antigravity.png"
