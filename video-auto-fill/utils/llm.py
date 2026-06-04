"""
LLM 调用封装 (MiniMax M2.7)
"""
import requests

from config import LLM_API_URL, LLM_API_KEY, LLM_MODEL

_session = requests.Session()
_session.proxies = {"http": None, "https": None}


def call_llm(prompt: str, temperature: float = 0.3) -> str | None:
    """调用 MiniMax 兼容 Anthropic 接口，返回纯文本"""
    payload = {
        "model": LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": 1024,
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": LLM_API_KEY,
        "anthropic-version": "2023-06-01",
    }
    try:
        resp = _session.post(LLM_API_URL, json=payload, headers=headers, timeout=30)
        result = resp.json()
        for item in result.get("content", []):
            if item.get("type") == "text":
                return item["text"].strip()
    except Exception as e:
        print(f"  ⚠️ LLM调用失败: {e}")
    return None
