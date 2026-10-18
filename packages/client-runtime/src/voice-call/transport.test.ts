import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentSpeech } from "./transport.ts";

const environmentId = EnvironmentId.make("selected-environment");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Synthetic",
  httpBaseUrl: "https://selected.example",
  wsBaseUrl: "wss://selected.example/ws",
});
const prepared: PreparedConnection = {
  environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl,
  httpAuthorization: null,
  target,
};
const input = {
  prepared,
  signer: Option.none<ManagedRelayDpopSigner["Service"]>(),
  request: { action: "call.status" as const, callId: "synthetic" },
  signal: new AbortController().signal,
};

describe("voice environment transport", () => {
  it.effect("passes streamed audio to playback before the response ends", () =>
    Effect.gen(function* () {
      let source!: ReadableStreamDefaultController<Uint8Array>;
      let received!: () => void;
      const first = new Promise<void>((resolve) => {
        received = resolve;
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      });
      const fetcher: typeof fetch = async () =>
        new Response(body, { headers: { "content-type": "application/x-ndjson" } });
      const chunks: string[] = [];
      const request = yield* fetchEnvironmentSpeech({
        ...input,
        request: {
          action: "call.speak",
          callId: "synthetic",
          speechId: "sentence",
          text: "First.",
          streamAudio: true,
        },
        fetcher,
        onAudio: (chunk) => {
          chunks.push(chunk.audio);
          received();
        },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetcher)), Effect.forkChild);
      const bytes = new TextEncoder();
      source.enqueue(bytes.encode('{"audio":"AA'));
      source.enqueue(bytes.encode('A=","sampleRate":24000}\n'));
      yield* Effect.promise(() => first);
      expect(chunks).toEqual(["AAA="]);
      source.enqueue(bytes.encode('{"complete":true}\n'));
      source.close();
      expect(yield* Fiber.join(request)).toEqual({ complete: true });
    }),
  );
  it.effect("allows a cold prepare to finish after the router's 600 second startup window", () =>
    Effect.gen(function* () {
      let enter!: () => void;
      let complete!: (response: Response) => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const response = new Promise<Response>((resolve) => {
        complete = resolve;
      });
      const fetcher: typeof fetch = async () => {
        enter();
        return response;
      };
      const request = yield* fetchEnvironmentSpeech({
        ...input,
        request: { action: "call.prepare", callId: "synthetic" },
        fetcher,
      }).pipe(Effect.provide(remoteHttpClientLayer(fetcher)), Effect.forkChild);
      yield* Effect.promise(() => entered);
      yield* TestClock.adjust("601 seconds");
      complete(Response.json({}));
      expect(yield* Fiber.join(request)).toEqual({});
    }),
  );
  it.effect.each([null, { _tag: "Bearer", token: "synthetic-bearer" }] satisfies
    | PreparedHttpAuthorization[]
    | (PreparedHttpAuthorization | null)[])(
    "uses the selected cookie or bearer environment",
    (authorization) =>
      Effect.gen(function* () {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fetcher: typeof fetch = async (url, init) => {
          calls.push({ url: String(url), ...(init ? { init } : {}) });
          return Response.json({});
        };
        yield* fetchEnvironmentSpeech({
          ...input,
          prepared: { ...prepared, httpAuthorization: authorization },
          fetcher,
        }).pipe(Effect.provide(remoteHttpClientLayer(fetcher)));
        expect(calls[0]?.url).toBe("https://selected.example/api/voice");
        expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
          authorization ? "Bearer synthetic-bearer" : null,
        );
        expect(calls[0]?.init?.credentials).toBe(authorization ? "omit" : "include");
      }),
  );
  it.effect("refreshes a rejected relay credential and signs the new environment URL", () =>
    Effect.gen(function* () {
      const calls: { url: string; init?: RequestInit }[] = [];
      const fetcher: typeof fetch = async (url, init) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        return calls.length === 1 ? new Response(null, { status: 401 }) : Response.json({});
      };
      const proofs: string[] = [];
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("synthetic"),
        createProof: (proof) =>
          Effect.sync(() => {
            proofs.push(`${proof.method} ${proof.url} ${proof.accessToken}`);
            return `synthetic-proof-${proofs.length}`;
          }),
      });
      const remoteAuthorization = RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("unused"),
        authorizeDpop: () => Effect.die("unused"),
        authorizeDpopHttp: (request) =>
          Effect.succeed({
            environmentId,
            label: target.label,
            httpBaseUrl: request.rejectedAccessToken
              ? "https://renewed.example"
              : "https://current.example",
            httpAuthorization: {
              _tag: "Dpop",
              accessToken: request.rejectedAccessToken ? "renewed" : "current",
              expiresAtEpochMs: 3600000,
            },
          }),
      });
      yield* fetchEnvironmentSpeech({
        ...input,
        prepared: {
          ...prepared,
          target: new RelayConnectionTarget({ environmentId, label: "Relay" }),
          httpAuthorization: { _tag: "Dpop", accessToken: "old", expiresAtEpochMs: 0 },
        },
        signer: Option.some(signer),
        remoteAuthorization: Option.some(remoteAuthorization),
        fetcher,
      }).pipe(Effect.provide(remoteHttpClientLayer(fetcher)));
      expect(calls.map((call) => call.url)).toEqual([
        "https://current.example/api/voice",
        "https://renewed.example/api/voice",
      ]);
      expect(proofs).toEqual([
        "POST https://current.example/api/voice current",
        "POST https://renewed.example/api/voice renewed",
      ]);
      expect(calls[0]?.init?.body).toBe(calls[1]?.init?.body);
    }),
  );
  it.effect.each([409, 503])(
    "distinguishes configuration from engine failure for HTTP %s",
    (status) =>
      Effect.gen(function* () {
        const fetcher: typeof fetch = async () => new Response("Synthetic failure", { status });
        const error = yield* fetchEnvironmentSpeech({ ...input, fetcher }).pipe(
          Effect.provide(remoteHttpClientLayer(fetcher)),
          Effect.flip,
        );
        expect(error).toMatchObject({ message: "Synthetic failure", recoverable: status === 503 });
      }),
  );
});
