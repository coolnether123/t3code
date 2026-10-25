"""Private, immutable input corpus. Generated pauses have exact sample labels."""
import hashlib
import contextlib
import copy
import json
import shutil
import wave
from pathlib import Path
import numpy as np
from audio_metrics import activity
from router import lease, synth, transcribe

CASES = [
    ("pause-0600", ["Check the agenda and", "tell me what is next."], [.6], False),
    ("pause-1200", ["I was thinking, um", "we should check the tests."], [1.2], False),
    ("pause-2000", ["Check the build, uh", "actually check the tests first."], [2.0], False),
    ("pause-3000", ["I need the build", "no, I mean the test results."], [3.0], False),
    ("yield-speak", ["What finished? You can speak."], [], True),
    ("yield-answer", ["What failed? Answer."], [], True),
    ("yield-floor", ["What is next? You have the floor."], [], True),
    ("yield-ahead", ["Is it ready? Go ahead."], [], True),
    ("confirmation", ["Yes, right."], [], False),
    ("two-parts", ["What passed?", "And what still needs fixing?"], [2.4], False),
    ("restart", ["Can you, can you", "check the agenda and then the tests?"], [1.5], False),
]


def save_wav(path, pcm, rate):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm)


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2
        return w.readframes(w.getnframes()), w.getframerate()


def refresh_transcripts(root, manifest):
    result=copy.deepcopy(manifest)
    with lease(["whisper-large-v3-turbo"]) as (sid,cold):
        for f in result["fixtures"]:
            pcm=(root/f["file"]).read_bytes()
            f["whisper"]=transcribe(sid,pcm,f["sampleRate"])
            if f["synthetic"]:
                for s in f["segments"]:
                    lo,hi=round(s["startS"]*f["sampleRate"])*2,round(s["endS"]*f["sampleRate"])*2
                    s["whisper"]=transcribe(sid,pcm[lo:hi],f["sampleRate"])
            else:
                f["segments"]=[{"startS":0,"endS":len(pcm)/2/f["sampleRate"],"whisper":f["whisper"]}]
    result["sttLease"]=cold
    result.pop("transcriptStatus",None)
    return result


def build(root, live_calls, voice, offline=False):
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        for f in manifest["fixtures"]:
            if hashlib.sha256((root/f["file"]).read_bytes()).hexdigest() != f["sha256"]:
                raise ValueError("Fixture hash mismatch: "+f["id"])
        return manifest
    fixtures = []
    for index, source in enumerate(sorted(Path(live_calls).rglob("*.pcm"))):
        meta = json.loads(source.with_suffix(".upload.json").read_text())
        target = root/f"saved-{index}.pcm"
        shutil.copyfile(source, target)
        pcm, rate = target.read_bytes(), meta["sampleRate"]
        spans = activity(pcm, rate)
        fixtures.append({"id": f"saved-{index}", "file": target.name, "sampleRate": rate,
                         "synthetic": False, "source": str(source), "spans": spans,
                         "trueEndS": None, "withinTurnPauses": [],
                         "annotation": "Human intent unknown. RMS spans are estimates, excluded from ground-truth scoring."})
    if len(fixtures) != 5:
        raise ValueError(f"Expected exactly 5 saved PCM utterances, got {len(fixtures)}")
    cached=all((root/(hashlib.sha256((voice+text).encode()).hexdigest()+".wav")).exists()
               for _,texts,_,_ in CASES for text in texts)
    if offline and not cached:
        raise FileNotFoundError("Offline corpus preparation requires every synthetic WAV already cached")
    with (contextlib.nullcontext((None,{})) if cached else lease(["breeze-tts-2"])) as (sid, _):
        for name, texts, pauses, yielded in CASES:
            data, segments, clock, rate = bytearray(), [], 0., 24000
            for i, text in enumerate(texts):
                cache = root/(hashlib.sha256((voice+text).encode()).hexdigest()+".wav")
                if cache.exists():
                    pcm, rate = read_wav(cache)
                else:
                    pcm, rate, _ = synth(sid, text, voice)
                    save_wav(cache, pcm, rate)
                # Retain 20 ms around the -50 dB signal boundaries. The labels
                # describe this constructed waveform, not a human's intention.
                x = np.frombuffer(pcm, dtype="<i2")
                active = np.flatnonzero(abs(x.astype(float)) > 104)
                if not len(active):
                    raise ValueError("Synthetic voice returned silence")
                pcm = pcm[max(0, active[0]-round(rate*.02))*2:min(len(x), active[-1]+round(rate*.02))*2]
                end = clock + len(pcm)/2/rate
                segments.append({"startS": clock, "endS": end, "expectedText": text})
                data.extend(pcm)
                if i < len(pauses):
                    data.extend(bytes(round(pauses[i]*rate)*2))
                    clock = end + round(pauses[i]*rate)/rate
            target = root/(name+".pcm")
            target.write_bytes(data)
            fixtures.append({"id": name, "file": target.name, "sampleRate": rate,
                             "synthetic": True, "voice": voice, "segments": segments,
                             "trueEndS": segments[-1]["endS"], "explicitYield": yielded,
                             "spans": [[s["startS"], s["endS"]] for s in segments],
                             "withinTurnPauses": [[a["endS"], b["startS"]] for a,b in zip(segments,segments[1:])],
                             "annotation": "Exact constructed segment boundaries including 20 ms trim padding; synthetic speech."})
    for f in fixtures:
        f["sha256"] = hashlib.sha256((root/f["file"]).read_bytes()).hexdigest()
    pending = {"schemaVersion": 1, "syntheticVoice": voice, "fixtures": fixtures,
               "transcriptStatus": "pending Whisper; expectedText is oracle text, not recognition"}
    (root/"manifest.pending.json").write_text(json.dumps(pending,indent=2),encoding="utf-8")
    if offline:
        return pending
    manifest=refresh_transcripts(root,pending)
    manifest_path.write_text(json.dumps(manifest, indent=2),encoding="utf-8")
    return manifest
