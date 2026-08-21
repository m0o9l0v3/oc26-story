param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20以上が見つかりません。"
}
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  throw "cloudflaredが見つかりません。インストール後にもう一度実行してください。"
}

$pin = Read-Host "当日用の運営者PINを入力してください"
if ($pin.Length -lt 4 -or $pin -eq "260822") {
  throw "4文字以上で、開発用PIN 260822とは異なるPINを設定してください。"
}

$env:PORT = [string]$Port
$env:NODE_ENV = "production"
$env:OPERATOR_PIN = $pin
$env:DATA_DIR = Join-Path $projectRoot "data"
$env:TRUST_CF_CONNECTING_IP = "true"

Write-Host "アプリを起動しています..."
$server = Start-Process node -ArgumentList "src/server.js" -PassThru -NoNewWindow

try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$Port/health/ready" -TimeoutSec 2
      if ($health.status -eq "ready") {
        $ready = $true
        break
      }
    } catch {
      # 起動完了まで再試行します。
    }
  }
  if (-not $ready) {
    throw "アプリがreadyになりません。画面に表示されたエラーを主担当へ伝えてください。"
  }

  Write-Host ""
  Write-Host "アプリは正常です。Cloudflare Quick Tunnelを起動します。"
  Write-Host "表示される https://～.trycloudflare.com のURLをコピーしてください。"
  Write-Host "参加者用URLは、その末尾に /participant を付けたものです。"
  Write-Host "この画面はイベント終了まで閉じないでください。"
  Write-Host ""

  & cloudflared tunnel --url "http://127.0.0.1:$Port"
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id
  }
  $env:OPERATOR_PIN = $null
}
