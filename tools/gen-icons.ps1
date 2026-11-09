# Generates Sakinah app icons (window icon 512px + tray icon 32px).
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$iconsRoot = Join-Path $PSScriptRoot '..\src\assets\icons'
New-Item -ItemType Directory -Force -Path $iconsRoot | Out-Null

function New-Icon {
  param(
    [string]$outPath,
    [int]$size,
    [bool]$transparentForTray
  )

  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  if ($transparentForTray) {
    $g.Clear([System.Drawing.Color]::Transparent)
  } else {
    $g.Clear([System.Drawing.Color]::Transparent)

    # rounded-rect background with vertical emerald gradient
    $c1 = [System.Drawing.Color]::FromArgb(255, 26, 98, 80)   # top emerald
    $c2 = [System.Drawing.Color]::FromArgb(255, 9, 44, 35)    # bottom deep green
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 90.0)

    $r = $size * 0.22
    $d = $r * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($lg, $path)
    $path.Dispose()
    $lg.Dispose()
  }

  # crescent: gold circle minus an offset circle
  $cx = $size * 0.48
  $cy = $size * 0.52
  $R = $size * 0.27
  $ox = $R * 0.44

  $p1 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p1.AddEllipse([System.Drawing.RectangleF]::new(($cx - $R), ($cy - $R), (2 * $R), (2 * $R)))
  $p2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p2.AddEllipse([System.Drawing.RectangleF]::new(($cx - $R + $ox), ($cy - $R), (2 * $R), (2 * $R)))

  $region1 = New-Object System.Drawing.Region($p1)
  $region2 = New-Object System.Drawing.Region($p2)
  $region1.Exclude($region2)

  $gold = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 223, 188, 116))
  $g.FillRegion($gold, $region1)

  $region1.Dispose(); $region2.Dispose(); $p1.Dispose(); $p2.Dispose()
  $gold.Dispose()

  # small four-point star near the crescent's opening
  $sx = $size * 0.70
  $sy = $size * 0.30
  $s = $size * 0.075
  $k = $s * 0.38
  $pts = @(
    [System.Drawing.PointF]::new($sx, ($sy - $s)),
    [System.Drawing.PointF]::new(($sx + $k), ($sy - $k)),
    [System.Drawing.PointF]::new(($sx + $s), $sy),
    [System.Drawing.PointF]::new(($sx + $k), ($sy + $k)),
    [System.Drawing.PointF]::new($sx, ($sy + $s)),
    [System.Drawing.PointF]::new(($sx - $k), ($sy + $k)),
    [System.Drawing.PointF]::new(($sx - $s), $sy),
    [System.Drawing.PointF]::new(($sx - $k), ($sy - $k))
  )
  $starBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 223, 188, 116))
  $g.FillPolygon($starBrush, $pts)
  $starBrush.Dispose()

  $g.Dispose()
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Icon -outPath (Join-Path $iconsRoot 'icon.png') -size 512 -transparentForTray $false
New-Icon -outPath (Join-Path $iconsRoot 'tray.png') -size 32 -transparentForTray $true

Write-Host "icons ok"
