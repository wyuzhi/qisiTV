param(
    [Parameter(Mandatory = $true)]
    [string]$WebViewDir
)

$ErrorActionPreference = 'SilentlyContinue'
if ([string]::IsNullOrWhiteSpace($WebViewDir)) {
    exit 0
}

$normalized = [System.IO.Path]::GetFullPath($WebViewDir).TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($normalized)) {
    exit 0
}

$pattern = '*' + $normalized + '*'
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like $pattern) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
exit 0
