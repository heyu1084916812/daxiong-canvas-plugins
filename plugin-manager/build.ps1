$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
$Source = Join-Path $Root "source\PluginManagerApp.cs"
$Icon = Join-Path $Root "assets\plugin-manager-icon.ico"
$Output = Join-Path $Root "Daxiong-Plugin-Manager.exe"
$Bootstrap = Join-Path $Root "bootstrap"
$BootstrapZip = Join-Path $env:TEMP "DaxiongPluginSystemBootstrap-$([guid]::NewGuid().ToString('N')).zip"

if (-not (Test-Path -LiteralPath $Csc)) { throw "Windows C# compiler not found: $Csc" }
if (-not (Test-Path -LiteralPath $Source)) { throw "Source not found: $Source" }
if (-not (Test-Path -LiteralPath $Icon)) { throw "Icon not found: $Icon" }
if (-not (Test-Path -LiteralPath $Bootstrap)) { throw "Embedded plugin system not found: $Bootstrap" }

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($Bootstrap, $BootstrapZip, [IO.Compression.CompressionLevel]::Optimal, $false)

    & $Csc /nologo /target:winexe /platform:anycpu /optimize+ /win32icon:$Icon `
        /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll `
        /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
        /reference:System.Management.dll `
        /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll `
        /resource:$BootstrapZip,Daxiong.PluginSystemBootstrap.zip `
        /out:$Output $Source

    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) {
        throw "Plugin manager build failed."
    }
}
finally {
    if (Test-Path -LiteralPath $BootstrapZip) { Remove-Item -LiteralPath $BootstrapZip -Force }
}

Get-Item -LiteralPath $Output | Select-Object FullName, Length, LastWriteTime
