# Quạt Mo Proxy Server

Quạt Mo Proxy Server là hệ thống Middleware Proxy trung gian được thiết kế để điều phối, xác thực bảo mật, giới hạn tần suất (rate limiting), tính toán token và phân loại prompt học thuật giữa **VS Code Extension (Quạt Mo - Code)** và các **Upstream LLM Providers** (OpenAI, OpenRouter, LiteLLM Custom).

---

## 🏗️ Cấu Trúc Dự Án (Project Structure)

Dự án được xây dựng bằng ngôn ngữ **TypeScript** trên nền tảng runtime **Bun** (cho tốc độ thực thi vượt trội và tương thích tối đa với thư viện Node.js).

```text
quatmo-proxy/
├── bin/
│   └── classifier.exe       # Trình phân loại Prompt cục bộ (Fallback Local Dev)
├── src/
│   ├── config/             # Giới hạn upload và vị trí manifest/artifact release
│   ├── middleware/         # Xác thực, ownership, fingerprint, phiên bản, rate limit
│   ├── routes/             # Khai báo endpoint, thứ tự middleware và export tương thích
│   ├── modules/
│   │   ├── auth/           # Đăng nhập tài khoản và admin
│   │   ├── sessions/       # Quản trị phiên, login, status, SSE, upload log
│   │   ├── chat/           # Context, completions, upstream, prompt, tool call, logging
│   │   ├── visualization/  # Danh sách, prompt/event log, snapshot, record upload
│   │   ├── telemetry/      # JSONL, đồng bộ token, tải log
│   │   ├── releases/       # Manifest, cache, update protocol, artifact, publish
│   │   └── ...             # users, groups, lecturers, security, storage
│   ├── shared/http/        # Caller và client-IP dùng chung
│   ├── services/
│   │   ├── proxyKey.ts      # Khởi tạo và quản lý Access Key của Proxy
│   │   ├── redis.ts         # Kết nối Redis và reconnect/fallback
│   │   └── token.ts         # Tính toán lượng token tiêu thụ (dựa trên Tiktoken)
│   └── index.ts             # Entry point khởi tạo Hono Server
├── .env.example             # File mẫu cấu hình biến môi trường
├── package.json             # Định nghĩa dependencies & scripts chạy dự án
└── tsconfig.json            # Cấu hình TypeScript compiler
```

Tài liệu chuyển giao: [kiến trúc và cách kiểm tra](docs/architecture-handoff.md),
[bảng kết quả từng task](docs/restructuring-baseline.md). Đợt tách module giữ nguyên
API/nghiệp vụ trừ các sửa lỗi được ghi rõ trong báo cáo; kiểm thử local không thay
thế kiểm tra môi trường triển khai thực tế.

---

## ⚡ Các Điểm Thiết Kế Chuẩn Production

### 1. Bảo Mật & Che Giấu Key Gốc (API Key Encapsulation)

- **Tuyệt đối không rò rỉ key gốc**: Hệ thống được cấu hình để loại bỏ hoàn toàn việc chấp nhận các API Key gốc từ OpenAI/OpenRouter làm Bearer Token gửi từ Client lên.
- **Cơ chế hoạt động**: Client chỉ sử dụng **Proxy Access Key** đại diện (được cấp riêng). Khi nhận request, Proxy xác thực Access Key đó và tự đính kèm Key gốc (`OPENAI_API_KEY`,...) từ môi trường của server để giao tiếp với AI Provider. Key gốc sẽ không bao giờ bị lộ ra đường truyền mạng.

### 2. Tối Ưu Hóa Hiệu Năng Phân Loại (Parallel Prompt Classifier)

- **Xử lý song song (Non-blocking)**: Tiến trình phân loại prompt (Classifier) chạy hoàn toàn song song với luồng truy vấn LLM chính, giúp thời gian phản hồi chữ đầu tiên (Time-To-First-Token) không bị ảnh hưởng.
- **Hỗ trợ Dual-mode linh hoạt**:
  - **Chế độ Web API (Production)**: Gọi qua một REST API của Classifier (ví dụ viết bằng FastAPI) thông qua kết nối HTTP không đồng bộ. Phương án này siêu nhẹ, giải phóng 100% CPU của Proxy Server.
  - **Chế độ Subprocess (Local Fallback)**: Tự động chạy file `classifier.exe` cục bộ nếu không cấu hình Web API URL.
- **Timeout Guard 10 giây**: Áp dụng cơ chế ngắt cưỡng bức sau 10 giây (dùng `SIGKILL` với binary và `AbortSignal` với API) để tránh tình trạng classifier bị treo làm nghẽn/leak tài nguyên HTTP request của người dùng.

### 3. Khả Năng Chống Quá Tải & Fail-Open

- **Redis Rate Limiting**: Giới hạn mặc định 30 requests/phút cho mỗi key của học sinh thông qua Redis để tránh spam và DDoS.
- **Fail-Open Design**: Nếu kết nối Redis bị gián đoạn hoặc gặp sự cố, hệ thống sẽ tự động chuyển sang chế độ bỏ qua giới hạn tần suất (Fail-Open) để đảm bảo học sinh không bị gián đoạn bài thi, thay vì chặn đứng toàn bộ request.

---

## 🚀 Hướng Dẫn Cài Đặt & Chạy Dự Án

### Yêu Cầu Hệ Thống

- [Bun Runtime](https://bun.sh/) (Phiên bản mới nhất)
- [Redis Server](https://redis.io/) (Để kích hoạt tính năng Rate Limiting và Token Cache)

### Bước 1: Cài đặt Dependencies

```bash
bun install
```

### Bước 2: Cấu hình Biến Môi Trường (`.env`)

Tạo file `.env` từ file mẫu `.env.example`:

```bash
cp .env.example .env
```

Cấu hình các tham số sau trong file `.env`:

```env
# Cổng chạy Proxy (Mặc định: 3000)
PORT=3000

# Đường dẫn Redis Cache (VD: redis://localhost:6379)
REDIS_URL=redis://localhost:6379

# Khóa truy cập Master đại diện (Khuyên dùng: chuỗi ngẫu nhiên bắt đầu bằng sk-)
# Nếu comment dòng này, Proxy sẽ tự tạo khoá ngẫu nhiên thay đổi mỗi lần khởi động
PROXY_API_KEY=sk-your-random-proxy-access-key

# Upstream LLM Provider API Keys (Key gốc của các bên cung cấp)
OPENAI_API_KEY=sk-proj-...
OPENROUTER_API_KEY=sk-or-v1-...

# Cấu hình Custom Endpoint (Ví dụ: LiteLLM)
CUSTOM_BASE_URL=https://quatmo-api.iahn.hanoi.vn/v1
CUSTOM_API_KEY=sk-custom-...
CUSTOM_MODEL_NAME=qwen3-coder

# URL của Classifier Web API (Nếu chạy API riêng). Bỏ trống nếu muốn chạy qua classifier.exe cục bộ.
CLASSIFIER_API_URL=http://127.0.0.1:8000/classify
```

### Bước 3: Biên Dịch Dự Án (Build)

```bash
bun run build
```

### Bước 4: Khởi Động Dự Án

- **Chế độ phát triển (Development - Hot Reload)**:

  ```bash
  bun run dev
  ```

- **Chế độ sản xuất (Production)**:
  ```bash
  bun run start
  ```

---

## 🛠️ Hướng Dẫn Triển Khai Web API Cho Classifier (Để chạy chuẩn Production)

Khi chạy service Python Classifier, bạn chỉ cần đặt cấu hình `CLASSIFIER_API_URL=http://127.0.0.1:8000/classify` vào `.env` của Proxy. Mọi cuộc gọi phân loại prompt sẽ chuyển sang gọi HTTP cực kỳ nhẹ nhàng và nhanh chóng.

## Process Summary

Sinh summary thủ công cho từng sinh viên hoặc cả session: xem [cấu hình engine và báo cáo kiểm thử](docs/summary-integration.md).

Dockerfile đã đóng gói Python và summary engine. Commit cả thư mục `summary_tool/`,
build bằng Dockerfile rồi deploy branch đang dùng trên Dokploy; không cần cài thêm
engine thủ công trên server. Nếu đã khai báo ENV đường dẫn, dùng
`SUMMARY_CLI_PATH=/opt/summary-tool/generate_cli.py` và
`SUMMARY_PYTHON_BIN=/usr/bin/python3`. Giữ nguyên volume dữ liệu `/app/logs`.
