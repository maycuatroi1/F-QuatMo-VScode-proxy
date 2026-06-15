# 🛠️ Quạt Mo Project Setup Guide

This project consists of the **Quạt Mo Proxy (Bun/TypeScript)** and the **Classifier Server (FastAPI/Python)**.

Due to file sizes and security policies, several files are ignored by Git and must be added manually after cloning or pulling the repository.

---

## 📋 Required Files to Add

### 1. In `quatmo-proxy/` (Proxy Server)

| File / Folder | Status | Source / Instruction |
| :--- | :--- | :--- |
| **`.env`** | **Required** | Copy from `.env.example` and fill in API Keys (OpenAI, OpenRouter, Custom). |
| **`bin/classifier.exe`** | *Optional* | internal release (~826MB). Only needed for local fallback subprocess mode. |

### 2. In `classifier_source/` (AI Classifier Service)

| File / Folder | Status | Source / Instruction |
| :--- | :--- | :--- |
| **`.env`** | **Required** | Copy from `.env.example` and fill in `CLASSIFIER_API_KEY`. |
| **`model.safetensors`** | **Required** | Place the model weights (~2.6GB) in this directory. |
| **`tokenizer.json`** | **Required** | Place the tokenizer config file (~11MB) in this directory. |

---

## 🚀 Quick Start

### 1. Environment Configurations

Copy environment templates:

- **Windows (PowerShell):**
  ```powershell
  Copy-Item .\quatmo-proxy\.env.example .\quatmo-proxy\.env
  Copy-Item .\classifier_source\.env.example .\classifier_source\.env
  ```
- **Linux / macOS:**
  ```bash
  cp quatmo-proxy/.env.example quatmo-proxy/.env
  cp classifier_source/.env.example classifier_source/.env
  ```
*Open both `.env` files and fill in the required API keys.*

### 2. Add AI Model Files
Place the downloaded model files in `classifier_source/`:
```text
classifier_source/
├── model.safetensors    # Core model weights (~2.6GB)
└── tokenizer.json       # Tokenizer config (~11MB)
```

### 3. Run the Applications

#### Run Python Classifier API
```bash
cd classifier_source
python -m venv .venv
# Activate venv (Windows: .venv\Scripts\activate | Unix: source .venv/bin/activate)
pip install -r requirements.txt
python app.py
```
*API runs at `http://127.0.0.1:8000`*

#### Run Proxy Server
```bash
cd quatmo-proxy
bun install
bun run dev
```
*(Make sure Redis Server is running. Proxy runs at `http://localhost:3000`)*
