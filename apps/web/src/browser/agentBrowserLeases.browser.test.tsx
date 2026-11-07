import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useAgentBrowserLeases } from "./agentBrowserLeases";

vi.mock(import("~/state/previewStream"), () => ({
  readPreviewStreamAccess: async (id) => ({
    httpBase: `https://${id}.test/api/preview-stream`,
    wsBase: `wss://${id}.test/api/preview-stream`,
    query: { wsTicket: `ticket-${id}` },
    credentials: false,
  }),
}));

function LeaseList(props: { environmentId: string; label: string }) {
  const leases = useAgentBrowserLeases(EnvironmentId.make(props.environmentId));
  return (
    <output aria-label={props.label}>{leases.map((lease) => lease.threadId).join(",")}</output>
  );
}

it("shares one lease request per environment without mixing the two Macs' thread ownership", async () => {
  const requests: Array<{ url: string; signal: AbortSignal }> = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    requests.push({ url: String(url), signal: init!.signal! });
    const machine = new URL(String(url)).hostname.split(".")[0];
    return Response.json({
      version: 1,
      machine,
      leases: [
        {
          leaseId: machine,
          threadId: `thread-${machine}`,
          workerId: "worker",
          profileId: "agent",
          pages: [],
          viewOnly: true,
        },
      ],
    });
  });
  using _fetch = { [Symbol.dispose]: () => fetchSpy.mockRestore() };
  {
    await using screen = await render(
      <>
        <LeaseList environmentId="elora" label="Elora header" />
        <LeaseList environmentId="elora" label="Elora sidebar" />
        <LeaseList environmentId="millie" label="Millie sidebar" />
      </>,
    );
    await expect.element(screen.getByLabelText("Elora header")).toHaveTextContent("thread-elora");
    await expect.element(screen.getByLabelText("Elora sidebar")).toHaveTextContent("thread-elora");
    await expect
      .element(screen.getByLabelText("Millie sidebar"))
      .toHaveTextContent("thread-millie");
    expect(requests.map((request) => request.url).sort()).toEqual([
      "https://elora.test/api/preview-stream/leases?wsTicket=ticket-elora",
      "https://millie.test/api/preview-stream/leases?wsTicket=ticket-millie",
    ]);
  }
});
