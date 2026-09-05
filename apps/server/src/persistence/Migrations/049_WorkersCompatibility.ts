import { ensureWorkerSchema } from "./041_Workers.ts";

// Upstream's migration 41 was auth metadata, so its official 47 history has
// no Worker tables. The fork's schema is already idempotent and can safely
// complete either history here.
export default ensureWorkerSchema;
