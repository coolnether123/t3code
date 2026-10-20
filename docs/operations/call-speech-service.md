# Call speech service

The server speech proxy can send Call audio through the shared local speech
service. The browser keeps its current streaming player, transcript protocol
and selected voice/background models.

Configure the T3 server process with:

- `OTIS_SPEECH_SERVICE_ENABLED=1` for queued TTS, WAV transcription and quiet
  conversation presence.
- `OTIS_SPEECH_CLIENT_MODULE` as an absolute path to the release owner's
  immutable `speech-client.mjs` module.
- `OTIS_SPEECH_SERVICE_TOKEN_FILE` as the private Call caller token-file path.
- `OTIS_SPEECH_SERVICE_URL` for the loopback service, normally
  `http://127.0.0.1:8798`.

Use published helper files for installation. Candidate helper source is suitable
only for CPU integration checks. Never put token contents in configuration
committed to Git, command arguments, or logs.

The shared client needs conversation create/renew/end, service readiness,
WAV transcription, queued submit/stream and bounded job cancellation. Acquisition
retains its long preparation budget. Renewal checks the service's engine
readiness and keeps the returned presence expiry. An abandoned stream cancels
only its unfinished jobs using an independent two-second cleanup deadline.
The service's presence expiry remains the backstop for lost connections.
Acquisition requests service-owned transcription preparation before validating
the configured STT and TTS tenants. The installed service and helper must both
support that preparation option, service status and the long creation deadline.
Phone recordings above 48 kHz are downsampled in memory before WAV submission;
lower-rate recordings retain their samples. No phone capture setting changes.

Set `OTIS_SPEECH_SERVICE_ENABLED=0` for explicit rollback to the existing router
proxy. The default remains the router until recorded installed acceptance.
Enable the service default only through the current T3 deployment owner after
that acceptance. Do not change the backend, restart the shared router or
execution host, or launch a separate speech engine for this migration.

Affected CPU checks from the repository root:

```powershell
vp test run apps/server/src/speech/proxy.test.ts apps/server/src/speech/callService.test.ts
vp run --filter t3 typecheck
vp lint apps/server/src/speech/proxy.ts apps/server/src/speech/proxy.test.ts
```

Set `T3_CALL_TEST_SPEECH_CLIENT_MODULE` to the helper module path to include the
real shared-client CPU contract test. It uses a synthetic token and fake HTTP,
and never contacts the service. Without that path this optional check skips
explicitly.

CPU checks do not establish installed audio acceptance. Record an exchange
through the installed Call route and existing player, including real service
STT, quiet renewal, early audio arrival and interruption cleanup. A silent
player capture must be labeled as such; it cannot establish physical speaker
latency or phone microphone behavior.
