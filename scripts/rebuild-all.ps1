# Triggers a Vercel rebuild for every live brand site by POSTing each
# vercel_deploy_hook_url in bronze.brand_sites where is_live = true.
# Run from the repo root: .\scripts\rebuild-all.ps1 [-DryRun]   (-DryRun lists sites, POSTs nothing)
# Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (or already in the env).
# Deploy hooks are readable with the service key only (not in public.brand_sites,
# column not granted to anon on bronze.brand_sites) - see sql/brand_sites_hide_deploy_hook.sql.

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

# Load .env if present (simple KEY=VALUE lines; no quoting rules needed here)
$envFile = Join-Path $PSScriptRoot '..\.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=\s][^=]*)=(.*)$') {
            $name = $Matches[1].Trim()
            $value = $Matches[2].Trim()
            # .env wins over inherited vars: the user-scope SUPABASE_SERVICE_ROLE_KEY
            # can be a stale legacy key (disabled 2026-04-15).
            Set-Item -Path "env:$name" -Value $value
        }
    }
}

if (-not $env:SUPABASE_URL -or -not $env:SUPABASE_SERVICE_ROLE_KEY) {
    Write-Error 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example).'
}

$headers = @{
    apikey           = $env:SUPABASE_SERVICE_ROLE_KEY
    Authorization    = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
    'Accept-Profile' = 'bronze'
}

$uri = "$($env:SUPABASE_URL)/rest/v1/brand_sites?is_live=eq.true&select=slug,vercel_deploy_hook_url&limit=10000"
# Explicit UA: Supabase refuses sb_secret keys from browser-like clients, and the
# Windows PowerShell default UA starts with "Mozilla/5.0".
$sites = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -UserAgent 'fogo-brand-sites/rebuild-all'

if (-not $sites -or $sites.Count -eq 0) {
    Write-Host 'No live sites found (brand_sites.is_live = true). Nothing to rebuild.'
    exit 0
}

$triggered = 0
foreach ($site in $sites) {
    if ([string]::IsNullOrWhiteSpace($site.vercel_deploy_hook_url)) {
        Write-Warning "$($site.slug): is_live but vercel_deploy_hook_url is empty - skipping."
        continue
    }
    if ($DryRun) {
        Write-Host "Would trigger rebuild: $($site.slug)"
        continue
    }
    Write-Host "Triggering rebuild: $($site.slug)"
    Invoke-RestMethod -Uri $site.vercel_deploy_hook_url -Method Post | Out-Null
    $triggered++
}

Write-Host "Done. $triggered deploy hook(s) triggered."
