# -*- coding: utf-8 -*-
"""
LLM Client module (M5) for PhaseSUMMARY Engine.
Implements Spec 06 (Viết câu bằng LLM và ghép bản tóm tắt):
- Supports input_variant ('sentences' | 'key_value')
- Injects FORBIDDEN_WORDS into system prompt
- Records full llm_calls.jsonl audit records (including prompt_sha256, prompt_version)
- Validates each attempt via M6 check callback and feeds back structured errors on retry
"""

import os
import re
import json
import time
import hashlib
import ssl
import urllib.request
import urllib.error
from typing import Dict, List, Any, Optional, Tuple
from .constants import FORBIDDEN_WORDS


def build_system_prompt(forbidden_words: Optional[List[str]] = None) -> str:
    flist = ", ".join(f'"{w}"' for w in (forbidden_words or FORBIDDEN_WORDS))
    return f"""Bạn viết lại các câu mô tả một buổi làm bài lập trình thành văn xuôi tiếng Việt ngắn gọn cho giảng viên.
Quy tắc bắt buộc:
1. Chỉ dùng thông tin có trong các câu được cho. Không thêm sự việc, lý do, ý định, cảm xúc, hay nhận xét về chất lượng code hoặc về sinh viên.
2. Giữ nguyên mọi con số và mốc phút. Viết số bằng chữ số.
3. Không dùng các từ: {flist}.
4. Mỗi câu bạn viết phải ghi mã mục nguồn trong trường "item_ids". Không ghép thông tin của hai mục dòng thời gian vào một câu.
5. Giữ thứ tự thời gian.
6. Gọi người làm bài là "sinh viên" ở phần ý chính; ở dòng thời gian có thể lược chủ ngữ.
7. Giữ nguyên tên test trong ngoặc kép. Câu nói về kết quả chạy hay kết quả test chỉ kể lần chạy (ví dụ "lần chạy test ở phút 40 có 2/3 test qua"), không viết sinh viên đạt hay chưa đạt, và không viết code đúng hay sai theo đề.
8. Tuyệt đối không dùng câu mở đầu, kết bài hay chuyển ý sáo rỗng ("Dưới đây là...", "Nhìn chung...", "Tóm lại...").
9. Giữ nguyên các cụm nói nguồn của lần thêm code và mức khớp với câu trả lời AI: "từ ngoài IDE", "từ khung chat AI", "từ chính các file của bài", "không qua gõ phím", "trùng nguyên văn", "gần như trùng", "khớp một phần". Không viết "gần như trùng" thành "trùng".

Chỉ trả về DUY NHẤT một khối JSON hợp lệ theo lược đồ:
{{
  "key_points": [{{"text": "…", "item_ids": ["O01"]}}],
  "timeline":   [{{"item_id": "O06", "text": "…"}}]
}}"""


class NoSummaryRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GemmaSummarizer:
    def __init__(
        self,
        model: str = "gemma-4-26b",
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        temperature: float = 0.0,
        timeout_s: int = 15,
        prompt_version: str = "",
        input_variant: str = "sentences",
        session_id: str = "",
        max_tokens: int = 4096,
        network_retries: int = 1,
    ):
        self.model = model or os.getenv("LLM_MODEL", "gemma-4-26b")
        self.base_url = (base_url or os.getenv("LLM_BASE_URL", "http://localhost:11434/v1")).rstrip("/")
        self.api_key = api_key or os.getenv("CUSTOM_API_KEY") or os.getenv("LLM_API_KEY") or ""
        if not self.api_key:
            raise RuntimeError("Thiếu API key cho LLM: đặt CUSTOM_API_KEY trong summary_tool/.env, hoặc chạy với LLM_ENABLED=false.")
        self.temperature = temperature
        self.timeout_s = timeout_s
        self.max_tokens = max_tokens
        self.network_retries = network_retries
        self.prompt_version = prompt_version
        self.input_variant = input_variant
        self.session_id = session_id

    def build_user_prompt(
        self,
        key_point_items: List[Dict[str, Any]],
        timeline_items: List[Dict[str, Any]],
    ) -> str:
        """Constructs structured user prompt according to Spec 06 Section 2 & 4."""
        kp_lines = []
        for item in key_point_items:
            if self.input_variant == "key_value" and item.get("kv_text"):
                kp_lines.append(f"[{item['id']}] {item['kv_text']}")
            else:
                sents = item.get("sentences") or [item.get("text", "")]
                kp_lines.append(f"[{item['id']}] {' | '.join(sents)}")

        tl_lines = []
        for item in timeline_items:
            m_s = item.get("minute_start", 0)
            m_e = item.get("minute_end", m_s)
            m_range = f"(phút {m_s})" if m_s == m_e else f"(phút {m_s}–{m_e})"
            if self.input_variant == "key_value" and item.get("kv_text"):
                tl_lines.append(f"[{item['id']}] {m_range} {item['kv_text']}")
            else:
                sents = item.get("sentences") or [item.get("text", "")]
                tl_lines.append(f"[{item['id']}] {m_range} {' | '.join(sents)}")

        prompt = (
            "PHẦN Ý CHÍNH. Viết 3 đến 5 câu từ các câu sau:\n"
            + "\n".join(kp_lines)
            + "\n\nPHẦN DÒNG THỜI GIAN. Với mỗi mục, viết 1 đến 3 câu từ các câu của mục đó:\n"
            + "\n".join(tl_lines)
            + "\n\nTrả về JSON đúng lược đồ."
        )
        return prompt

    def realize(
        self,
        key_point_items: List[Dict[str, Any]],
        timeline_items: List[Dict[str, Any]],
        validator_func=None,
        max_retries: int = 2,
    ) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Executes M5 sentence realization with retry loop on M6 validation errors.
        Returns (draft_json, calls_log).
        """
        calls_log = []
        sys_prompt = build_system_prompt()
        sys_prompt_sha256 = hashlib.sha256(sys_prompt.encode("utf-8")).hexdigest()
        user_prompt = self.build_user_prompt(key_point_items, timeline_items)
        messages = [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_prompt},
        ]

        if self.base_url.endswith("/chat/completions"):
            endpoint = self.base_url
        else:
            endpoint = f"{self.base_url.rstrip('/')}/chat/completions"

        ctx = ssl.create_default_context()  # kiểm chứng chỉ của server (chứng chỉ endpoint nhóm hợp lệ)

        # max_retries: số lần sinh lại khi K1–K5 báo lỗi. Lỗi mạng hay hết giờ chờ thì gọi lại cùng tin nhắn,
        # tối đa network_retries lần, không tính là một lần sinh lại.
        net_left = self.network_retries
        attempt = -1
        while attempt < max_retries:
            attempt += 1
            t_start = time.time()
            full_prompt_str = json.dumps(messages, ensure_ascii=False)
            prompt_sha256 = hashlib.sha256(full_prompt_str.encode("utf-8")).hexdigest()

            call_record = {
                "variant": "system",
                "session_id": self.session_id,
                "attempt": attempt + 1,
                "model": self.model,
                "model_returned": None,
                "prompt_version": self.prompt_version,
                "input_variant": self.input_variant,
                "temperature": self.temperature,
                "max_tokens": self.max_tokens,
                "system_prompt_sha256": sys_prompt_sha256,
                "prompt_sha256": prompt_sha256,
                "prompt": messages[-1]["content"],
                "response": None,
                "latency_ms": 0,
                "ts": int(t_start * 1000),
            }

            payload = {
                "model": self.model,
                "messages": messages,
                "temperature": self.temperature,
                "max_tokens": self.max_tokens,
            }

            try:
                req = urllib.request.Request(
                    endpoint,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {self.api_key}",
                    },
                    method="POST",
                )
                opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), NoSummaryRedirect())
                with opener.open(req, timeout=self.timeout_s) as response:
                    res_body = response.read().decode("utf-8")
                    call_record["latency_ms"] = int((time.time() - t_start) * 1000)

                    res_json = json.loads(res_body)
                    choice = (res_json.get("choices") or [{}])[0]
                    content = (choice.get("message", {}).get("content") or "").strip()
                    call_record["response"] = content
                    call_record["model_returned"] = res_json.get("model")
                    call_record["finish_reason"] = choice.get("finish_reason")
                    call_record["usage"] = res_json.get("usage")

                    draft = self._clean_and_parse_json(content)
                    if not draft:
                        call_record["error"] = "JSON parse failed"
                        calls_log.append(call_record)
                        # Gửi lại cùng tin nhắn ở nhiệt độ 0 sẽ ra đúng câu trả lời cũ: báo lỗi để mô hình sửa
                        messages.append({"role": "assistant", "content": content})
                        messages.append({"role": "user", "content": (
                            "Câu trả lời trước không phải JSON hợp lệ. Trả về DUY NHẤT một khối JSON đúng lược đồ, "
                            "trong chuỗi viết dấu \\ thành \\\\ và dấu \" thành \\\"."
                        )})
                        continue

                    if validator_func:
                        valid, errors = validator_func(draft)
                        if not valid:
                            call_record["validation_errors"] = errors
                            calls_log.append(call_record)
                            if attempt < max_retries:
                                err_lines = []
                                for err in errors:
                                    if isinstance(err, dict):
                                        err_lines.append(
                                            f"{err.get('check', 'ERR')} [{err.get('item_id', '')}]: {err.get('detail', '')} — \"{err.get('sentence', '')}\""
                                        )
                                    else:
                                        err_lines.append(str(err))
                                feedback_msg = (
                                    "Bản sinh trước có lỗi kiểm tự động:\n"
                                    + "\n".join(err_lines)
                                    + "\nHãy sửa lại các câu lỗi và trả về JSON đúng lược đồ."
                                )
                                messages.append({"role": "assistant", "content": content})
                                messages.append({"role": "user", "content": feedback_msg})
                                continue
                            else:
                                break

                    call_record["status"] = "success"
                    calls_log.append(call_record)
                    return draft, calls_log

            except (urllib.error.URLError, TimeoutError, OSError) as e:
                call_record["error"] = f"Network/Connection error: {getattr(e, 'reason', e)}"
                call_record["latency_ms"] = int((time.time() - t_start) * 1000)
                calls_log.append(call_record)
                if net_left > 0:
                    net_left -= 1
                    attempt -= 1  # gọi lại cùng tin nhắn, không tính là sinh lại
                    continue
                break
            except Exception as e:
                call_record["error"] = str(e)
                call_record["latency_ms"] = int((time.time() - t_start) * 1000)
                calls_log.append(call_record)

        return None, calls_log

    def _clean_and_parse_json(self, text: str) -> Optional[Dict[str, Any]]:
        text = text.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines).strip()

        def _loads(t: str):
            try:
                return json.loads(t)
            except json.JSONDecodeError:
                # Đường dẫn Windows trong thông báo lỗi (`ADMIN-PC\Admin`) hay bị chép thành escape sai: nhân đôi
                # dấu \ không mở một escape hợp lệ rồi đọc lại; chữ trong câu không đổi
                return json.loads(re.sub(r"\\(.)", lambda m: m.group(0) if m.group(1) in '"\\/bfnrtu' else "\\\\" + m.group(1), t, flags=re.S))

        try:
            data = _loads(text)
            if isinstance(data, dict) and "key_points" in data and "timeline" in data:
                return data
        except Exception:
            pass

        s_idx = text.find("{")
        e_idx = text.rfind("}")
        if s_idx != -1 and e_idx != -1 and e_idx > s_idx:
            try:
                candidate = _loads(text[s_idx : e_idx + 1])
                if isinstance(candidate, dict) and ("key_points" in candidate or "timeline" in candidate):
                    return candidate
            except Exception:
                pass

        return None
