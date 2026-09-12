<#
.SYNOPSIS
  起 / 停 / 列出本机用于「一个本体一个库」的 Neo4j Community 实例。

.DESCRIPTION
  Neo4j 社区版一个实例只能有一个库，而平台的发布是整库替换
  （`MATCH (n) DETACH DELETE n`），所以两个本体不能挤在同一个库上。
  这个脚本把「再加一个本体」变成一条命令：每个实例一个容器、一组端口、一份数据卷，
  然后在平台的「本体存储」页把这个实例登记成一个本体存储。

.EXAMPLE
  pwsh scripts/neo4j-instance.ps1 -List
  pwsh scripts/neo4j-instance.ps1 -Name ontology-neo4j-c -BoltPort 7689 -HttpPort 7476
  pwsh scripts/neo4j-instance.ps1 -Stop ontology-neo4j-c
#>
param(
  [string]$Name,
  [int]$BoltPort,
  [int]$HttpPort,
  [string]$Password = "neo4j@2025",
  [string]$Image = "docker.1ms.run/neo4j:5.26.27",
  [string]$Stop,
  [switch]$List
)

$ErrorActionPreference = "Stop"

function Show-Instances {
  $rows = docker ps -a --filter "name=neo4j" --format "{{.Names}}|{{.Status}}|{{.Ports}}"
  if (-not $rows) { Write-Host "还没有 Neo4j 容器。"; return }
  Write-Host "容器名`t状态`t端口（HTTP / Bolt）"
  foreach ($row in $rows) {
    $parts = $row -split "\|"
    $ports = ([regex]::Matches($parts[2], "0\.0\.0\.0:(\d+)") | ForEach-Object { $_.Groups[1].Value }) -join " / "
    Write-Host ("{0}`t{1}`t{2}" -f $parts[0], $parts[1], $ports)
  }
}

if ($List) { Show-Instances; return }

if ($Stop) {
  docker stop $Stop | Out-Null
  Write-Host "已停止 $Stop（数据卷保留，docker start $Stop 可再起）。"
  return
}

if (-not $Name -or -not $BoltPort -or -not $HttpPort) {
  throw "用法：-Name <容器名> -BoltPort <端口> -HttpPort <端口>；或者 -List / -Stop <容器名>。"
}

$existing = docker ps -a --filter "name=^/$Name$" --format "{{.Names}}"
if ($existing) { throw "容器 $Name 已存在。换一个名字，或先 -Stop $Name 再手动 docker rm。" }

docker run -d --name $Name `
  -p "${HttpPort}:7474" -p "${BoltPort}:7687" `
  -v "${Name}-data:/data" `
  -e "NEO4J_AUTH=neo4j/$Password" `
  $Image | Out-Null

Write-Host "已启动 $Name（Bolt $BoltPort / HTTP $HttpPort），首次启动约 20-40 秒就绪。"
Write-Host ""
Write-Host "到平台「本体存储」新建，填："
Write-Host "  类型   Neo4j"
Write-Host "  URI    bolt://localhost:$BoltPort"
Write-Host "  库名   neo4j"
Write-Host "  账号   neo4j"
Write-Host "  密码   $Password"
