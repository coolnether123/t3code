import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComputerBadge } from "./ComputerBadge";

vi.mock("../state/environments", () => ({
  useEnvironment: (id: string) =>
    id === "computer-a"
      ? { label: "Example A", color: "#123abc" }
      : { label: "Example B", color: "#654321" },
}));

describe("computer badges", () => {
  it("keeps each computer's name visible alongside its chosen color", () => {
    const markup = renderToStaticMarkup(
      <div>
        <ComputerBadge environmentId={EnvironmentId.make("computer-a")} />
        <ComputerBadge environmentId={EnvironmentId.make("computer-b")} />
      </div>,
    );
    expect(markup).toContain('data-computer-name="Example A"');
    expect(markup).toContain('data-computer-name="Example B"');
    expect(markup).toContain("background-color:#123abc");
    expect(markup).toContain("background-color:#654321");
    expect(markup).toContain('aria-label="Computer: Example A"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("animate-");
  });
});
