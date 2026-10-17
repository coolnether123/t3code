import { useEffect, useRef } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { requestConfirmDialog } from "~/confirmDialog";
import {
  addComputerHostLabel,
  readAddComputerLink,
  stripAddComputerLink,
} from "~/connection/addComputerLink";
import { connectPairing } from "~/connection/onboarding";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUrlChange } from "~/hooks/useUrlChange";
import { toastManager } from "./ui/toast";

/** Asks once whether to add the computer named by an `#add-computer=` link, then pairs it. */
export function AddComputerLinkPrompt() {
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const handled = useRef(new Set<string>());
  const pendingPrompts = useRef(Promise.resolve());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useUrlChange(() => {
    const url = new URL(window.location.href);
    const pairingUrl = readAddComputerLink(url);
    if (pairingUrl === null) return;
    // The link is one-time; drop it so a reload or shared URL cannot replay it.
    window.history.replaceState(window.history.state, "", stripAddComputerLink(url));
    if (handled.current.has(pairingUrl)) return;
    handled.current.add(pairingUrl);
    const host = addComputerHostLabel(pairingUrl);

    pendingPrompts.current = pendingPrompts.current.then(async () => {
      if (!mounted.current) return;
      const confirmed =
        (await requestConfirmDialog(
          `Add ${host} to T3 on this device?\nYou can then start chats on it from here.`,
        )) ?? false;
      if (!confirmed || !mounted.current) return;
      const result = await connect({ pairingUrl });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not add ${host}`,
          description: error instanceof Error ? error.message : "The link may have expired.",
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: `${host} added`,
        description: "Pick it from the computer menu at the top left.",
      });
    });
  });

  return null;
}
