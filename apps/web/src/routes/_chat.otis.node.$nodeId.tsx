import { createFileRoute } from "@tanstack/react-router";
import { OtisTranscriptView } from "~/components/otis/OtisTranscriptView";

export const Route = createFileRoute("/_chat/otis/node/$nodeId")({
  component: OtisTranscriptRoute,
});

function OtisTranscriptRoute() {
  const { nodeId } = Route.useParams();
  return <OtisTranscriptView key={nodeId} nodeId={nodeId} />;
}
