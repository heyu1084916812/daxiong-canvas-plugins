$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
$Source = Join-Path $Root "source\PluginManagerApp.cs"
$Icon = Join-Path $Root "assets\plugin-manager-icon.ico"
$Output = Join-Path $Root "大雄插件管理.exe"

if (-not (Test-Path -LiteralPath $Csc)) { throw "找不到 Windows C# 编译器：$Csc" }
if (-not (Test-Path -LiteralPath $Source)) { throw "找不到源码：$Source" }
if (-not (Test-Path -LiteralPath $Icon)) { throw "找不到图标：$Icon" }

& $Csc /nologo /target:winexe /platform:anycpu /optimize+ /win32icon:$Icon `
    /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll `
    /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll `
    /out:$Output $Source

if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) {
    throw "插件管理器编译失败"
}

Get-Item -LiteralPath $Output | Select-Object FullName, Length, LastWriteTime
