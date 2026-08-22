/**
 * T3-owned provider sessions use a reserved, persisted thread-id namespace.
 * Keeping this boundary separate lets the normal provider-ingestion fan-out
 * recognize Worker traffic without depending on Worker persistence or service
 * startup order.
 */
export const WORKER_PROVIDER_THREAD_PREFIX = "t3-worker-";

export const isWorkerLinkedProviderThreadId = (threadId: string): boolean =>
  threadId.startsWith(WORKER_PROVIDER_THREAD_PREFIX);
