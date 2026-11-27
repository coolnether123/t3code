import {
  OTIS_THREAD_ID,
  ThreadId,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useGT } from "gt-react";
import { Button } from "../ui/button";

export function OtisButton({
  environmentId,
  onOpen,
}: {
  environmentId: EnvironmentId | null;
  onOpen: (thread: ScopedThreadRef) => unknown;
}) {
  const gt = useGT();
  return (
    <div className="flex">
      <Button
        variant="ghost"
        disabled={!environmentId}
        onClick={() => {
          if (environmentId)
            void onOpen(scopeThreadRef(environmentId, ThreadId.make(OTIS_THREAD_ID)));
        }}
      >
        {gt("Otis")}
      </Button>
    </div>
  );
}
