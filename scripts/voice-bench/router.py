"""Local router client. Leases are scoped, renewed and always released."""
import contextlib
import http.client
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8085"


def request(path, body=None, method=None, headers=None):
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        headers = {"content-type": "application/json", **(headers or {})}
    req = urllib.request.Request(BASE+path, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=660) as response:
        return json.load(response)


def idle(owned=False):
    deadline = time.monotonic()+600
    while True:
        health = request("/health")
        speech=health["speech"]
        if speech["voiceSessions"] <= int(owned) and not speech.get("starting") and not speech.get("stopping"):
            return health["speech"]
        if time.monotonic() > deadline:
            raise TimeoutError("Speech remained busy or in a start/stop transition for 600 seconds")
        time.sleep(2)


@contextlib.contextmanager
def lease(tenants):
    before = idle()
    start = time.perf_counter()
    result = request("/v1/voice/sessions", {"client": "voice-bench", "ttlSeconds": 120,
                                           "tenants": tenants})
    sid = result["sessionId"]
    try:
        yield sid, {"acquireS": time.perf_counter()-start, "before": before}
    finally:
        request("/v1/voice/sessions/"+sid, method="DELETE")


def renew(sid):
    idle(owned=True)
    request(f"/v1/voice/sessions/{sid}/renew", {"ttlSeconds": 120})


def synth(sid, text, voice="otis"):
    for attempt in range(10):
        renew(sid)
        c = http.client.HTTPConnection("127.0.0.1", 8085, timeout=300)
        start = time.perf_counter()
        c.request("POST", "/v1/audio/speech", json.dumps({"model": "breeze-tts-2",
                  "input": text, "voice": voice, "response_format": "pcm", "stream": True}),
                  {"content-type": "application/json", "X-Voice-Session-Id": sid})
        response = c.getresponse()
        if response.status == 409:
            response.read(); c.close(); time.sleep(min(2**attempt, 10)); continue
        if response.status != 200:
            status = response.status
            response.read(); c.close()
            raise RuntimeError(f"TTS HTTP {status}")
        rate = int(response.getheader("x-sample-rate"))
        chunks, data = [], bytearray()
        try:
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                chunks.append([time.perf_counter()-start, len(chunk)])
                data.extend(chunk)
        finally:
            c.close()
        if not chunks or len(data)%2:
            raise ValueError("Empty or incomplete PCM stream")
        return bytes(data), rate, chunks
    raise TimeoutError("Breeze lock remained busy after 10 attempts")


def transcribe(sid, pcm, rate):
    renew(sid)
    start = time.perf_counter()
    result = request(f"/v1/audio/transcriptions/pcm?sample_rate={rate}&language=en", pcm,
                     headers={"content-type": "application/octet-stream", "X-Voice-Session-Id": sid})
    return {"text": result["text"], "finalizationS": time.perf_counter()-start}
