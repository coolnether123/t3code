import type {
  CommandId, EventId, MessageId, ModelSelection, ProviderInteractionMode,
  RuntimeMode, ThreadId, TurnId,
} from "@t3tools/contracts";

// These records are already stored in durable call delivery files. Keep their
// format stable, and translate them to current thread commands at the boundary.
export type CallCommand =
  | {
      readonly type: "thread.turn.start";
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly message: { readonly messageId: MessageId; readonly role: "user"; readonly text: string; readonly attachments: readonly [] };
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly createdAt: string;
    }
  | {
      readonly type: "thread.turn.interrupt";
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly createdAt: string;
    }
  | {
      readonly type: "thread.activity.append";
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly createdAt: string;
      readonly activity: {
        readonly id: EventId;
        readonly kind: string;
        readonly summary: string;
        readonly tone: "info" | "error" | "warning" | "tool";
        readonly payload?: unknown;
        readonly turnId: TurnId | null;
        readonly createdAt: string;
      };
    };
