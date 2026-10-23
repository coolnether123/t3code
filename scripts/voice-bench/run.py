"""One-command private full voice bench. See README.md for measurement limits."""
import argparse
import datetime
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import wave
from zoneinfo import ZoneInfo
from audio_metrics import onset, schedule, summary
from fixtures import build, read_wav, save_wav, refresh_transcripts
from router import lease, synth

REPLIES = [
    ["The build passed.", "Two tests still need fixing.", "I would check those before merging."],
    ["The worker finished and pushed its branch.", "The next step is to review the results."],
]
ROOT = Path(__file__).resolve().parents[2]


def word_error(expected, actual):
    a, b = re.findall(r"\w+",expected.lower()), re.findall(r"\w+",actual.lower())
    costs = list(range(len(b)+1))
    for i, word in enumerate(a,1):
        current=[i]
        for j, other in enumerate(b,1):
            current.append(min(current[-1]+1,costs[j]+1,costs[j-1]+(word!=other)))
        costs=current
    return {"referenceWords":len(a),"edits":costs[-1],"wer":costs[-1]/max(1,len(a))}


def command(args, cwd=ROOT, **kwargs):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True, **kwargs).stdout.strip()


def model_proxy(out, executable, runs):
    rows = []
    for run in range(runs):
        prompt = "Answer both parts briefly. Fixed test facts: the build passed; two tests failed. What passed, and what needs fixing?"
        args = [executable, "-p", prompt, "--model", "claude-haiku-5-5", "--effort", "medium",
                "--tools", "", "--no-session-persistence", "--output-format", "stream-json",
                "--verbose", "--include-partial-messages", "--permission-mode", "dontAsk"]
        env = os.environ.copy(); env.pop("CLAUDECODE", None)
        start, text, first, speakable = time.perf_counter(), "", None, None
        # No private utterance is sent to the model. This fixed prompt is public.
        with subprocess.Popen(args, cwd=out, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace",
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as p:
            deadline = threading.Timer(180, p.kill)
            deadline.start()
            try:
                for line in p.stdout:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    delta = event.get("event", {}).get("delta", {})
                    if delta.get("type") == "text_delta":
                        text += delta["text"]
                        first = first if first is not None else time.perf_counter()-start
                        if speakable is None and re.search(r"[.!?](?:\s|$)", text):
                            speakable = time.perf_counter()-start
                code = p.wait(timeout=10)
            finally:
                deadline.cancel()
        (out/f"model-{run}.txt").write_text(text,encoding="utf-8")
        rows.append({"run":run, "scope":"Direct CLI provider proxy, not T3 voice path",
                     "condition":"first process, cache unknown" if run==0 else "repeat process, cache unknown",
                     "firstTextS":first, "firstSpeakableS":speakable, "totalS":time.perf_counter()-start,
                     "exitCode":code, "answeredBothParts": bool(re.search("pass",text,re.I) and re.search("two|2",text,re.I) and re.search("test",text,re.I)),
                     "cold":None})
        if code or speakable is None:
            rows[-1]["failure"]="Provider did not return a speakable sentence"
    return rows


def tts(out, runs):
    rows = []
    with lease(["breeze-tts-2"]) as (sid, condition):
        for run in range(runs):
            for ri, sentences in enumerate(REPLIES):
                for mode in ["serial", "whole"]:
                    previous_tail = 0.
                    for si, text in enumerate(sentences if mode=="serial" else [" ".join(sentences)]):
                        pcm, rate, chunks = synth(sid, text)
                        name = f"tts-{run}-{ri}-{mode}-{si}.wav"
                        save_wav(out/name, pcm, rate)
                        audio_s = len(pcm)/2/rate
                        acoustic = onset(pcm,rate)
                        metrics = schedule(chunks,rate,audible_offset=acoustic.get("leadingSilenceMs",0)/1000)
                        rows.append({"run":run,"reply":ri,"mode":mode,"sentence":si,
                            "file":name,"ttfbS":chunks[0][0],"rtf":chunks[-1][0]/audio_s,
                            "audioS":audio_s,"chunks":chunks,"sampleRate":rate,
                            "interSentenceSilenceS": previous_tail+metrics["firstAudibleS"] if mode=="serial" and si>0 else None,
                            "condition":"warm tenant, first observed request" if not rows else "warm tenant",
                            **metrics,**acoustic})
                        previous_tail=acoustic.get("trailingSilenceMs",0)/1000
                        (out/"tts-clips.json").write_text(json.dumps(rows,indent=2),encoding="utf-8")
        for repeat in range(3):
            pcm, rate, chunks = synth(sid, REPLIES[1][0])
            name = f"repeat-{repeat}.wav"; save_wav(out/name,pcm,rate)
            rows.append({"mode":"repeat","run":repeat,"file":name,"audioS":len(pcm)/2/rate,
                         "ttfbS":chunks[0][0],**onset(pcm,rate)})
    return {"lease":condition,"clips":rows,
            "repeatVariation":{k:summary([r.get(k) for r in rows if r["mode"]=="repeat"])
                               for k in ["audioS","onsetLevelVsSteadyDb","onsetCentroidHz","onsetArtifactScore"]}}


def historical(path):
    rows = []
    for file in sorted((path/"audio").glob("*.wav")):
        pcm, rate = read_wav(file)
        rows.append({"file":str(file),"sha256":hashlib.sha256(file.read_bytes()).hexdigest(),**onset(pcm,rate)})
    return rows


def recorded_tts(path):
    records=json.loads(path.read_text(encoding="utf-8"))
    rows=[]
    for rec in records:
        mode={"sentence":"serial"}.get(rec["mode"],rec["mode"])
        for i, clip in enumerate(rec.get("clips",[rec])):
            row={**clip,"mode":mode,"run":rec.get("run",rec.get("k")),"reply":rec.get("reply"),
                 "provenance":"Prior recorded parent baseline; not a fresh request"}
            if mode=="serial":
                row["interSentenceSilenceS"]=clip["silenceBeforeClipS"] if i else None
                row["interSentenceSilenceScope"]="Scheduled network gap lower bound; excludes acoustic tail and onset"
                name=f"r{rec['reply']}-sentence{i}.wav"
            elif mode=="whole":
                name=f"r{rec['reply']}-whole.wav"
            else:
                name=f"repeat{rec['k']}.wav"
            audio=path.parent/"audio"/name
            if audio.exists() and (rec.get("run",0)==0):
                pcm,rate=read_wav(audio)
                row.update(onset(pcm,rate))
                row["onsetFile"]=str(audio)
            rows.append(row)
    repeats=[r for r in rows if r["mode"]=="repeat"]
    return {"source":str(path),"sourceSha256":hashlib.sha256(path.read_bytes()).hexdigest(),
            "scope":"Recorded parent baseline on ad6af572, 2026-10-22 04:10-04:20 CDT. Fresh live requests failed separately.",
            "clips":rows,"repeatVariation":{k:summary([r.get(k) for r in repeats]) for k in ["audioS","onsetLevelVsSteadyDb","onsetCentroidHz","onsetArtifactScore"]}}


def report(data, target):
    lines = ["# Full voice baseline", "", f"Observed {data['observedAt']}. Source `{data['revision']}`.",
             "", f"Run status: {data.get('status','in progress')}. Missing metrics are unknown, never passes.",
             "", "## Measurement boundaries", "",
             "Turn replay imports shipped source. PC uses known audio spans with no live partial transcript. Device uses the actual recognition timer with Whisper segment finals arriving at the segment boundary when STT is available. Oracle fallback uses the expected synthetic text and is explicitly labeled in each row. Phone recognition arrival lag is unknown and excluded.",
             "Saved human PCM is preserved; transcription is included only when Whisper succeeds. Human intent labels remain unknown. Its RMS boundaries are estimates and excluded from false-cutoff scoring. Synthetic boundaries are exact for the constructed waveform, including 20 ms trim padding.",
             "Response latency is a composed PC/server-STT proxy using independent offline PC detection, whole-utterance Whisper finalization when available, direct provider CLI first sentence, router TTS first byte and the browser's 20 ms lead. It excludes T3 transport, storage, call.played acknowledgment, filler blocking and sound-card latency. Device recognition arrival lag is unknown, so this sum does not describe the phone recognition path. It is not an observed end-to-end call. An unavailable component keeps the total unknown.",
             "The provider proxy includes a new CLI process and its initialization. It cannot isolate model inference time or establish actual T3 voice latency.",
             "Cold and warm: no service is restarted for this bench. Tenant state before lease acquisition and acquisition time are recorded. First observed requests are not claimed cold. Provider cache state is unknown; true cold comparison remains unmeasured.",
             "Interruption uses the real session with fake audio IO. Abort-to-silence measures JavaScript cancellation dispatch, not audible hardware silence. The ad6af572 baseline has no automatic barge-in. This test covers only explicit interruption, including on later candidates.",
             "", "## Results", "", "Metric | n | median | p95", "--- | ---: | ---: | ---:"]
    for name, stat in data.get("summary",{}).items():
        fmt = lambda v: "unknown" if v is None else f"{v:.3f}"
        lines.append(f"{name} | {stat['n']} | {fmt(stat['median'])} | {fmt(stat['p95'])}")
    lines += ["", "## Turn opportunities", "", "Mode | within-turn pauses | false cutoffs", "--- | ---: | ---:"]
    for mode in ["pc","device"]:
        rs=[r for r in data.get("replay",[]) if r.get("kind")=="turn" and r["mode"]==mode and r["withinTurn"]]
        lines.append(f"{mode} | {len(rs)} | {sum(r['falseCutoff'] for r in rs)}")
    lines += ["", "Fixture | mode | pause index | false cutoff", "--- | --- | ---: | ---"]
    for row in data.get("replay",[]):
        if row.get("kind")=="turn" and row["withinTurn"]:
            lines.append(f"{row['fixture']} | {row['mode']} | {row['pauseIndex']} | {row['falseCutoff']}")
    proxy=data.get("composedLatencyProxy",{})
    lines += ["", "## Response component proxy", "", "Component | seconds", "--- | ---:"]
    for name,value in proxy.get("components",{}).items():
        lines.append(f"{name} | {'unknown' if value is None else f'{value:.3f}'}")
    total=proxy.get("sumOfComponentMediansS")
    lines.append(f"Sum of component medians | {'unknown' if total is None else f'{total:.3f}'}")
    lines += ["", "No E2E median or p95 is claimed from these independent samples."]
    oracle=sum(r.get("transcriptSource","").startswith("oracle") for r in data.get("replay",[]))
    if oracle:
        lines += ["",f"Oracle transcript fallback: {oracle} device replay opportunities used expected text because Whisper was unavailable. These results isolate policy behavior and do not prove STT integration."]
    if data.get("tts",{}).get("source"):
        lines += ["",data["tts"]["scope"],"Inherited sentence silence is the parent's scheduled network-gap lower bound. It excludes acoustic onset/tail and call acknowledgment. Fresh runs measure acoustic silence as well."]
    if data.get("reusedModelSource"):
        lines += ["",f"Provider observations reused from {data['reusedModelSource']}; no new provider request in this offline report."]
    repeats=[r["audioS"] for r in data.get("tts",{}).get("clips",[]) if r["mode"]=="repeat"]
    if repeats:
        lines += ["",f"Repeat-request duration range: {min(repeats):.3f}-{max(repeats):.3f} s, n={len(repeats)}. Identical text, separately sampled requests."]
    if data.get("priorLiveFailures"):
        lines += ["", "Prior live failures retained:"]+[f"- {f}" for f in data["priorLiveFailures"]]
    acquisition=data.get("fixtures",{}).get("sttLease")
    if acquisition:
        was_running=any(t["id"]=="whisper-large-v3-turbo" and t["running"] for t in acquisition["before"]["tenants"])
        lines += ["",f"Whisper lease acquisition: {acquisition['acquireS']:.3f} s, n=1. Tenant running before acquisition: {was_running}."]
    tts_acquisition=data.get("tts",{}).get("lease")
    if tts_acquisition:
        was_running=any(t["id"]=="breeze-tts-2" and t["running"] for t in tts_acquisition["before"]["tenants"])
        lines += ["",f"Breeze lease acquisition: {tts_acquisition['acquireS']:.3f} s, n=1. Tenant running before acquisition: {was_running}.",
                  "Lease acquisition includes router admission, tenant transitions and health readiness. It is separate from request timing after readiness, and is not isolated model-load time. One startup sample does not establish a cold-start distribution."]
    models=data.get("model",[])
    lines += ["",f"Provider fixed two-part fact check: {sum(r['answeredBothParts'] for r in models)}/{len(models)}. This is a narrow content check, not conversational understanding acceptance."]
    lines += ["", "## Onset screening", "",
              "Score 0-100 combines onset energy deficit beyond 6 dB, spectral centroid loss beyond half an octave, sample discontinuity above 0.2 full scale, and clipping. Windows are 150 ms after the first frame above -40 dB. Body comparison uses voiced windows after 300 ms. Higher means more suspicious. Phonemes, stress and breath can change it, so it is not a perceptual grade.",
              f"Checked {len(data.get('historicalOnsets',[]))} saved baseline WAVs objectively. No listening validation was performed. Sorted scores and raw components are in JSON; confirm high scores by listening before attributing a codec fault.",
              "", "## Failures and remaining gates", ""]
    lines += [f"- {f}" for f in data["failures"]] or ["No command failures."]
    lines += ["", "Real client/provider integration, hardware interruption tail, human naturalness and understanding acceptance, and genuinely cold service runs remain separate gates.",
              "", "## Practical targets", "",
              "Keep all deliberately inserted thinking pauses through 3 seconds without taking the turn. Aim for explicit yields within 400 ms while keeping both parts of a question. Require zero stale chunks after explicit interrupt; measure real device silence before setting a hardware target. Reduce serial sentence gaps toward 100 ms and scheduler underruns to zero without adding more than 50 ms playback lead. Preserve transcript content and have Jared compare naturalness and onset quality on the same fixed inputs. Use the measured component table to prioritize latency work; do not trade understanding for a lower total."]
    target.write_text("\n".join(lines)+"\n",encoding="utf-8")


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--artifacts",type=Path,required=True)
    parser.add_argument("--live-calls",type=Path,default=Path("D:/MovedAppData/T3CodeServer/userdata/voice/calls"))
    parser.add_argument("--voice",default="elora-calm-design")
    parser.add_argument("--fixtures",type=Path,help="Reuse the baseline corpus while writing candidate reports elsewhere")
    parser.add_argument("--recorded-tts",type=Path,help="Explicitly reuse the parent's recorded baseline TTS JSON, never for candidate comparisons")
    parser.add_argument("--recorded-model",type=Path,help="Explicitly reuse a prior run's provider rows in an offline combined report")
    parser.add_argument("--runs",type=int,default=3)
    parser.add_argument("--policy",help="Absolute module exporting shouldEndTurn and optional replayDevice")
    parser.add_argument("--offline",action="store_true",help="Reuse fixtures; skip live TTS/model requests")
    parser.add_argument("--prepare-fixtures",action="store_true",help="Prepare the private corpus independently of JavaScript dependencies")
    parser.add_argument("--allow-oracle",action="store_true",help="Allow explicitly labeled offline replay from a pending manifest when STT failed")
    args=parser.parse_args()
    if args.runs<1:
        parser.error("--runs must be at least 1")
    out=args.artifacts.resolve(); out.mkdir(parents=True,exist_ok=True)
    if out.is_relative_to(ROOT):
        raise ValueError("Private artifacts must be outside the repository")
    corpus=(args.fixtures or out/"fixtures").resolve()
    existing_manifest=(corpus/"manifest.json").exists()
    if corpus.is_relative_to(ROOT):
        raise ValueError("Private fixtures must be outside the repository")
    source_files=["apps/web/src/voice/turnEnding.ts","apps/web/src/voice/deviceSpeech.ts","apps/web/src/voice/browserSpeech.ts","packages/client-runtime/src/voice-call/session.ts"]
    data={"revision":command(["git","rev-parse","HEAD"]),"observedAt":datetime.datetime.now(ZoneInfo("America/Chicago")).isoformat(),"failures":[],"summary":{},"status":"in progress",
          "runtime":{"python":sys.version,"numpy":version("numpy"),"node":command(["node","--version"])},
          "sourceHashes":{p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in source_files}}
    def stage(name, fn):
        started=time.perf_counter()
        try:
            data[name]=fn(); print(name+": complete",flush=True)
        except Exception as e:
            data["failures"].append(name+": "+type(e).__name__+": "+str(e))
            print(name+": failed",flush=True)
        finally:
            data.setdefault("stageDurationS",{})[name]=time.perf_counter()-started
            (out/"results.json").write_text(json.dumps(data,indent=2,allow_nan=False),encoding="utf-8")
            report(data,out/"BASELINE-FULL.md")
    def prepare():
        if args.offline and args.allow_oracle and not (corpus/"manifest.json").exists():
            pending_path=corpus/"manifest.pending.json"
            if not pending_path.exists():
                return build(corpus,args.live_calls,args.voice,offline=True)
            pending=json.loads(pending_path.read_text(encoding="utf-8"))
            for f in pending["fixtures"]:
                if hashlib.sha256((corpus/f["file"]).read_bytes()).hexdigest()!=f["sha256"]:
                    raise ValueError("Pending corpus hash mismatch")
            return pending
        if args.offline and not (corpus/"manifest.json").exists():
            raise FileNotFoundError("Offline replay requires a prepared fixture manifest")
        prepared=build(corpus,args.live_calls,args.voice)
        if existing_manifest and not args.offline and not args.prepare_fixtures:
            prepared=refresh_transcripts(corpus,prepared)
        return prepared
    stage("fixtures",prepare)
    for f in data.get("fixtures",{}).get("fixtures",[]):
        if f["synthetic"] and f.get("whisper"):
            f["transcriptAccuracy"]=word_error(" ".join(s["expectedText"] for s in f["segments"]),f["whisper"]["text"])
    if data.get("fixtures"):
        (out/"run-manifest.json").write_text(json.dumps(data["fixtures"],indent=2),encoding="utf-8")
    if args.prepare_fixtures:
        return int(bool(data["failures"]))
    def replay():
        manifest_path=out/"run-manifest.json" if data.get("fixtures") else corpus/"manifest.json"
        if args.allow_oracle and not manifest_path.exists():
            manifest_path=corpus/"manifest.pending.json"
        env={**os.environ,"VOICE_BENCH_MANIFEST":str(manifest_path),"VOICE_BENCH_OUTPUT":str(out/"replay.json")}
        if args.policy: env["VOICE_BENCH_POLICY"]=args.policy
        vp=ROOT/"node_modules"/".bin"/("vp.cmd" if os.name=="nt" else "vp")
        if not vp.is_file(): raise RuntimeError("Install the locked project dependencies before replaying fixtures")
        result=subprocess.run([vp,"test","run","apps/web/src/voice/replay.test.ts","--reporter=dot"],cwd=ROOT,env=env,capture_output=True,text=True,encoding="utf-8",errors="replace")
        (out/"replay.log").write_text(result.stdout+result.stderr,encoding="utf-8")
        if result.returncode: raise RuntimeError(f"Replay exit {result.returncode}, see replay.log")
        return json.loads((out/"replay.json").read_text())
    stage("replay",replay)
    stage("historicalOnsets",lambda:historical(out.parent/"baseline"))
    if args.recorded_tts:
        stage("tts",lambda:recorded_tts(args.recorded_tts))
    if args.recorded_model:
        previous=json.loads(args.recorded_model.read_text(encoding="utf-8"))
        data["model"]=previous.get("model",[])
        data["reusedModelSource"]=str(args.recorded_model)
        data["priorLiveFailures"]=previous.get("failures",[])
    if not args.offline:
        if not args.recorded_tts:
            stage("tts",lambda:tts(out,args.runs))
        stage("model",lambda:model_proxy(out,shutil.which("claude"),args.runs))
        for row in data.get("model",[]):
            if row.get("failure") or not row["answeredBothParts"]:
                data["failures"].append(f"Model sample {row['run']}: {row.get('failure','two-part fact check failed')}")
    for mode in ["pc","device"]:
        for yield_only in [False,True]:
            values=[r["delayMs"] for r in data.get("replay",[]) if r.get("kind")=="turn" and r["mode"]==mode and not r["withinTurn"] and (not yield_only or r.get("explicitYield"))]
            data["summary"][mode+(" explicit yield ms" if yield_only else " end delay ms")]=summary(values)
    ir=[r for r in data.get("replay",[]) if r.get("kind")=="interrupt"]
    data["summary"]["fake IO interrupt dispatch ms"]=summary([r["silenceMs"] for r in ir])
    for mode in ["serial","whole"]:
        for key in ["ttfbS","rtf","interSentenceSilenceS","underruns","underrunS","onsetArtifactScore"]:
            data["summary"][mode+" "+key]=summary([r.get(key) for r in data.get("tts",{}).get("clips",[]) if r["mode"]==mode])
    stt=[f["whisper"]["finalizationS"] for f in data.get("fixtures",{}).get("fixtures",[]) if f.get("whisper")]
    data["summary"]["Whisper whole utterance finalization s"]=summary(stt)
    data["summary"]["synthetic Whisper word error rate"]=summary([f["transcriptAccuracy"]["wer"] for f in data.get("fixtures",{}).get("fixtures",[]) if f.get("transcriptAccuracy")])
    model=[r["firstSpeakableS"] for r in data.get("model",[])]
    data["summary"]["provider first speakable s"]=summary(model)
    data["summary"]["provider first observed process s"]=summary([r["firstSpeakableS"] for r in data.get("model",[]) if r["run"]==0])
    data["summary"]["provider repeat processes s"]=summary([r["firstSpeakableS"] for r in data.get("model",[]) if r["run"]>0])
    # Component medians are descriptive; do not mislabel their sum as an E2E p95.
    detection=data["summary"]["pc end delay ms"]["median"]
    parts={"turnDetectionS":detection/1000 if detection is not None else None,
           "sttFinalizationS":summary(stt)["median"],"modelFirstSpeakableS":summary(model)["median"],
           "ttsFirstAudioS":data["summary"]["serial ttfbS"]["median"],"playbackLeadS":.02,
           "leadingSpeechSilenceS":summary([r.get("leadingSilenceMs",0)/1000 for r in data.get("tts",{}).get("clips",[]) if r["mode"]=="serial"])["median"]}
    data["composedLatencyProxy"]={"scope":"PC/server STT component proxy; excludes device recognition lag","components":parts,"sumOfComponentMediansS":sum(parts.values()) if all(v is not None for v in parts.values()) else None,"endToEndObserved":False}
    data["status"]="failed" if data["failures"] else "offline complete" if args.offline else "complete with measurement limitations"
    if data.get("fixtures",{}).get("transcriptStatus"):
        data["status"]+="; Whisper integration unmeasured, oracle replay only"
    (out/"results.json").write_text(json.dumps(data,indent=2,allow_nan=False),encoding="utf-8"); report(data,out/"BASELINE-FULL.md")
    print(f"Report: {out/'BASELINE-FULL.md'}; failures: {len(data['failures'])}")
    return int(bool(data["failures"]))


if __name__=="__main__":
    sys.exit(main())
