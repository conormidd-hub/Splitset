<#
.SYNOPSIS
  Inject activities.csv, wellness.csv and data\runs\*.json into template.html -> dashboard.html.

.DESCRIPTION
  A PowerShell twin of build.py, for Windows machines with no Python installed.
  All rendering logic lives in template.html as JavaScript; this script only
  carries data across, so it stays too boring to break.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -Race 2027-04-11 -RaceName "Canberra Marathon" -Goal "sub 2:50"
#>
[CmdletBinding()]
param(
    [string]$Race = "2026-10-11",
    [string]$RaceName = "Goal race",
    [string]$Goal = "sub 2:50",
    [string]$Template = "template.html",
    [string]$Out = "dashboard.html"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$ZoneBounds = @(139, 152, 166, 181)   # keep in step with sync.py / sync.ps1

if (-not (Test-Path $Template)) { throw "$Template not found." }
$page = Get-Content $Template -Raw -Encoding UTF8

function ConvertTo-SafeJson($obj, $depth) {
    if ($null -eq $obj) { return "null" }
    $json = ConvertTo-Json -InputObject $obj -Compress -Depth $depth
    # never let data close the script tag it lives inside
    return $json.Replace("</", "<\/")
}

function Inject($html, $id, $payload) {
    $pattern = '(<script[^>]*id="' + [regex]::Escape($id) + '"[^>]*>).*?(</script>)'
    $rx = New-Object System.Text.RegularExpressions.Regex($pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $rx.IsMatch($html)) { throw "$Template has no <script id=`"$id`"> block" }
    return $rx.Replace($html, { param($m) $m.Groups[1].Value + $payload + $m.Groups[2].Value }, 1)
}

# --- activities
if (-not (Test-Path "activities.csv")) { throw "activities.csv not found. Run .\sync.ps1 first." }
$acts = @(Import-Csv "activities.csv" -Encoding UTF8 | Where-Object {
    $_.distance_km -and [double]$_.distance_km -ge 0.5
} | Sort-Object { $_.date })
# drop empty fields so the payload stays small and the page's num() sees real gaps
$actsClean = @()
foreach ($a in $acts) {
    $o = [ordered]@{}
    foreach ($p in $a.PSObject.Properties) {
        if ("$($p.Value)" -ne "") { $o[$p.Name] = $p.Value }
    }
    $actsClean += , [pscustomobject]$o
}

# --- wellness: the intervals.icu feed laid over the Garmin export backfill
# (import_garmin.py). On a shared date intervals.icu wins field by field.
$byDate = @{}
foreach ($src in @("wellness.csv", "garmin_wellness.csv")) {
    if (-not (Test-Path $src)) { continue }
    foreach ($w in (Import-Csv $src -Encoding UTF8)) {
        if (-not $w.date) { continue }
        if (-not $byDate.ContainsKey($w.date)) { $byDate[$w.date] = [ordered]@{} }
        $o = $byDate[$w.date]
        foreach ($p in $w.PSObject.Properties) {
            if ("$($p.Value)" -ne "" -and -not $o.Contains($p.Name)) { $o[$p.Name] = $p.Value }
        }
    }
}
$wellClean = @($byDate.Keys | Sort-Object | ForEach-Object { [pscustomobject]$byDate[$_] })

# --- per-run detail
$runs = [ordered]@{}
$runsDir = "data\runs"
if (Test-Path $runsDir) {
    foreach ($f in (Get-ChildItem $runsDir -Filter *.json)) {
        try { $rec = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
        if ($rec.PSObject.Properties["no_streams"] -and $rec.no_streams) { continue }
        $rec.PSObject.Properties.Remove("id") | Out-Null
        $runs[[string]$f.BaseName] = $rec
    }
}

$meta = [ordered]@{
    generated = (Get-Date -Format "yyyy-MM-dd HH:mm")
    race      = [ordered]@{ name = $RaceName; date = $Race; goal = $Goal }
    zones     = $ZoneBounds
}

$page = Inject $page "DATA_ACTIVITIES" (ConvertTo-SafeJson @($actsClean) 4)
$page = Inject $page "DATA_WELLNESS"   (ConvertTo-SafeJson @($wellClean) 4)
$page = Inject $page "DATA_RUNS"       $(if ($runs.Count) { ConvertTo-SafeJson $runs 10 } else { "{}" })
$page = Inject $page "DATA_META"       (ConvertTo-SafeJson $meta 5)
# the plan is already JSON on disk; inject it as-is rather than round-tripping
# through ConvertFrom/ConvertTo-Json, which mangles nested arrays in PS 5.1
$planJson = "null"
if (Test-Path "plan_seed.json") {
    $planJson = ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "plan_seed.json"), [System.Text.Encoding]::UTF8)).Trim().Replace("</", "<\/")
}
$page = Inject $page "DATA_PLAN" $planJson
$gymJson = "null"
if (Test-Path "gym_programs.json") {
    $gymJson = ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "gym_programs.json"), [System.Text.Encoding]::UTF8)).Trim().Replace("</", "<\/")
}
$page = Inject $page "DATA_GYM" $gymJson

[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot $Out), $page, (New-Object System.Text.UTF8Encoding($false)))
$kb = [math]::Round((Get-Item $Out).Length / 1KB)
Write-Host "Wrote $Out : $($actsClean.Count) runs, $($wellClean.Count) wellness days, $($runs.Count) runs with detail ($kb KB)" -ForegroundColor Green
