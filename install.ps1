# 把周报插件注册进 tauri profile（幂等，可重复运行）
# 用法：pwsh -ExecutionPolicy Bypass -File <仓库目录>\install.ps1
$ErrorActionPreference = 'Stop'

# 插件源码 = 本脚本所在目录，所以仓库可以放在任意位置
$source = $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\tauri'
$pkgPath = Join-Path $profileDir 'package.json'
$modulesDir = Join-Path $profileDir 'node_modules'
$linkPath = Join-Path $modulesDir 'dsh-plugin-weekly'

if (-not (Test-Path (Join-Path $source 'package.json'))) { throw "这里不像插件目录（缺 package.json）：$source" }
if (-not (Test-Path $pkgPath)) { throw "找不到 profile package.json：$pkgPath" }

# 1) 链接进 profile 的 node_modules（DSH 只从这里/依赖里扫插件）
New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
if (Test-Path $linkPath) {
    if ((Get-Item $linkPath).LinkType) {
        cmd /c rmdir "$linkPath"
    } else {
        Remove-Item $linkPath -Recurse -Force
    }
}
New-Item -ItemType Junction -Path $linkPath -Target $source | Out-Null
Write-Host "linked: $linkPath -> $source"

# 2) package.json：依赖 + bundle 列表
Copy-Item $pkgPath "$pkgPath.bak-weekly" -Force
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dependencies) {
    $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{}) -Force
}
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-plugin-weekly' -NotePropertyValue "link:$source" -Force

$bundles = @()
if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
    $bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-plugin-weekly' })
}
$bundles += 'dsh-plugin-weekly'
$pkg.dsh.profile.bundles = $bundles
$json = $pkg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "registered bundle: dsh-plugin-weekly (共 $($bundles.Count) 个 bundle)"

Write-Host ''
Write-Host '完成。重启 DSH 应用后，左侧边栏点「周报」图标打开面板。'
Write-Host '首次发信前需要在终端执行一次：wecom-cli.cmd auth init'
