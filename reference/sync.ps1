<#
.SYNOPSIS
  Pull running data from intervals.icu into activities.csv, wellness.csv and data\runs\*.json.

.DESCRIPTION
  A PowerShell twin of sync.py, for Windows machines with no Python installed.
  Same inputs, same outputs, same on-disk cache - either script can run the sync
  and build.ps1 / build.py will read the result.

  Credentials are read from, in order:
    1. -AthleteId / -ApiKey parameters
    2. a .env file beside this script (INTERVALS_ATHLETE_ID=... / INTERVALS_API_KEY=...)
    3. the INTERVALS_ATHLETE_ID / INTERVALS_API_KEY environment variables

.EXAMPLE
  .\sync.ps1
  .\sync.ps1 -Oldest 2025-01-01
  .\sync.ps1 -NoStreams          # activities + wellness only, skip the GPS backfill
#>
[CmdletBinding()]
param(
    [string]$Oldest = "2024-01-01",
    [string]$AthleteId,
    [string]$ApiKey,
    [switch]$NoStreams,
    [int]$MaxStreams = 400
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location $PSScriptRoot

$ApiRoot = "https://intervals.icu/api/v1"
$RunsDir = Join-Path $PSScriptRoot "data\runs"

# Best-effort distances: JSON key -> metres. Keys are load-bearing; template.html
# looks efforts up by these exact strings.
$EffortTargets = [ordered]@{
    "1000" = 1000.0; "1609" = 1609.34; "3000" = 3000.0; "5000" = 5000.0
    "10000" = 10000.0; "15000" = 15000.0; "21097" = 21097.5; "42195" = 42195.0
}
# HR zone upper bounds - keep in step with sync.py and build.ps1
$ZoneBounds = @(139, 152, 166, 181)

$OutCols = @("date", "id", "name", "type", "distance_km", "moving_time_s", "elapsed_time_s",
    "avg_hr", "max_hr", "cadence_spm", "stride_m", "gct_ms", "vert_osc_cm",
    "avg_power_w", "vo2max", "elev_gain_m", "load", "intensity", "avg_temp_c", "calories")

# our column -> candidate names in the intervals.icu payload, best first
$Candidates = [ordered]@{
    id             = @("id")
    date           = @("start_date_local", "start_date", "startDateLocal")
    name           = @("name")
    type           = @("type")
    distance_m     = @("distance", "icu_distance")
    moving_time_s  = @("moving_time", "icu_moving_time", "elapsed_time")
    elapsed_time_s = @("elapsed_time", "icu_elapsed_time")
    avg_hr         = @("average_heartrate", "icu_average_heartrate", "avg_hr")
    max_hr         = @("max_heartrate", "icu_max_heartrate", "max_hr")
    cadence_spm    = @("average_cadence", "icu_average_cadence")
    stride_m       = @("average_stride", "icu_average_stride")
    gct_ms         = @("ground_time", "icu_ground_time", "average_ground_time")
    vert_osc_cm    = @("vertical_oscillation", "icu_vertical_oscillation")
    avg_power_w    = @("icu_average_watts", "average_watts")
    vo2max         = @("icu_vo2max", "vo2max")
    elev_gain_m    = @("total_elevation_gain", "icu_elevation_gain")
    load           = @("icu_training_load", "training_load")
    intensity      = @("icu_intensity", "intensity")
    avg_temp_c     = @("average_temp", "avg_temp")
    calories       = @("calories", "icu_calories")
}

$WellnessFields = [ordered]@{
    resting_hr  = @("restingHR", "resting_hr")
    hrv         = @("hrv")
    weight_kg   = @("weight")
    sleep_s     = @("sleepSecs", "sleep_secs")
    sleep_score = @("sleepScore", "sleep_score")
    vo2max      = @("vo2max")
    ctl         = @("ctl")
    atl         = @("atl")
    steps       = @("steps")
}

# ------------------------------------------------------------------ credentials

function Read-DotEnv {
    $path = Join-Path $PSScriptRoot ".env"
    $out = @{}
    if (Test-Path $path) {
        foreach ($line in (Get-Content $path)) {
            $t = $line.Trim()
            if (-not $t -or $t.StartsWith("#")) { continue }
            $i = $t.IndexOf("=")
            if ($i -lt 1) { continue }
            $out[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"', "'")
        }
    }
    return $out
}

$dotenv = Read-DotEnv
if (-not $AthleteId) { $AthleteId = $dotenv["INTERVALS_ATHLETE_ID"] }
if (-not $AthleteId) { $AthleteId = $env:INTERVALS_ATHLETE_ID }
if (-not $ApiKey) { $ApiKey = $dotenv["INTERVALS_API_KEY"] }
if (-not $ApiKey) { $ApiKey = $env:INTERVALS_API_KEY }

if (-not $AthleteId -or -not $ApiKey) {
    throw @"
No intervals.icu credentials found.

Create a file called .env beside this script containing:

    INTERVALS_ATHLETE_ID=i123456
    INTERVALS_API_KEY=your_key_here

Both are at the bottom of https://intervals.icu/settings
(.env is listed in .gitignore, so it never reaches the repo.)
"@
}
if ($AthleteId -notmatch '^i') { $AthleteId = "i$AthleteId" }

$authHeader = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("API_KEY:$ApiKey"))
$headers = @{ Authorization = $authHeader; Accept = "application/json" }

function Invoke-Icu($Url) {
    try {
        return Invoke-RestMethod -Uri $Url -Headers $headers -TimeoutSec 120 -ErrorAction Stop
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -eq 401 -or $code -eq 403) {
            throw "$code from intervals.icu. Two usual causes: the athlete id needs a leading 'i' (i123456), or the API key has been regenerated on the settings page."
        }
        throw
    }
}

# ------------------------------------------------------------------ helpers

function Get-Field($obj, $names) {
    foreach ($n in $names) {
        if ($null -ne $obj.PSObject.Properties[$n]) {
            $v = $obj.$n
            if ($null -ne $v -and "$v" -ne "") { return $v }
        }
    }
    return $null
}

function Encode-Polyline($coords) {
    $sb = New-Object System.Text.StringBuilder
    $plat = [int64]0; $plng = [int64]0
    foreach ($c in $coords) {
        $ilat = [int64][math]::Round($c[0] * 1e5)
        $ilng = [int64][math]::Round($c[1] * 1e5)
        foreach ($d in @(($ilat - $plat), ($ilng - $plng))) {
            $v = [int64]$d
            if ($v -lt 0) { $v = -bnot ($v * 2) } else { $v = $v * 2 }
            while ($v -ge 32) {
                [void]$sb.Append([char][int]((32 -bor ($v -band 31)) + 63))
                $v = [int64][math]::Floor($v / 32)
            }
            [void]$sb.Append([char][int]($v + 63))
        }
        $plat = $ilat; $plng = $ilng
    }
    return $sb.ToString()
}

function Get-BestEfforts($dist, $tsec) {
    # Fastest rolling window per target distance. Two-pointer with linear
    # interpolation at the trailing edge so a window is exactly the target length.
    $out = [ordered]@{}
    $n = $dist.Count
    if ($n -lt 2) { return $out }
    $total = $dist[$n - 1]
    foreach ($key in $EffortTargets.Keys) {
        $target = $EffortTargets[$key]
        if ($total -lt $target) { continue }
        $best = [double]::MaxValue
        $i = 0
        for ($j = 0; $j -lt $n; $j++) {
            while (($i + 1) -lt $j -and ($dist[$j] - $dist[$i + 1]) -ge $target) { $i++ }
            $span = $dist[$j] - $dist[$i]
            if ($span -lt $target) { continue }
            $seg = 0.0
            if (($i + 1) -lt $n) { $seg = $dist[$i + 1] - $dist[$i] }
            $tStart = $tsec[$i]
            if ($seg -gt 0) { $tStart = $tsec[$i] + ($tsec[$i + 1] - $tsec[$i]) * (($span - $target) / $seg) }
            $dur = $tsec[$j] - $tStart
            if ($dur -gt 0 -and $dur -lt $best) { $best = $dur }
        }
        if ($best -lt [double]::MaxValue) { $out[$key] = [math]::Round($best, 1) }
    }
    return $out
}

function Get-KmSplits($dist, $tsec, $hr, $alt) {
    $splits = @()
    $n = $dist.Count
    if ($n -lt 2) { return $splits }
    $totalKm = [int][math]::Floor($dist[$n - 1] / 1000)
    $j = 0; $prevT = $tsec[0]; $prevI = 0
    for ($k = 1; $k -le $totalKm; $k++) {
        $target = $k * 1000
        while ($j -lt $n -and $dist[$j] -lt $target) { $j++ }
        if ($j -ge $n) { break }
        $tCross = $tsec[$j]
        if ($j -gt 0 -and $dist[$j] -ne $dist[$j - 1]) {
            $frac = ($target - $dist[$j - 1]) / ($dist[$j] - $dist[$j - 1])
            $tCross = $tsec[$j - 1] + ($tsec[$j] - $tsec[$j - 1]) * $frac
        }
        $segHr = $null
        if ($hr) {
            $vals = @(); for ($x = $prevI; $x -le $j; $x++) { if ($null -ne $hr[$x]) { $vals += $hr[$x] } }
            if ($vals.Count) { $segHr = [int][math]::Round(($vals | Measure-Object -Average).Average) }
        }
        $segEl = $null
        if ($alt -and $j -gt $prevI) {
            $gain = 0.0
            for ($x = $prevI + 1; $x -le $j; $x++) {
                if ($null -ne $alt[$x] -and $null -ne $alt[$x - 1]) {
                    $d = $alt[$x] - $alt[$x - 1]; if ($d -gt 0) { $gain += $d }
                }
            }
            $segEl = [int][math]::Round($gain)
        }
        $splits += , [ordered]@{ k = $k; t = [math]::Round($tCross - $prevT, 1); hr = $segHr; el = $segEl }
        $prevT = $tCross; $prevI = $j
    }
    return $splits
}

function Get-HrZones($tsec, $hr) {
    if (-not $hr) { return $null }
    $zones = @(0.0, 0.0, 0.0, 0.0, 0.0)
    for ($i = 1; $i -lt $tsec.Count; $i++) {
        $dt = $tsec[$i] - $tsec[$i - 1]
        if ($dt -lt 0) { $dt = 0 } elseif ($dt -gt 15) { $dt = 15 }   # ignore pauses
        $h = $hr[$i]
        if ($null -eq $h) { continue }
        $z = 0; foreach ($b in $ZoneBounds) { if ($h -ge $b) { $z++ } }
        $zones[$z] += $dt
    }
    return @($zones | ForEach-Object { [int][math]::Round($_) })
}

function Get-SimplifiedRoute($latlng, $dist) {
    # Keep a point roughly every 12 m, capped at ~1800 points.
    $keep = @(0); $lastD = $dist[0]
    for ($i = 1; $i -lt $latlng.Count; $i++) {
        if (($dist[$i] - $lastD) -ge 12) { $keep += $i; $lastD = $dist[$i] }
    }
    if ($keep[-1] -ne ($latlng.Count - 1)) { $keep += ($latlng.Count - 1) }
    if ($keep.Count -gt 1800) {
        $step = $keep.Count / 1800.0
        $thin = @(); for ($i = 0; $i -lt 1800; $i++) { $thin += $keep[[int]($i * $step)] }
        $thin += $keep[-1]; $keep = $thin
    }
    return @($keep | ForEach-Object { $latlng[$_] })
}

# ------------------------------------------------------------------ activities

$newest = (Get-Date).ToString("yyyy-MM-dd")
Write-Host "Fetching activities $Oldest -> $newest ..."
$raw = Invoke-Icu "$ApiRoot/athlete/$AthleteId/activities?oldest=$Oldest&newest=$newest"
Write-Host "intervals.icu returned $($raw.Count) activities"

$fresh = @()
foreach ($r in $raw) {
    $type = Get-Field $r $Candidates.type
    if ("$type" -notmatch "Run") { continue }
    $row = [ordered]@{}
    foreach ($col in $OutCols) { $row[$col] = "" }

    $distM = Get-Field $r $Candidates.distance_m
    if ($null -eq $distM) { continue }
    $km = [math]::Round([double]$distM / 1000, 3)
    if ($km -lt 0.5) { continue }

    $d = Get-Field $r $Candidates.date
    if (-not $d) { continue }
    $row.date = ([datetime]::Parse($d, [Globalization.CultureInfo]::InvariantCulture)).ToString("yyyy-MM-dd")
    $row.distance_km = $km
    $row.id = "$(Get-Field $r $Candidates.id)"
    $row.name = Get-Field $r $Candidates.name
    $row.type = $type
    foreach ($col in @("moving_time_s", "elapsed_time_s", "avg_hr", "max_hr", "stride_m", "gct_ms",
                       "vert_osc_cm", "avg_power_w", "vo2max", "elev_gain_m", "load", "intensity",
                       "avg_temp_c", "calories")) {
        $v = Get-Field $r $Candidates[$col]
        if ($null -ne $v) { $row[$col] = $v }
    }
    $cad = Get-Field $r $Candidates.cadence_spm
    if ($null -ne $cad) { $row.cadence_spm = [double]$cad }
    $fresh += , [pscustomobject]$row
}
Write-Host "$($fresh.Count) of those are runs"

# some devices report cadence per leg; normalise to full steps per minute
$cads = @($fresh | Where-Object { $_.cadence_spm -ne "" } | ForEach-Object { [double]$_.cadence_spm })
if ($cads.Count) {
    $sorted = $cads | Sort-Object
    $med = $sorted[[int]($sorted.Count / 2)]
    if ($med -lt 120) {
        Write-Host "  cadence looks per-leg, doubling it"
        foreach ($f in $fresh) { if ($f.cadence_spm -ne "") { $f.cadence_spm = [double]$f.cadence_spm * 2 } }
    }
}
foreach ($f in $fresh) { if ($f.cadence_spm -ne "") { $f.cadence_spm = [math]::Round([double]$f.cadence_spm, 1) } }

# --- merge with what is already on disk so the old Garmin history survives.
# intervals.icu does not pass through Garmin's running dynamics (stride, ground
# contact, oscillation), so fetched rows fill blanks from the existing ones
# rather than replacing them wholesale.
$csvPath = Join-Path $PSScriptRoot "activities.csv"
$merged = $fresh
if (Test-Path $csvPath) {
    $existing = @(Import-Csv $csvPath -Encoding UTF8)
    $keyOf = {
        param($r)
        $km = [math]::Round([double]$r.distance_km, 2)
        "$($r.date)|$km"
    }
    $byKey = @{}
    foreach ($e in $existing) {
        $k = & $keyOf $e
        if (-not $byKey.ContainsKey($k)) { $byKey[$k] = @() }
        $byKey[$k] += , $e
    }
    $seen = @{}
    foreach ($f in $fresh) {
        $k = & $keyOf $f
        $idx = 0; if ($seen.ContainsKey($k)) { $idx = $seen[$k] }
        $seen[$k] = $idx + 1
        if ($byKey.ContainsKey($k) -and $byKey[$k].Count -gt $idx) {
            $old = $byKey[$k][$idx]
            foreach ($col in $OutCols) {
                if (("$($f.$col)" -eq "") -and $null -ne $old.PSObject.Properties[$col]) { $f.$col = $old.$col }
            }
            $byKey[$k][$idx] = $null
        }
    }
    # carry across any historical rows intervals.icu no longer returns
    $carried = @()
    foreach ($k in $byKey.Keys) {
        foreach ($e in $byKey[$k]) {
            if ($null -eq $e) { continue }
            $row = [ordered]@{}
            foreach ($col in $OutCols) {
                $row[$col] = if ($null -ne $e.PSObject.Properties[$col]) { $e.$col } else { "" }
            }
            $carried += , [pscustomobject]$row
        }
    }
    Write-Host "$($existing.Count) existing + $($fresh.Count) fetched -> $($fresh.Count + $carried.Count) after merge"
    $merged = @($fresh) + @($carried)
}

if (-not $merged.Count) { throw "Nothing to write - stopping rather than overwriting good data." }
$merged = $merged | Sort-Object { $_.date }
$merged | Select-Object $OutCols | Export-Csv $csvPath -NoTypeInformation -Encoding UTF8
Write-Host "Saved $($merged.Count) runs ($($merged[0].date) to $($merged[-1].date))" -ForegroundColor Green

# ------------------------------------------------------------------ wellness

Write-Host "Fetching wellness ..."
try {
    $well = Invoke-Icu "$ApiRoot/athlete/$AthleteId/wellness?oldest=$Oldest&newest=$newest"
    $wrows = @()
    foreach ($w in $well) {
        $row = [ordered]@{ date = $w.id }
        $any = $false
        foreach ($k in $WellnessFields.Keys) {
            $v = Get-Field $w $WellnessFields[$k]
            $row[$k] = if ($null -ne $v) { $any = $true; $v } else { "" }
        }
        if ($row.date -and $any) { $wrows += , [pscustomobject]$row }
    }
    if ($wrows.Count) {
        $wrows = $wrows | Sort-Object { $_.date }
        $wrows | Export-Csv (Join-Path $PSScriptRoot "wellness.csv") -NoTypeInformation -Encoding UTF8
        Write-Host "wellness: saved $($wrows.Count) days -> wellness.csv" -ForegroundColor Green
    } else {
        Write-Host "wellness: nothing returned" -ForegroundColor Yellow
    }
} catch {
    Write-Host "wellness fetch failed - skipping ($($_.Exception.Message))" -ForegroundColor Yellow
}

# ------------------------------------------------------------------ streams

if ($NoStreams) { Write-Host "streams: skipped (-NoStreams)"; return }

New-Item -ItemType Directory -Force $RunsDir | Out-Null
$ids = @($merged | ForEach-Object { "$($_.id)" } | Where-Object { $_ -and $_ -ne "" })
$todo = @($ids | Where-Object { -not (Test-Path (Join-Path $RunsDir "$_.json")) })
if (-not $todo.Count) {
    Write-Host "streams: cache is up to date ($($ids.Count) runs)"
    return
}
$deferred = 0
if ($todo.Count -gt $MaxStreams) { $deferred = $todo.Count - $MaxStreams; $todo = $todo[0..($MaxStreams - 1)] }
Write-Host "streams: fetching $($todo.Count) activities ($($ids.Count - $todo.Count) cached or deferred)"

$n = 0
foreach ($id in $todo) {
    $n++
    try {
        $streams = Invoke-Icu "$ApiRoot/activity/$id/streams?types=time,distance,latlng,heartrate,altitude"
    } catch {
        Write-Host "  [$n/$($todo.Count)] $id - $($_.Exception.Message); will retry next sync" -ForegroundColor Yellow
        continue
    }
    $byType = @{}
    foreach ($s in $streams) { if ($s.type) { $byType[$s.type] = $s.data } }

    $tsec = $byType["time"]; $dist = $byType["distance"]
    if (-not $tsec -or -not $dist -or $tsec.Count -lt 10) {
        @{ id = $id; no_streams = $true } | ConvertTo-Json -Compress | Out-File (Join-Path $RunsDir "$id.json") -Encoding utf8
        Write-Host "  [$n/$($todo.Count)] $id - no streams"
        continue
    }
    $tsec = @($tsec | ForEach-Object { [double]$_ })
    # force monotonic distance: GPS jitter can step backwards
    $dist = @($dist | ForEach-Object { if ($null -eq $_) { 0.0 } else { [double]$_ } })
    $run = 0.0
    for ($i = 0; $i -lt $dist.Count; $i++) { if ($dist[$i] -gt $run) { $run = $dist[$i] } else { $dist[$i] = $run } }

    $hr = $null
    if ($byType["heartrate"] -and $byType["heartrate"].Count -eq $tsec.Count) { $hr = $byType["heartrate"] }
    $alt = $null
    if ($byType["altitude"] -and $byType["altitude"].Count -eq $tsec.Count) { $alt = $byType["altitude"] }

    $rec = [ordered]@{
        id      = $id
        efforts = Get-BestEfforts $dist $tsec
        splits  = Get-KmSplits $dist $tsec $hr $alt
        zones   = Get-HrZones $tsec $hr
    }

    $latlng = $byType["latlng"]
    if ($latlng -and $latlng.Count -eq $tsec.Count) {
        $pts = @(); $pd = @()
        for ($i = 0; $i -lt $latlng.Count; $i++) {
            $p = $latlng[$i]
            if ($p -and $p.Count -ge 2 -and $null -ne $p[0]) { $pts += , @([double]$p[0], [double]$p[1]); $pd += $dist[$i] }
        }
        if ($pts.Count -gt 10) {
            $route = Get-SimplifiedRoute $pts $pd
            $lats = @($route | ForEach-Object { $_[0] }); $lngs = @($route | ForEach-Object { $_[1] })
            $rec.poly = Encode-Polyline $route
            $rec.bbox = @(
                [math]::Round(($lats | Measure-Object -Minimum).Minimum, 5),
                [math]::Round(($lngs | Measure-Object -Minimum).Minimum, 5),
                [math]::Round(($lats | Measure-Object -Maximum).Maximum, 5),
                [math]::Round(($lngs | Measure-Object -Maximum).Maximum, 5)
            )
        }
    }
    $rec | ConvertTo-Json -Compress -Depth 8 | Out-File (Join-Path $RunsDir "$id.json") -Encoding utf8
    $tag = "$($rec.splits.Count) km"
    if ($rec.poly) { $tag += ", route" }
    Write-Host "  [$n/$($todo.Count)] $id - $tag"
    Start-Sleep -Milliseconds 250
}
if ($deferred) { Write-Host "$deferred activities deferred to the next run (-MaxStreams)" -ForegroundColor Yellow }
Write-Host "Done. Now run: .\build.ps1" -ForegroundColor Green
