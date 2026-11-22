# -*- coding: utf-8 -*-
"""
Constants and default parameters for the PhaseSUMMARY Engine.
Grounded in 'Phương pháp tóm tắt tiến trình làm bài (bản rút gọn, nhiều khía cạnh).md'
and developer specification files 00-08 (Version 3.0, 30/10/2026).
"""
import os
from typing import List

from .config import config

# Tài khoản giảng viên thử tool, không phải sinh viên: không tóm tắt, không tính vào baseline của lớp.
EXCLUDED_ACCOUNTS = {"DATTT67"}
TASK_DIRS = ("Q1", "Q2")  # fvscode.read.task_dirs: thư mục con của bài, mỗi thư mục là một project riêng


def minute_label(t_ms) -> int:
    """Phút thứ mấy của buổi: 0:00–0:59 là phút 1, 5:18 là phút 6 (Bảng 7)."""
    return int(t_ms // 60000) + 1


def minute_start_ms(minute: int) -> int:
    """Mốc mili giây đầu của phút thứ `minute` (phút 1 bắt đầu ở 0)."""
    return max(int(minute) - 1, 0) * 60000


# Default parameters (from tệp 08 Bảng tham số, Version 3.0 & PP Phụ lục B)
DEFAULT_PARAMS = {
    # TH1: Pauses and session estimation
    "pause.tiers_ms": [2000, 15000, 180000, 600000],  # vi mô, ngắn, vừa, dài (Shrestha et al.)
    "pause.session_break_ms": 300000,                  # 5 phút (Hart et al., Tabarsi et al.)
    "pause.step_ms": 120000,                           # 2 phút (Lohr et al.)
    "pause.segment_ms": 180000,                        # 3 phút (U13)
    "pause.include_page_loads": True,                  # U11: lần tải trang mà log thấy là hoạt động
    "dq.unlogged_warn_share": 0.10,                   # DQ1: trên tỷ lệ này là cảnh báo
    "dq.unlogged_fail_share": 0.30,                   # DQ1: trên tỷ lệ này là không đạt
    "dq.unlogged_mention_lines": 10,                  # A5: nêu ở ý chính khi log IDE thiếu từ chừng này dòng (bảng luôn ghi)

    # F-VSCode Terminal & Run parameters (Spec 03)
    "fvscode.run.server_scripts": ["app.py"],
    "fvscode.run.server_min_ms": 60000,
    "fvscode.term.page_noise": ["/favicon.ico", "/.well-known/", "__debugger__="],
    "fvscode.term.snapshot_slack_ms": 1000,
    "fvscode.term.max_lag_ms": 3600000,

    # M0: Linking & Run output
    "link.time_tolerance_ms": 2000,                    # 2s dung sai nối theo thời gian (U24)
    "run.output_tail_chars": 4000,                     # 4000 ký tự cuối stdout/stderr

    # M2: AI segment closing
    "ai.segment_idle_close_ms": 300000,                # 5 phút (Birillo et al.)
    "ai.chain_min_cycles": 2,                          # >= 2 vòng (U14)
    "chains.request_error_min": 3,                     # >= 3 yêu cầu liên tiếp có flag_error (Ma et al., U31)

    # TH2 & TH3: Errors and terminal runs
    "errors.signature_mode": "default",                # default | keep_quoted | type_only (U3)
    "errors.repeat_runs": 3,                           # >= 3 lần chạy lặp cùng lỗi (Arakawa et al., U4)
    "runs.no_edit_repeat": 2,                          # > 2 lần chạy lại không sửa (Tabarsi et al.)
    "runs.minor_change_lines": 2,                      # 1-2 dòng (U5)

    # TH4: Code matching with AI responses
    "match.big_paste_chars": 20,                       # >= 20 ký tự (Ghimire & Edwards)
    "match.close_ratio": 0.90,                         # r >= 0.90 (Rahe & Maalej)
    "match.close_containment": 0.90,                   # c >= 0.90 (U1)
    "match.partial_containment": 0.50,                 # 0.50 <= c < 0.90 (U2)
    "match.max_pair_product": 400000000,               # 4e8 limit for quadratic matching

    # TH5 & TH11: Provenance & Code Spans
    "provenance.min_span_chars": 40,                   # >= 40 ký tự theo dõi (Davalos & Zhang)
    "provenance.repaste_window_ms": 300000,            # 5 phút dán lại (U29)
    "undo.max_lookback": 50,                           # 50 bản ghi lookback cho undo/redo
    "undo.restore_min_share": 0.90,                    # 90% overlap khôi phục nguồn gốc (U28)
    "undo.cancel_window_ms": 30000,                    # 30s cửa sổ cặp bị hủy (U28)

    # TH11 & M4: Retained AI Code
    "aicode.retained_min_chars": 40,                   # còn >= 40 ký tự ở cuối buổi (U25)
    "aicode.max_items": 4,                             # tối đa 4 đoạn kể riêng (U25)
    "aicode.prompt_overlap_lines": 3,                  # >= 3 dòng liên tiếp (U26)

    # TH10: Bursts
    "burst.own_percentile": 95,                        # P95 (Davalos & Zhang)
    "burst.abs_min_chars": 100,                        # 100 ký tự (U10)
    "burst.typed_gap_ms": 2000,                        # 2000 ms gom đợt tự gõ (Davalos & Zhang)
    "burst.baseline_min_events": 20,                   # >= 20 lần gõ mới tính P95 (U10)

    # TH7 & TH8: Prompt taxonomy flags
    "prompt.task_containment": 0.80,                   # c >= 0.80 (U7)
    "prompt.task_paragraph_min_chars": 50,             # 50 ký tự (U7)
    "prompt.own_code_lines": 3,                        # >= 3 dòng code hiện tại (U7)
    "prompt.context_typed_chars": 20,                  # dung sai 20 ký tự (U6)

    # M3: Class Baseline & Largest events LN1 - LN5 (Spec 04 & Spec 08, Version 3.0)
    "baseline.min_class_sessions": 20,                 # >= 20 buổi mới nêu so sánh lớp (U17)
    "baseline.tail_pct": 10,                           # nhóm 10% hai đầu (U17)
    "largest.ln1_min_lines": 5,                        # >= 5 dòng (U14)
    "largest.ln3_min_ms": 600000,                      # 10 phút (U14)
    "largest.keypoint_order": ["LN1", "LN2", "LN4", "LN3", "LN5"],  # U14, U19

    # M4: Content selection
    "select.ai_insert_lines": 5,                       # Đ1: >= 5 dòng (U18)
    "select.chain_failed_runs": 2,                     # Đ2: >= 2 lần chạy lỗi (U18)
    "select.long_pause_ms": 600000,                    # Đ5: >= 10 phút (Shrestha et al.)
    "select.max_timeline_items": 12,                   # tối đa 12 mục dòng thời gian (U18)

    # M5 & M6: LLM & Validation settings
    "llm.enabled": config.model.enabled,
    "llm.model": config.model.model_name,
    "llm.base_url": config.model.base_url,
    "llm.api_key": config.model.api_key,
    "llm.temperature": config.model.temperature,
    "llm.max_retries": config.model.max_retries,        # thử lại khi lỗi mạng hay hết giờ chờ, không phải sinh lại
    "llm.timeout_s": config.model.timeout_s,
    "llm.input_variant": "sentences",                  # sentences | key_value (PP 6.5)
    "llm.prompt_version": "summary-3.1",               # 3.1: bảng lần thêm code, khoảng chờ ghi rõ, từ cấm từ forbidden.txt
    "llm.max_regenerations": 2,                        # sinh lại tối đa 2 lần khi K1–K5 báo lỗi (PP 6.6)
    "llm.max_tokens": 4096,                            # trần token đầu ra của một lần gọi
    "check.moment_tolerance_ms": 60000,                # 60s dung sai ranh giới (U21)
    "render.replay_url_template": "",
    "render.insert_table_min": 3,                      # từ 3 lần thêm code trong một mục AI thì kể bằng bảng
}

# Forbidden words for K4 check (NT2, NT5, PP 6.6, Spec 07 Mục 2 & 4): đọc từ forbidden.txt, dùng chung với B1
FORBIDDEN_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "forbidden.txt")


def load_forbidden_words(path: str = FORBIDDEN_PATH) -> List[str]:
    with open(path, encoding="utf-8") as f:
        return [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]


FORBIDDEN_WORDS = load_forbidden_words()

# Event keyword mapping for K3 check (Spec 07 Mục 2 - K3, Version 3.0)
K3_EVENT_RULES = [
    {"phrases": ["chạy", "chạy lại"], "required_event": "run"},
    {"phrases": ["có lỗi", "trang trả mã 500"], "required_event": "run_error"},
    {"phrases": ["test", "qua", "trượt"], "required_event": "test"},
    {"phrases": ["server đã lên", "lần tải trang"], "required_event": "server_started"},
    {"phrases": ["không thấy lỗi", "không có thông báo lỗi"], "required_event": "no_error_seen"},
    {"phrases": ["không cho thấy kết quả", "không rõ kết quả"], "required_event": "unknown_outcome"},
    {"phrases": ["hỏi ai", "yêu cầu", "gửi … cho ai", "gửi yêu cầu cho ai"], "required_event": "ai_request"},
    {"phrases": ["câu trả lời ai", "từ câu trả lời", "áp"], "required_event": "ai_insert"},
    {"phrases": ["dán"], "required_event": "paste"},
    {"phrases": ["không qua gõ phím", "không ghi nguồn", "không rõ nguồn"], "required_event": "unknown_source"},
    {"phrases": ["xóa"], "required_event": "delete"},
    {"phrases": ["không có thao tác"], "required_event": "pause"},
    {"phrases": ["trùng nguyên văn"], "required_event": "match_verbatim"},
    {"phrases": ["gần như trùng"], "required_event": "match_close"},
    {"phrases": ["khớp một phần"], "required_event": "match_partial"},
]

# F-VSCode Conversation Labels (TH7, Spec 02 Mục 7)
FVSCODE_LABELS = {
    "I": "kiến tạo (Instruction/Implementation)",
    "M": "hỗn hợp (Mixed)",
    "E": "ủy thác (Exploration/Explanation)",
    "unknown": "chưa phân loại"
}
