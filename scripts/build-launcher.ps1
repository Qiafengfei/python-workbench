[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$compiler = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw 'The .NET Framework C# compiler was not found.' }

Add-Type -AssemblyName System.Drawing
$assets = Join-Path $project 'assets'
[IO.Directory]::CreateDirectory($assets) | Out-Null
$iconPath = Join-Path $assets 'python-workbench.ico'
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = foreach ($size in $sizes) {
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $shape = [Drawing.Drawing2D.GraphicsPath]::new()
    $background = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#202630'))
    $pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#8bb4eb'), 4)
    $stream = [IO.MemoryStream]::new()
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.ScaleTransform($size / 64.0, $size / 64.0)
        $shape.AddArc(0, 0, 26, 26, 180, 90)
        $shape.AddArc(38, 0, 26, 26, 270, 90)
        $shape.AddArc(38, 38, 26, 26, 0, 90)
        $shape.AddArc(0, 38, 26, 26, 90, 90)
        $shape.CloseFigure()
        $graphics.FillPath($background, $shape)
        $pen.StartCap = $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawLines($pen, [Drawing.PointF[]]@([Drawing.PointF]::new(23,19), [Drawing.PointF]::new(10,32), [Drawing.PointF]::new(23,45)))
        $graphics.DrawLines($pen, [Drawing.PointF[]]@([Drawing.PointF]::new(41,19), [Drawing.PointF]::new(54,32), [Drawing.PointF]::new(41,45)))
        $graphics.DrawLine($pen, 37, 12, 27, 52)
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        ,$stream.ToArray()
    } finally {
        $stream.Dispose(); $pen.Dispose(); $background.Dispose()
        $shape.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
}
$file = [IO.File]::Create($iconPath)
$writer = [IO.BinaryWriter]::new($file)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
} finally { $writer.Dispose(); $file.Dispose() }

& $compiler /nologo /target:winexe /optimize+ /codepage:65001 /platform:anycpu "/win32icon:$iconPath" /reference:System.Windows.Forms.dll "/out:$project\PythonWorkbench.exe" "$PSScriptRoot\Launcher.cs"
if ($LASTEXITCODE -ne 0) { throw 'C# launcher compilation failed.' }
# Managed workspaces may label newly built files Low, which also lowers their
# Python/browser children. Normalize only this executable; preserve its DACL.
$artifact = Join-Path $project 'PythonWorkbench.exe'
$security = [IO.File]::GetAccessControl($artifact)
$accessSection = [Security.AccessControl.AccessControlSections]::Access
$originalAccess = $security.GetSecurityDescriptorSddlForm($accessSection)
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$temporaryRight = [Security.AccessControl.FileSystemAccessRule]::new($ownerSid, [Security.AccessControl.FileSystemRights]::TakeOwnership, [Security.AccessControl.AccessControlType]::Allow)
try {
    $security.AddAccessRule($temporaryRight) | Out-Null
    [IO.File]::SetAccessControl($artifact, $security)
    & "$env:WINDIR\System32\icacls.exe" $artifact /setintegritylevel M | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not set normal user integrity on the generated launcher.' }
} finally {
    $restore = [Security.AccessControl.FileSecurity]::new()
    $restore.SetSecurityDescriptorSddlForm($originalAccess, $accessSection)
    [IO.File]::SetAccessControl($artifact, $restore)
}
Get-Item -LiteralPath (Join-Path $project 'PythonWorkbench.exe') | Select-Object Name, Length
