# Triggers a Vercel rebuild for every live brand site by POSTing each
# vercel_deploy_hook_url in public.brand_sites where is_live = true.
# Run from the repo root: .\scripts\rebuild-all.ps1
# Requires SUPABASE_URL and SUPABASE_ANON_KEY in .env (or already in the env).

$ErrorActionPreference = 'Stop'

# Load .env if present (simple KEY=VALUE lines; no quoting rules needed here)
$envFile = Join-Path $PSScriptRoot '..\.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=\s][^=]*)=(.*)$') {
            $name = $Matches[1].Trim()
            $value = $Matches[2].Trim()
            if (-not (Test-Path "env:$name")) {
                Set-Item -Path "env:$name" -Value $value
            }
        }
    }
}

if (-not $env:SUPABASE_URL -or -not $env:SUPABASE_ANON_KEY) {
    Write-Error 'SUPABASE_URL and SUPABASE_ANON_KEY must be set (see .env.example).'
}

$headers = @{
    apikey        = $env:SUPABASE_ANON_KEY
    Authorization = "Bearer $($env:SUPABASE_ANON_KEY)"
}

$uri = "$($env:SUPABASE_URL)/rest/v1/brand_sites?is_live=eq.true&select=slug,vercel_deploy_hook_url&limit=10000"
$sites = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get

if (-not $sites -or $sites.Count -eq 0) {
    Write-Host 'No live sites found (brand_sites.is_live = true). Nothing to rebuild.'
    exit 0
}

$triggered = 0
foreach ($site in $sites) {
    if ([string]::IsNullOrWhiteSpace($site.vercel_deploy_hook_url)) {
        Write-Warning "$($site.slug): is_live but vercel_deploy_hook_url is empty — skipping."
        continue
    }
    Write-Host "Triggering rebuild: $($site.slug)"
    Invoke-RestMethod -Uri $site.vercel_deploy_hook_url -Method Post | Out-Null
    $triggered++
}

Write-Host "Done. $triggered deploy hook(s) triggered."
