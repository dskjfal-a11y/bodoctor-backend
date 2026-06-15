# PowerShell 실행 스크립트
# 사용: 바탕화면 → 보험AI백엔드 폴더 → 이 파일 우클릭 → "PowerShell로 실행"

Set-Location -Path $PSScriptRoot

Write-Host "=== 1. Node.js 버전 확인 ===" -ForegroundColor Cyan
node --version
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Node.js가 설치되지 않았습니다." -ForegroundColor Red
    Write-Host "바탕화면의 node-v24.16.0-x64.msi를 더블클릭해 설치한 뒤 다시 실행하세요." -ForegroundColor Yellow
    Pause
    exit 1
}

Write-Host "`n=== 2. 의존성 설치 (처음 한 번만, 2-3분 소요) ===" -ForegroundColor Cyan
if (-Not (Test-Path "node_modules")) {
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ npm install 실패. 위 에러 메시지 확인 후 재시도하세요." -ForegroundColor Red
        Pause
        exit 1
    }
} else {
    Write-Host "이미 설치됨 (건너뜀)" -ForegroundColor Green
}

Write-Host "`n=== 3. .env 파일 확인 ===" -ForegroundColor Cyan
if (-Not (Test-Path ".env")) {
    Write-Host "❌ .env 파일이 없습니다. 폴더에 .env 파일을 만들어주세요." -ForegroundColor Red
    Pause
    exit 1
}
Write-Host ".env 존재 OK" -ForegroundColor Green

Write-Host "`n=== 4. 백엔드 서버 실행 (Ctrl+C로 중지) ===" -ForegroundColor Cyan
Write-Host "서버가 시작되면 http://localhost:8787 에서 응답합니다." -ForegroundColor Yellow
Write-Host "이 창은 닫지 말고, 새 브라우저에서 insurance-ai-gemini.html을 여세요." -ForegroundColor Yellow
Write-Host ""

node 03_backend_server.js
