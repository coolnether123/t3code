# Voice bench

Run from the repository root after `vp i`, with Python and NumPy installed:

```powershell
python scripts/voice-bench/run.py --artifacts A:/Dev/Artifacts/talk-to-otis-voice-20261022/bench
```

The command writes private JSON, Markdown, fixture PCM, WAVs, transcripts and full replay logs outside Git. It returns a nonzero exit when a stage fails and preserves the failed stage in the report. Run through the owning build queue for long executions. Do not run it during a real voice call or family gaming. Router admission remains authoritative.

The first run copies the five saved PCM utterances read-only, generates a synthetic user corpus with the named `elora-calm-design` voice, and transcribes it through a scoped Whisper lease. Later runs verify and reuse the same manifest and SHA-256 hashes. Do not rebuild the corpus between candidate comparisons. Use a new artifact folder intentionally for a new corpus. `--voice` selects another existing Breeze voice before initial generation. Audio is synthetic and is not Jared's voice.

For a candidate build, give `--artifacts` a separate private report directory and pass `--fixtures A:/Dev/Artifacts/talk-to-otis-voice-20261022/bench/fixtures`. This keeps the baseline reports intact while using exactly the same PCM. Apply this benchmark code to the candidate worktree and run there so replay imports that candidate's shipped source.

`--offline` reruns source replay and historical WAV analysis without live speech or model inference. `--runs 3` controls live TTS and provider repetitions. The TTS measurements extend the private `baseline/tts_bench.py` method with retained chunk arrivals and onset screening. Serial gaps simulate the client starting the next sentence after playback; the estimate excludes the call.played round trip and persistence time. The browser scheduler model uses a 20 ms lead. No browser or hardware audio is opened.

If Whisper is unavailable after synthetic WAVs were generated, `--offline --allow-oracle` reconstructs the pending corpus from those cached WAVs and runs device timers with expected text. Every affected row says `oracle, STT unavailable`. It never calls that text a recognition result. `--recorded-tts <parent-tts-baseline.json>` and `--recorded-model <previous-results.json>` can produce a combined baseline from explicitly identified prior measurements while live speech is unavailable. These options are for documenting an incomplete baseline, not measuring a new candidate. Provenance and previous failures remain in the report. `--prepare-fixtures` prepares only the corpus and can run independently of JavaScript dependencies.

`--policy file:///absolute/path/controller.ts` imports `shouldEndTurn(timeline)` for PC replay. The timeline has `speechMs`, `lastBurstMs`, `silenceMs` and optional `transcript`. A module can also export `replayDevice(fixture)` returning observation rows with `kind: "turn"`, `mode: "device"`, `fixture`, `pauseIndex`, `withinTurn`, `falseCutoff`, `delayMs`, `explicitYield`. The private manifest contains segment start/end times and Whisper segment text. This allows controllers with incremental state to own their event replay. Device baseline replay executes the shipped recognition timers using fake time. Test recognition final arrival is at segment end, so recognition lag remains unknown.

The interruption test executes `ThreadVoiceSession` with fake audio IO and a late transport callback that ignores cancellation. It measures explicit abort dispatch and stale-chunk rejection, including late message deltas and queued sentences. It cannot prove hardware silence or automatic barge-in.

The model leg directly invokes the installed provider CLI with a fixed, nonprivate two-part question, no tools and no persisted session. It records first text, first sentence and whether both fixture facts appear. This is a provider proxy, not a T3 call. The combined latency is a sum of component medians, never an end-to-end p95. First request and warm repeats are labeled without claiming a cold service or known provider cache state.

The onset score is an objective screen for energy loss, bandwidth loss, clicks and clipping. It needs listening validation. It cannot alone establish distortion, intelligibility or a codec cause. Saved human utterances lack ground-truth intent, so false-cutoff rates use only deliberately constructed synthetic pauses. JSON retains sample counts, source revision, timing assumptions and failures.

Focused metric checks:

```powershell
python -m unittest discover -s scripts/voice-bench -p 'test_*.py'
```

The replay test runs automatically from the main command. Private file locations are passed by environment variables and never committed. Each stage writes a checkpoint so other lanes can inspect partial evidence without mistaking it for a successful full run.
