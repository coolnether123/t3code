import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";

NodeTest.test(
  "long recording crosses the real client encoder and server upload with a small stack",
  () => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["--stack-size=120", "--input-type=module"],
      {
        cwd: new URL("../../", import.meta.url),
        encoding: "utf8",
        timeout: 30_000,
        input: `
      import { createRequire } from 'node:module';
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      import assert from 'node:assert/strict';
      import { CallService } from './apps/server/src/speech/callService.ts';
      import { CallStore } from './apps/server/src/speech/callStore.ts';
      import { fetchEnvironmentSpeech } from './packages/client-runtime/src/voice-call/transport.ts';
      import { PrimaryConnectionTarget } from './packages/client-runtime/src/connection/model.ts';
      import { layerRemoteHttpClient } from './packages/client-runtime/src/rpc/http.ts';
      const require = createRequire(new URL('./packages/client-runtime/package.json', import.meta.url));
      const Effect = await import(pathToFileURL(require.resolve('effect/Effect')));
      const Option = await import(pathToFileURL(require.resolve('effect/Option')));
      const directory = await mkdtemp(join(tmpdir(), 't3-long-call-'));
      try {
        const service = new CallService(new CallStore(directory), {
          verify: async () => ({ runtimeMode: 'full-access', interactionMode: 'default' }),
          dispatch: async () => {},
          speech: async (input) => input.action === 'acquire' || input.action === 'renew'
            ? {sessionId:'synthetic-lease',tenants:['stt','tts'],expiresAt:'2099-10-18T00:00:00Z'} : {},
          tenants: ['stt', 'tts'], ttsModel: 'test'
        });
        const signal = new AbortController().signal;
        await service.handle({action:'call.open',callId:'test',options:{threadId:'thread',modelSelection:{instanceId:'claudeAgent',model:'test'}}},signal);
        const target = new PrimaryConnectionTarget({environmentId:'test',label:'test',httpBaseUrl:'https://synthetic.example',wsBaseUrl:'wss://synthetic.example/ws'});
        const prepared = {environmentId:'test',label:'test',httpBaseUrl:target.httpBaseUrl,socketUrl:target.wsBaseUrl,httpAuthorization:null,target};
        const audio = Buffer.alloc(48000 * 2 * 60, 1).toString('base64');
        const fetcher = async (_url, init) => Response.json(await service.handle(JSON.parse(init.body),signal));
        const result = await Effect.runPromise(fetchEnvironmentSpeech({prepared,signer:Option.none(),signal,fetcher,request:{action:'call.upload',callId:'test',utteranceId:'minute',audio,sampleRate:48000,startedAt:'2026-10-19T00:00:00Z',endedAt:'2026-10-19T00:01:00Z'}}).pipe(Effect.provide(layerRemoteHttpClient(fetcher))));
        assert.equal(result.utterance.bytes, 48000 * 2 * 60);
        console.log('60 second upload saved');
      } finally { await rm(directory, {recursive:true,force:true}); }
    `,
      },
    );
    NodeAssert.equal(result.status, 0, result.stderr || result.stdout);
    NodeAssert.match(result.stdout, /60 second upload saved/);
  },
);
