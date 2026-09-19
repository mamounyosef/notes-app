# Draws the app icon and writes build\icon.ico (multi size, PNG compressed).
# Run:  powershell -ExecutionPolicy Bypass -File scripts\make-icon.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$icoPath = Join-Path $outDir 'icon.ico'

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @()

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.TextRenderingHint = 'AntiAliasGridFit'

  # Rounded page shape with a soft blue to violet sweep.
  $rect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 88, 120, 255),
    [System.Drawing.Color]::FromArgb(255, 150, 96, 230),
    45.0)

  $r = [int]([Math]::Max(2, $s * 0.22))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r, $r, 180, 90)
  $path.AddArc($s - $r, 0, $r, $r, 270, 90)
  $path.AddArc($s - $r, $s - $r, $r, $r, 0, 90)
  $path.AddArc(0, $s - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath($brush, $path)

  # Three note lines.
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 255, 255), [float]([Math]::Max(1.0, $s * 0.075)))
  $pen.StartCap = 'Round'
  $pen.EndCap = 'Round'
  $x1 = $s * 0.26
  foreach ($i in 0..2) {
    $y = $s * (0.34 + $i * 0.16)
    $x2 = if ($i -eq 2) { $s * 0.58 } else { $s * 0.74 }
    $g.DrawLine($pen, [float]$x1, [float]$y, [float]$x2, [float]$y)
  }

  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , $ms.ToArray()
  $ms.Dispose()
  $bmp.Dispose()
}

# ICO container: 6 byte header, then one 16 byte entry per image, then the PNGs.
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)

$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write([Byte]0)
  $bw.Write([Byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$pngs[$i].Length)
  $bw.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush()
$bw.Close()
$fs.Close()

Write-Host "Wrote $icoPath"
