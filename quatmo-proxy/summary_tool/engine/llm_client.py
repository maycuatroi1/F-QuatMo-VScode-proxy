# -*- coding: utf-8 -*-
"""
LLM Client module for PhaseSUMMARY Engine.
Implements M5 Natural Language Realizer with gemma-4-26b.
Enforces strict anti-AI-tell system prompt, JSON response schema, and automated feedback loops.
"""

import os
import json
import time
import ssl
import urllib.request
import urllib.error
from typing import Dict, List, Any, Optional, Tuple

SYSTEM_PROMPT_GEMMA = """Bạn là bộ sinh ngôn ngữ tự nhiên (Data-to-Text Natural Language Realizer) trong hệ thống tóm tắt tiến trình làm bài lập trình dành cho giảng viên.
Bản tóm tắt là lời KỂ LẠI QUÁ TRÌNH LÀM BÀI của sinh viên theo diễn biến thời gian (kể lại sinh viên đã gõ gì, hỏi AI gì, chèn code gì, chạy terminal mấy lần, gặp lỗi gì, sửa thế nào). Tuyệt đối KHÔNG ĐƯỢC có văn phong AI ("AI-tell"). Bạn phải viết như một biên bản kỹ thuật khoa học: khách quan, ngắn gọn, trung tính, không cảm xúc và chính xác tuyệt đối.

CÁC NGUYÊN TẮC BẮT BUỘC:
1. CẤM TUYỆT ĐỐI các câu chào hỏi, mở đầu, kết bài, tóm lược sáo rỗng hoặc câu dẫn nhập (CẤM: "Dưới đây là...", "Nhìn chung...", "Tóm lại...", "Bản tóm tắt này...", "Có thể thấy...", "Đáng chú ý là...", "Hy vọng...", "Chúc bạn...").
2. CẤM TUYỆT ĐỐI nhận xét chủ quan, phê phán, đánh giá phẩm chất, năng lực, động cơ hay tâm lý sinh viên (CẤM: "cố tình", "chăm chỉ", "lười", "thông minh", "yếu", "kém", "bối rối", "lo lắng", "tự tin", "lạm dụng", "phụ thuộc", "gian lận", "đáng ngờ").
3. CẤM TUYỆT ĐỐI chấm điểm, phê phán hay phán xét chuẩn đầu ra và testcase của đề (CẤM: "đạt LO", "chưa đạt", "đã đạt", "đúng/sai theo đề bài", "trượt testcase"). Bạn chỉ kể lại sự kiện thực tế trong terminal mà sinh viên đã tự chạy (ví dụ: "Lần chạy ở phút 58 chạy được" hoặc "Lần chạy ở phút 30 gặp lỗi IndexError").
4. CẤM TUYỆT ĐỐI suy diễn nguyên nhân chủ quan (CẤM: "do sinh viên không hiểu", "bởi vì em muốn...", "nhằm mục đích...").
5. BẢO TOÀN CON SỐ TUYỆT ĐỐI: Chỉ dùng các con số, số dòng, số phút có trong các câu nguồn được cung cấp. KHÔNG làm tròn, KHÔNG thêm bớt bất kỳ số nào. Viết số bằng chữ số (ví dụ: 1 lần, 38 dòng, phút 15).
6. Mỗi câu bạn viết PHẢI ghi rõ mã mục nguồn vào trường "item_ids". Không ghép thông tin của hai mục dòng thời gian vào một câu.
7. Giữ đúng thứ tự thời gian.
8. Ở phần Ý chính gọi người làm bài là "sinh viên". Ở phần dòng thời gian lược bỏ chủ ngữ để viết ngắn gọn theo tiến trình từng mốc thời gian.

QUY CÁCH PHẢN HỒI (STRICT JSON ONLY):
Chỉ trả về DUY NHẤT một khối JSON hợp lệ theo đúng lược đồ sau, không kèm bất kỳ giải thích nào:
{
  "key_points": [
    {"text": "Câu văn mô tả sự việc.", "item_ids": ["O01"]}
  ],
  "timeline": [
    {"item_id": "O06", "text": "Câu văn mô tả diễn biến mục O06."}
  ]
}
"""

class NoSummaryRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GemmaSummarizer:
    def __init__(self, model: str = "gemma-4-26b", base_url: Optional[str] = None, api_key: Optional[str] = None,
                 aliases: Optional[Any] = None, temperature: float = 0.0, timeout_s: Optional[int] = None):
        self.model = model or os.getenv("SUMMARY_LLM_MODEL") or os.getenv("CUSTOM_MODEL_NAME") or "gemma-4-26b"
        self.base_url = (base_url or os.getenv("SUMMARY_LLM_BASE_URL") or os.getenv("CUSTOM_BASE_URL") or os.getenv("CLASSIFIER_API_URL") or "https://quatmo-api.iahn.hanoi.vn/v1").rstrip("/")
        if self.base_url.endswith("/chat/completions"):
            self.base_url = self.base_url[:-len("/chat/completions")]
        self.api_key = api_key or os.getenv("SUMMARY_LLM_API_KEY") or os.getenv("CUSTOM_API_KEY") or os.getenv("CLASSIFIER_API_KEY") or ""
        self.temperature = temperature
        self.timeout_s = timeout_s if timeout_s is not None else int(os.getenv("SUMMARY_LLM_TIMEOUT_S") or os.getenv("LLM_TIMEOUT_S") or "75")

        alias_list = []
        env_aliases = os.getenv("SUMMARY_LLM_ALIASES")
        if env_aliases is None:
            env_aliases = os.getenv("CUSTOM_MODEL_ALIASES")
        raw_aliases = aliases if aliases is not None else env_aliases
        if raw_aliases is None:
            alias_list = ["qwen3-coder"]
        elif isinstance(raw_aliases, str):
            clean = raw_aliases.strip()
            if clean and clean.lower() not in ("none", "false", "null", "disabled", "empty"):
                alias_list = [a.strip() for a in clean.split(",") if a.strip()]
        elif isinstance(raw_aliases, list):
            alias_list = [str(a).strip() for a in raw_aliases if str(a).strip() and str(a).strip().lower() not in ("none", "false", "null", "disabled", "empty")]
        if not alias_list and (raw_aliases is None or str(raw_aliases).strip().lower() not in ("none", "false", "disabled", "empty")):
            alias_list = ["qwen3-coder"]
        self.aliases = alias_list

    def build_user_prompt(self, key_point_items: List[Dict[str, Any]], timeline_items: List[Dict[str, Any]]) -> str:
        """Constructs structured user prompt according to Spec 06."""
        kp_lines = []
        for item in key_point_items:
            s_text = item.get("text") or " ".join(item.get("sentences", []))
            kp_lines.append(f"[{item['id']}] {s_text}")

        tl_lines = []
        for item in timeline_items:
            s_text = item.get("text") or " | ".join(item.get("sentences", []))
            m_s = item.get("minute_start", 0)
            m_e = item.get("minute_end", 0)
            time_span = f"phút {m_s}" if m_s == m_e else f"phút {m_s}–{m_e}"
            tl_lines.append(f"[{item['id']}] ({time_span}) {s_text}")

        prompt = (
            "PHẦN Ý CHÍNH. Viết 3 đến 5 câu từ các câu sau:\n" +
            "\n".join(kp_lines) +
            "\n\nPHẦN DÒNG THỜI GIAN. Với mỗi mục, viết 1 đến 3 câu ngắn gọn từ các câu của mục đó:\n" +
            "\n".join(tl_lines) +
            "\n\nTrả về JSON đúng lược đồ."
        )
        return prompt

    def realize(self, key_point_items: List[Dict[str, Any]], timeline_items: List[Dict[str, Any]],
                validator_func=None, max_retries: int = 2) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Executes M5 sentence realization with gemma-4-26b (fallback to alias model e.g. qwen3-coder if needed).
        Returns (draft_json, calls_log). If LLM is unreachable or fails checks, draft_json is None.
        """
        calls_log = []
        user_prompt = self.build_user_prompt(key_point_items, timeline_items)
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT_GEMMA},
            {"role": "user", "content": user_prompt}
        ]

        endpoint = f"{self.base_url.rstrip('/')}/chat/completions"

        ctx = ssl.create_default_context()
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), NoSummaryRedirect())

        # Strict Model Realization Strategy:
        # Attempt 1: Primary Model (gemma-4-26b)
        # Attempt 2: Primary Model Retry (gemma-4-26b) - handles transient network/server delays
        # Attempt 3: Graceful Fallback (qwen3-coder) - activated ONLY when gemma-4-26b is unreachable/offline
        candidate_models = [self.model, self.model] + [a for a in self.aliases if a != self.model]

        for attempt in range(max_retries + 1):
            if attempt < len(candidate_models):
                target_model = candidate_models[attempt]
            else:
                target_model = candidate_models[-1]

            is_fallback = (target_model != self.model)
            role = "fallback" if is_fallback else ("primary_retry" if attempt > 0 else "primary")
            call_timeout = 35 if is_fallback else self.timeout_s

            t_start = time.time()
            call_record = {
                "attempt": attempt + 1,
                "model": target_model,
                "role": role,
                "endpoint": endpoint,
                "temperature": self.temperature,
                "ts": int(t_start * 1000)
            }

            payload = {
                "model": target_model,
                "messages": messages,
                "temperature": self.temperature,
                "max_tokens": 1500,
                "stream": True
            }

            try:
                req = urllib.request.Request(
                    endpoint,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {self.api_key}"
                    },
                    method="POST"
                )
                with opener.open(req, timeout=call_timeout) as response:
                    content_type = response.headers.get("Content-Type", "")
                    if "text/event-stream" in content_type:
                        chunks = []
                        for raw_line in response:
                            line = raw_line.decode("utf-8").strip()
                            if line.startswith("data: ") and line != "data: [DONE]":
                                try:
                                    d = json.loads(line[6:])
                                    delta = d.get("choices", [{}])[0].get("delta", {}).get("content", "")
                                    if delta:
                                        chunks.append(delta)
                                except Exception:
                                    pass
                        content = "".join(chunks).strip()
                    else:
                        res_body = response.read().decode("utf-8")
                        res_json = json.loads(res_body)
                        content = res_json.get("choices", [{}])[0].get("message", {}).get("content", "").strip()

                    latency_ms = int((time.time() - t_start) * 1000)
                    call_record["latency_ms"] = latency_ms
                    call_record["response_raw"] = content

                    draft = self._clean_and_parse_json(content)
                    if not draft:
                        call_record["error"] = "JSON parse failed"
                        calls_log.append(call_record)
                        continue

                    if validator_func:
                        valid, errors = validator_func(draft)
                        if not valid:
                            call_record["validation_errors"] = errors
                            calls_log.append(call_record)
                            if attempt < max_retries:
                                feedback_msg = (
                                    "Bản sinh trước chưa đạt các phép kiểm sau:\n" +
                                    "\n".join([f"- {err}" for err in errors]) +
                                    "\nHãy sửa lại các câu bị lỗi, tuyệt đối tuân thủ các quy tắc cấm văn phong AI và trả về JSON đúng lược đồ."
                                )
                                messages.append({"role": "assistant", "content": content})
                                messages.append({"role": "user", "content": feedback_msg})
                                continue
                            else:
                                break

                    call_record["status"] = "success"
                    calls_log.append(call_record)
                    return draft, calls_log

            except urllib.error.URLError as e:
                call_record["error"] = f"Network/Connection error: {str(e.reason)}"
                call_record["latency_ms"] = int((time.time() - t_start) * 1000)
                calls_log.append(call_record)
            except Exception as e:
                call_record["error"] = str(e)
                call_record["latency_ms"] = int((time.time() - t_start) * 1000)
                calls_log.append(call_record)

        return None, calls_log

    def _clean_and_parse_json(self, text: str) -> Optional[Dict[str, Any]]:
        """Extracts JSON object from text, handling markdown code blocks."""
        text = text.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines).strip()

        try:
            data = json.loads(text)
            if isinstance(data, dict) and "key_points" in data and "timeline" in data:
                return data
        except Exception:
            pass

        # Substring search for outermost { ... }
        s_idx = text.find("{")
        e_idx = text.rfind("}")
        if s_idx != -1 and e_idx != -1 and e_idx > s_idx:
            try:
                candidate = json.loads(text[s_idx:e_idx+1])
                if isinstance(candidate, dict) and ("key_points" in candidate or "timeline" in candidate):
                    return candidate
            except Exception:
                pass

        return None
