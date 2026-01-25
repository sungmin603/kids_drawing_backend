@echo off
REM ==========================================
REM  Python 3.10 venv 자동 생성 및 세팅 스크립트
REM ==========================================

echo [INFO] Creating venv...
py -3.12 -m venv venv

echo [INFO] Activating venv...
call venv\Scripts\activate

echo [INFO] Updating pip...
python -m pip install --upgrade pip

if exist requirements.txt (
    echo [INFO] Installating requirements.txt...
    pip install -r requirements.txt
) else (
    echo [WARNING] There is no requirements.txt.
)

echo [SUCCESS] Complete settings!
pause
