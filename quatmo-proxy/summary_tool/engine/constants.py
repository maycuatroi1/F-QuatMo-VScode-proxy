# -*- coding: utf-8 -*-
"""
Constants and default parameters for the PhaseSUMMARY Engine.
Grounded in 'Method summary (bản rút gọn).docx' and developer spec files 00-08.
"""
from .config import config

# Default parameters (from tệp 08 Tham số & PP Phụ lục B)
DEFAULT_PARAMS = {
    # TH1: Pauses and session estimation
    "pause.tiers_ms": [2000, 15000, 180000, 600000],  # vi mô, ngắn, vừa, dài
    "pause.session_break_ms": 300000,                  # 5 phút (Hart et al., Tabarsi et al.)
    "pause.step_ms": 120000,                           # 2 phút (Lohr et al.)
    "pause.segment_ms": 180000,                        # 3 phút (U13)
    "pause.include_views": False,

    # M2: AI segment closing
    "ai.segment_idle_close_ms": 300000,                # 5 phút (Birillo et al.)
    "ai.debug_persistence": 3,                         # >= 3 yêu cầu nhóm D liên tiếp (Ma et al.)
    "ai.fix_loop_min": 2,                              # >= 2 vòng (U14)

    # TH2 & TH3: Errors and terminal runs
    "errors.repeat_runs": 3,                           # >= 3 lần chạy lặp cùng lỗi (Arakawa et al., U4)
    "runs.no_edit_repeat": 2,                          # > 2 lần chạy lại không sửa (Tabarsi et al.)
    "runs.minor_change_lines": 2,                      # 1-2 dòng (U5)

    # TH4: Code matching with AI responses
    "match.big_paste_chars": 20,                       # >= 20 ký tự (Ghimire & Edwards)
    "match.close_ratio": 0.90,                         # r >= 0.90 (Rahe & Maalej)
    "match.close_containment": 0.90,                   # c >= 0.90 (U1)
    "match.partial_containment": 0.50,                 # 0.50 <= c < 0.90 (U2)
    "match.max_pair_product": 400000000,               # 4e8 limit for quadratic matching

    # TH5 & TH11: Provenance & AI Code Spans
    "provenance.min_span_chars": 40,                   # >= 40 ký tự theo dõi (Davalos & Zhang)
    "provenance.repaste_window_ms": 300000,            # 5 phút dán lại (U29)
    "undo.max_lookback": 50,                           # 50 records lookback for undo/redo
    "undo.restore_min_share": 0.90,                    # 90% overlap to restore provenance (U28)
    "undo.cancel_window_ms": 30000,                    # 30s cancellation window (U28)

    # TH11 & M4: Retained AI Code
    "aicode.retained_min_chars": 40,                   # còn >= 40 ký tự ở cuối buổi (U25)
    "aicode.max_items": 4,                             # tối đa 4 đoạn kể riêng (U25)
    "aicode.prompt_overlap_lines": 3,                  # >= 3 dòng liên tiếp (U26)

    # TH10: Bursts
    "burst.own_percentile": 95,                        # P95 (Davalos & Zhang)
    "burst.abs_min_chars": 100,                        # 100 ký tự (U10)
    "burst.baseline_min_events": 20,

    # TH7: Prompt taxonomy flags
    "prompt.task_containment": 0.80,                   # c >= 0.80 (U7)
    "prompt.own_code_lines": 3,                        # >= 3 dòng code hiện tại (U7)
    "prompt.context_typed_chars": 20,                  # base dung sai 20 ký tự (U6)

    # M3: Ask candidates (DH1 - DH6)
    "asks.max_items": 3,                               # tối đa 3 điều đáng hỏi + DH0 (U15)
    "asks.dh1_min_lines": 5,                           # >= 5 dòng (U14)
    "asks.priority_order": ["DH1", "DH3", "DH2", "DH4", "DH5"],  # Mục 7.3 quy tắc chung (U15)
    "asks.dh5_unrun_lines": 5,                         # >= 5 dòng sau lần chạy cuối (U14)

    # M4: Content selection (B1-B4, Đ1-Đ5)
    "select.ai_insert_lines": 5,                       # Đ1: >= 5 dòng
    "select.debug_failed_runs": 2,                     # Đ2: >= 2 lần chạy lỗi
    "select.long_pause_ms": 600000,                    # Đ5: >= 10 phút
    "select.max_timeline_items": 10,                   # tối đa 10 mục dòng thời gian (ngân sách Mục 8.2, U18)

    # M5: LLM settings (Gemma-4-26B Realizer from quatmo-proxy ModelConfig)
    "llm.enabled": config.model.enabled,
    "llm.model": config.model.model_name,
    "llm.aliases": config.model.aliases or "qwen3-coder",
    "llm.base_url": config.model.base_url,
    "llm.api_key": config.model.api_key,
    "llm.temperature": config.model.temperature,
    "llm.timeout_s": config.model.timeout_s,
    "llm.max_retries": config.model.max_retries,
    "llm.prompt_version": "2.0_rut_gon",
    "llm.input_variant": "sentences",                  # sentences | key_value

    # Classifier (TH7)
    "classifier.enabled": True,
    "classifier.kappa_min": 0.70,
    "classifier.calibration_frac": 0.10,
    "classifier.calibration_min_n": 150,

    # Baseline & Norms (M3)
    "baseline.min_class_sessions": 20,                 # tối thiểu 20 buổi để so sánh lớp
    "baseline.tail_pct": 10,                           # 10% đuôi trên/dưới

    # System & Execution Limits
    "errors.signature_mode": "default",                # default | keep_quoted | type_only
    "run.output_tail_chars": 1000,
    "link.time_tolerance_ms": 5000,
    "provenance.cancel_window_ms": 10000,              # 10s cancellation window for M0 (U28)
}

# Forbidden words for K4 check (NT2, NT5, PP 10, Tệp 07 + Anti-AI-tell)
FORBIDDEN_WORDS = [
    # Mức hiểu
    "không hiểu", "chưa hiểu", "hiểu rõ", "hiểu sai", "nắm vững", "mất gốc",
    # Sự trung thực
    "gian lận", "đạo văn", "chép bài", "quay cóp", "thiếu trung thực", "vi phạm",
    "không tự làm", "đáng ngờ", "nghi ngờ", "đáng lo",
    # Nỗ lực, năng lực
    "lười", "chăm chỉ", "cố gắng", "giỏi", "kém", "yếu kém", "học yếu",
    "thông minh", "non tay", "thành thạo",
    # Cảm xúc
    "bối rối", "bực", "căng thẳng", "lo lắng", "tự tin", "chán", "hoảng",
    # Ý định
    "cố tình", "cố ý", "muốn", "định làm", "dự định", "có ý định", "nhằm", "để đối phó",
    # Phụ thuộc
    "phụ thuộc vào ai", "lạm dụng", "dựa dẫm",
    # Quy kết nguyên nhân
    "vì sinh viên", "do sinh viên", "bởi vì em",
    # Chuẩn đầu ra
    "đạt lo", "đạt chuẩn", "đã đạt", "chưa đạt", "không đạt", "nắm được", "làm chủ",
    # Văn phong AI sáo rỗng (Anti-AI-tell clichés)
    "nhìn chung", "tóm lại", "đáng chú ý là", "có thể thấy rằng", "có thể thấy",
    "bản tóm tắt này", "dưới đây là", "hy vọng", "chúc bạn", "tổng kết lại",
    "thể hiện rõ", "chứng tỏ rằng", "đáng ghi nhận", "đáng khen ngợi", "nhanh chóng", "tích cực"
]

# K3 Event Type Mapping Rules (Tệp 07 Mục 2)
# Mỗi quy tắc: (regex_pattern, [các loại sự kiện hợp lệ trong mục nguồn])
K3_EVENT_RULES = [
    (r"\b(chạy|chạy lại)\b", ["run"]),
    (r"\b(lỗi\s+[A-Za-z_]\w*(?:Error|Exception)|\w+Error|\w+Exception)\b", ["error_run"]),
    (r"\b(test|qua|trượt)\b", ["test"]),
    (r"\b(hỏi AI|yêu cầu|gửi\b.*\bcho AI)\b", ["ai_request"]),
    (r"\b(chèn|nhận code)\b", ["ai_insert", "insertion"]),
    (r"\b(dán)\b", ["paste"]),
    (r"\b(xóa)\b", ["delete"]),
    (r"\b(ngừng|dừng)\b", ["pause"]),
    (r"\b(trùng nguyên văn)\b", ["verbatim"]),
    (r"\b(gần như trùng)\b", ["close"]),
    (r"\b(trùng một phần)\b", ["partial"]),
]

# Mapping category codes from Ma et al. (TH7)
REQUEST_CATEGORY_NAMES = {
    "CQ": "hỏi khái niệm",
    "PU": "hiểu đề",
    "ER": "xin ví dụ",
    "IQ": "hỏi cách cài đặt",
    "CG": "xin sinh code",
    "EI": "giải thích lỗi",
    "CC": "sửa code",
    "CV": "kiểm tra code",
    "CE": "giải thích code",
    "CO": "tối ưu code",
    "OT": "khác"
}
