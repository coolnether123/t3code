import { createFileRoute } from "@tanstack/react-router";

import { ScheduledRunView } from "../components/ScheduledRunView";

export const Route = createFileRoute("/scheduled/$runId")({
  component: () => {
    const { runId } = Route.useParams();
    return <ScheduledRunView key={runId} runId={runId} />;
  },
});
