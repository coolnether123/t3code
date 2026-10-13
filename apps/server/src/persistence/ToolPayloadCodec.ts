// @effect-diagnostics nodeBuiltinImport:off - lossless storage encoding at the persistence boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

const marker = "__t3CompressedToolDataV1";
const minimumBytes = 16 * 1024;
const maximumBytes = 256 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Only opaque tool data is packed. SQL-visible identity and lifecycle fields stay JSON. */
export function retainToolPayload(payload: unknown): unknown {
  const root = record(payload);
  if (!root || root.data === undefined) return payload;
  const text = JSON.stringify(root.data);
  const bytes = Buffer.from(text, "utf8");
  const escaped = record(root.data)?.[marker] !== undefined;
  if (bytes.length < minimumBytes && !escaped) return payload;
  if (bytes.length > maximumBytes) return payload;
  const compressed = NodeZlib.deflateSync(bytes, { level: 1 });
  const data = {
    [marker]: {
      codec: "deflate-json",
      bytes: bytes.length,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      value: compressed.toString("base64"),
    },
  };
  if (!escaped && JSON.stringify(data).length >= text.length) return payload;
  return { ...root, data };
}

/** Corrupt or unsupported encoded data fails closed instead of losing history. */
export function restoreToolPayload(payload: unknown): unknown {
  const root = record(payload);
  const data = record(root?.data);
  if (!root || !data || !(marker in data)) return payload;
  const packed = record(data[marker]);
  if (
    Object.keys(data).length !== 1 ||
    !packed ||
    packed.codec !== "deflate-json" ||
    typeof packed.bytes !== "number" ||
    !Number.isSafeInteger(packed.bytes) ||
    packed.bytes < 0 ||
    packed.bytes > maximumBytes ||
    typeof packed.sha256 !== "string" ||
    typeof packed.value !== "string"
  )
    throw new Error("Invalid retained tool payload");
  const bytes = NodeZlib.inflateSync(Buffer.from(packed.value, "base64"), {
    maxOutputLength: maximumBytes,
  });
  if (
    bytes.length !== packed.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== packed.sha256
  )
    throw new Error("Retained tool payload checksum mismatch");
  return { ...root, data: JSON.parse(bytes.toString("utf8")) as unknown };
}

export function retainEventPayload(type: string, payload: unknown): unknown {
  const root = record(payload);
  const activity = record(root?.activity);
  if (
    type !== "thread.activity-appended" ||
    !root ||
    !activity ||
    (activity.kind !== "tool.completed" && activity.kind !== "tool.updated")
  )
    return payload;
  return { ...root, activity: { ...activity, payload: retainToolPayload(activity.payload) } };
}

export function restoreStoredPayload(payload: unknown): unknown {
  const root = record(payload);
  const activity = record(root?.activity);
  if (root && activity && (activity.kind === "tool.completed" || activity.kind === "tool.updated"))
    return { ...root, activity: { ...activity, payload: restoreToolPayload(activity.payload) } };
  return restoreToolPayload(payload);
}
