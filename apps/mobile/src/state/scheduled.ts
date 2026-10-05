import { createScheduledRunAtoms } from "@t3tools/client-runtime/state/scheduled";

import { connectionAtomRuntime } from "../connection/runtime";

export const scheduledRuns = createScheduledRunAtoms(connectionAtomRuntime);
