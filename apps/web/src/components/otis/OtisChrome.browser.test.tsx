import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { OtisChrome } from "./OtisChrome";
import { OtisButton } from "./OtisButton";
import { EnvironmentId } from "@t3tools/contracts";
import "../../index.css";

vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ setOpenMobile: vi.fn(), toggleSidebar: vi.fn(), isMobile: true }),
}));
vi.mock("../../voice/browserSpeech", () => ({
  requestSpeech: async () => ({ threadId: "otis-main" }),
}));

it("opens the server-owned Otis conversation from the ring button", async () => {
  await page.viewport(390, 844);
  const open = vi.fn();
  await using screen = await render(
    <OtisButton environmentId={EnvironmentId.make("fixture")} onOpen={open} />,
  );
  await screen.getByRole("button", { name: "Otis" }).click();
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(open.mock.calls[0]?.[0]).toEqual({ environmentId: "fixture", threadId: "otis-main" });
  await page.screenshot({ path: "__screenshots__/otis-entry-390.png" });
});

function Fixture({
  end,
  mute,
  speaker,
}: {
  end: () => void;
  mute: (value: boolean) => void;
  speaker: (value: boolean) => void;
}) {
  const [active, setActive] = useState(false);
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        maxWidth: 760,
        margin: "auto",
        height: "100dvh",
        background: "black",
        color: "white",
      }}
    >
      <OtisChrome
        active={active}
        ready
        status="Listening"
        start={() => setActive(true)}
        end={() => {
          end();
          setActive(false);
        }}
        mute={mute}
        speaker={speaker}
      />
    </div>
  );
}

it("keeps a call live when minimized and exposes mute, speaker and end", async () => {
  const end = vi.fn();
  const mute = vi.fn();
  const speaker = vi.fn();
  await page.viewport(390, 844);
  await using screen = await render(<Fixture end={end} mute={mute} speaker={speaker} />);
  await screen.getByRole("button", { name: "Call Otis" }).click();
  await expect.element(screen.getByRole("button", { name: "Minimize call" })).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "__screenshots__/otis-call-390.png" });
  await page.viewport(1280, 900);
  await page.screenshot({ path: "__screenshots__/otis-call-desktop.png" });
  await page.viewport(390, 844);
  await screen.getByRole("button", { name: "Mute", exact: true }).click();
  expect(mute).toHaveBeenLastCalledWith(true);
  await screen.getByRole("button", { name: "Speaker", exact: true }).click();
  expect(speaker).toHaveBeenLastCalledWith(false);
  await screen.getByRole("button", { name: "Minimize call" }).click();
  expect(end).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Return to call", exact: true }).click();
  await screen.getByRole("button", { name: "End", exact: true }).click();
  expect(end).toHaveBeenCalledOnce();
  await expect.element(screen.getByRole("button", { name: "Call Otis" })).toBeVisible();
});
