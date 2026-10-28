import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { OtisDictation } from "./OtisDictation";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  finish: vi.fn(),
  close: vi.fn(),
  request: vi.fn(),
  device: vi.fn(),
}));
vi.mock("../../voice/deviceSpeech", () => ({
  createDeviceSpeech: () => ({ capture: mocks.device, finish: vi.fn() }),
}));
vi.mock("../../voice/browserSpeech", () => ({
  createBrowserAudio: () => ({
    unlock: vi.fn(),
    prepare: async () => {},
    capture: mocks.capture,
    finish: mocks.finish,
    close: mocks.close,
  }),
  requestSpeech: mocks.request,
}));

it("dictates through PC recognition when the browser has no device recognizer and releases the lease", async () => {
  vi.clearAllMocks();
  mocks.device.mockResolvedValue(null);
  let finish!: (value: { audio: string; sampleRate: number }) => void;
  mocks.capture.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mocks.finish.mockImplementation(() => finish({ audio: "AAA=", sampleRate: 16000 }));
  mocks.request.mockImplementation(async (_environment, request) =>
    request.action === "acquire"
      ? { sessionId: "synthetic-dictation" }
      : request.action === "transcribe"
        ? { text: "Synthetic message" }
        : {},
  );
  const onText = vi.fn();
  await using screen = await render(
    <OtisDictation
      environmentId={EnvironmentId.make("synthetic")}
      onText={onText}
      onActiveChange={vi.fn()}
    />,
  );
  await screen.getByRole("button", { name: "Dictate message" }).click();
  await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
  await screen.getByRole("button", { name: "Finish dictation" }).click();
  await vi.waitFor(() => expect(onText).toHaveBeenCalledWith("Synthetic message"));
  await vi.waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "synthetic",
      { action: "release", sessionId: "synthetic-dictation" },
      expect.any(AbortSignal),
    ),
  );
  expect(mocks.close).toHaveBeenCalled();
});
