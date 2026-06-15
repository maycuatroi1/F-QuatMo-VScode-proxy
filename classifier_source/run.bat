@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   Khoi dong Quat Mo Classifier Web API
echo ===================================================

:: Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [Loi] Khong tim thay Python. Vui long cai dat Python 3.9+ va thu lai.
    pause
    exit /b 1
)

:: Create virtual environment if not exists
if not exist .venv (
    echo [!] Chua co thu muc .venv. Dang khoi tao virtual environment...
    python -m venv .venv
    if %errorlevel% neq 0 (
        echo [Loi] Khong the khoi tao virtual environment.
        pause
        exit /b 1
    )
    echo [Ok] Khoi tao .venv thanh cong.
)

:: Activate virtual environment
call .venv\Scripts\activate

:: Check if requirements are installed
python -c "import fastapi" >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Dang cai dat cac thu vien phu thuoc tu requirements.txt...
    pip install -r requirements.txt
    if %errorlevel% neq 0 (
        echo [Loi] Cai dat dependencies that bai.
        pause
        exit /b 1
    )
    echo [Ok] Cai dat hoan tat.
) else (
    echo [Ok] Cac thu vien da duoc cai dat day du.
)

echo [!] Dang khoi dong Web API server tren cong 8000...
python app.py
