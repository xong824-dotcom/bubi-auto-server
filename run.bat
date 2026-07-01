@echo off
title Bubeelive Auto Helper Bot Launcher
chcp 65001 > nul

echo ===================================================
echo 🚀 Bubeelive Auto Helper Bot 기동 스크립트
echo ===================================================

:: 1. Node.js 설치 여부 확인
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 에러: 이 컴퓨터에 Node.js가 설치되어 있지 않습니다.
    echo Node.js 공식 사이트(https://nodejs.org/)에서 LTS 버전을 설치한 후 다시 실행해 주세요.
    pause
    exit /b
)

:: 2. .env 설정 파일 체크 및 생성
if not exist .env (
    if exist .env.example (
        echo 📝 .env 설정 파일이 존재하지 않아 .env.example 복사본을 생성합니다...
        copy .env.example .env > nul
        echo.
        echo ===================================================
        echo ⚠️  경고: 새로 생성된 .env 파일에 계정 정보가 비어있습니다.
        echo 폴더 내의 .env 파일을 메모장으로 열어 BUBEE_ID, BUBEE_PW 등을 적은 후
        echo 이 창을 닫고 다시 실행해 주세요!
        echo ===================================================
        pause
        exit /b
    ) else (
        echo ❌ 에러: 설정 템플릿(.env.example) 파일이 존재하지 않습니다.
        pause
        exit /b
    )
)

:: 3. 의존성 패키지 설치
if not exist node_modules (
    echo 📦 처음 실행하는 환경입니다. 의존성 패키지를 설치 중... (약 1분 소요)
    call npm install
    if %errorlevel% neq 0 (
        echo ❌ 패키지 설치 중 오류가 발생했습니다. 인터넷 연결 및 권한을 확인하세요.
        pause
        exit /b
    )
)

:: 4. 봇 기동
echo 🚀 봇을 실행합니다...
node index.js
pause
