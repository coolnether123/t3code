import { createFileRoute } from "@tanstack/react-router";

import { RepeatedInputPage } from "../components/usage/RepeatedInputPage";

export const Route = createFileRoute("/repeated-input")({
  component: RepeatedInputPage,
});
