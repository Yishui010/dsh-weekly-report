# 把周报插件注册进 tauri profile（幂等，可重复运行）
# 用法：pwsh -ExecutionPolicy Bypass -File E:\default_project\weekly\install.ps1
$ErrorActionPreference = 'Stop'

$source = 'E:\default_project\weekly'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\tauri'
$pkgPath = Join-Path $profileDir 'package.json'
$modulesDir = Join-Path $profileDir 'node_modules'
$linkPath = Join-Path $modulesDir 'dsh-plugin-weekly'

if (-not (Test-Path $source)) { throw "插件源码不在这里：$source" }
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
Write-Host '完成。重启 DSH 应用后，在 设置 -> 插件 -> 周报 打开面板。'
Write-Host '首次发信前需要在终端执行一次：wecom-cli.cmd auth init'
