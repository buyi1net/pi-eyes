# pi-vision-tools 像素管线:解码/编码/裁剪/标注。
# 设计:JS 层负责算法(diff/量化/洪水填充),本脚本只做 GDI+ 能干的
# 解码(bytes->RGBA)、编码(RGBA->PNG)、裁剪与画框,避免在 JS 里引入 sharp。
# 注意:GDI+ 不支持 webp,webp 由 JS 层先经 magick 转 png 再进这里。
# 编码:必须保持 UTF-8 带 BOM;无 BOM 时 Windows PowerShell 5.1 按 GBK 解码中文注释,会吞换行导致语法解析失败。

param(
  [Parameter(Mandatory=$true, Position=0)][string]$Command,
  [string]$In, [string]$Out, [string]$Meta,
  [string]$Bin, [int]$W, [int]$H,
  [int]$X1, [int]$Y1, [int]$X2, [int]$Y2,
  [string]$Boxes   # JSON: [{"x1":..,"y1":..,"x2":..,"y2":..,"label":"3"}] label 存在时画编号圆
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Assert-Args($cond, [string]$msg) { if (-not $cond) { throw $msg } }

try {
  switch ($Command) {
    # 只读取尺寸,不导出整张 RGBA;供裁剪/缩放前规划使用
    'probe' {
      Assert-Args ($In -and $Meta) 'probe needs -In -Meta'
      $bmp = [System.Drawing.Bitmap]::FromFile($In)
      try {
        @{ width = $bmp.Width; height = $bmp.Height } | ConvertTo-Json -Compress | Set-Content -Path $Meta -Encoding ascii
      } finally { $bmp.Dispose() }
    }
    # 解码:任意 GDI+ 支持格式 -> RGBA raw bin + meta json(width/height)
    'decode' {
      Assert-Args ($In -and $Bin -and $Meta) 'decode needs -In -Bin -Meta'
      $bmp = [System.Drawing.Bitmap]::FromFile($In)
      try {
        # 可选 fit 缩放(等比 inside 或强制 fill),供 colors 降采样 / diff 对齐 / trace 限像素
        if ($W -gt 0 -and $H -gt 0 -and ($bmp.Width -ne $W -or $bmp.Height -ne $H)) {
          $fitted = New-Object System.Drawing.Bitmap($W, $H)
          $g = [System.Drawing.Graphics]::FromImage($fitted)
          $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $g.DrawImage($bmp, 0, 0, $W, $H)
          $g.Dispose()
          $bmp.Dispose()
          $bmp = $fitted
        }
        $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
        $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $bytes = New-Object byte[] ($data.Stride * $bmp.Height)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
        $bmp.UnlockBits($data)
        [System.IO.File]::WriteAllBytes($Bin, $bytes)
        @{ width = $bmp.Width; height = $bmp.Height } | ConvertTo-Json -Compress | Set-Content -Path $Meta -Encoding ascii
      } finally { $bmp.Dispose() }
    }
    # 编码:RGBA raw bin -> PNG
    'encode' {
      Assert-Args ($Bin -and $Out -and $W -gt 0 -and $H -gt 0) 'encode needs -Bin -Out -W -H'
      $raw = [System.IO.File]::ReadAllBytes($Bin)
      $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
      $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      [System.Runtime.InteropServices.Marshal]::Copy($raw, 0, $data.Scan0, $raw.Length)
      $bmp.UnlockBits($data)
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
    }
    # 裁剪存 PNG
    'crop' {
      Assert-Args ($In -and $Out) 'crop needs -In -Out -X1 -Y1 -X2 -Y2'
      $src = [System.Drawing.Bitmap]::FromFile($In)
      try {
        $cw = $X2 - $X1; $ch = $Y2 - $Y1
        $dst = New-Object System.Drawing.Bitmap($cw, $ch)
        $g = [System.Drawing.Graphics]::FromImage($dst)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), (New-Object System.Drawing.Rectangle($X1, $Y1, $cw, $ch)), [System.Drawing.GraphicsUnit]::Pixel)
        $g.Dispose()
        $dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
        $dst.Dispose()
      } finally { $src.Dispose() }
    }
    # 裁剪存 JPEG(白底合成,供视觉 OCR 分片:部分后端对 RGBA PNG 退化)
    'crop-jpeg' {
      Assert-Args ($In -and $Out) 'crop-jpeg needs -In -Out -X1 -Y1 -X2 -Y2'
      $src = [System.Drawing.Bitmap]::FromFile($In)
      try {
        $cw = $X2 - $X1; $ch = $Y2 - $Y1
        $dst = New-Object System.Drawing.Bitmap($cw, $ch)
        $g = [System.Drawing.Graphics]::FromImage($dst)
        $g.Clear([System.Drawing.Color]::White)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), (New-Object System.Drawing.Rectangle($X1, $Y1, $cw, $ch)), [System.Drawing.GraphicsUnit]::Pixel)
        $g.Dispose()
        $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]92)
        $dst.Save($Out, $enc, $params)
        $dst.Dispose()
      } finally { $src.Dispose() }
    }
    # 画标注框(可带编号圆)存 PNG
    'annotate' {
      Assert-Args ($In -and $Out -and $Boxes) 'annotate needs -In -Out -Boxes'
      $src = [System.Drawing.Bitmap]::FromFile($In)
      try {
        $w = $src.Width; $h = $src.Height
        $dst = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($dst)
        $g.DrawImage($src, 0, 0, $w, $h)
        $stroke = [Math]::Max(2, [int][Math]::Round([Math]::Max($w, $h) / 400))
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 45, 85), $stroke)
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 45, 85))
        $labelR = [Math]::Max(10, $stroke * 4)
        $font = New-Object System.Drawing.Font('Arial', [float][Math]::Round($labelR * 1.1), [System.Drawing.FontStyle]::Bold)
        $fmt = New-Object System.Drawing.StringFormat
        $fmt.Alignment = [System.Drawing.StringAlignment]::Center
        $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
        $items = $Boxes
        # JSON 含双引号，由 JS 层写成文件传路径，避免 -File 参数引号歧义
        if (Test-Path $Boxes) { $items = Get-Content -Raw $Boxes }
        $items = $items | ConvertFrom-Json
        $i = 0
        foreach ($b in @($items)) {
          $i++
          $g.DrawRectangle($pen, [float]$b.x1, [float]$b.y1, [float]($b.x2 - $b.x1), [float]($b.y2 - $b.y1))
          if ($b.PSObject.Properties['label']) {
            $cx = [Math]::Max($labelR, [Math]::Min([int]$b.x1, $w - $labelR))
            $cy = [Math]::Max($labelR, [Math]::Min([int]$b.y1, $h - $labelR))
            $g.FillEllipse($brush, [float]($cx - $labelR), [float]($cy - $labelR), [float]($labelR * 2), [float]($labelR * 2))
            $g.DrawString([string]$b.label, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(($cx - $labelR), ($cy - $labelR), ($labelR * 2), ($labelR * 2))), $fmt)
          }
        }
        $g.Dispose()
        $dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
        $dst.Dispose()
      } finally { $src.Dispose() }
    }
    default { throw "unknown command: $Command" }
  }
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
