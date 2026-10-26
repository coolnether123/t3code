import { createFileRoute } from "@tanstack/react-router";
import { UsageResetPage } from "../components/usage/UsageResetPage";

export const Route = createFileRoute("/_chat/usage-resets")({ component: UsageResetPage });
