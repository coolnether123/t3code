import { useLocation } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

/** Observe both router navigation and links opened in the current document. */
export function useUrlChange(onChange: () => void) {
  const href = useLocation({ select: (location) => location.href });
  const handleChange = useEffectEvent(onChange);

  useEffect(() => {
    const listener = () => handleChange();
    window.addEventListener("hashchange", listener);
    window.addEventListener("popstate", listener);
    handleChange();
    return () => {
      window.removeEventListener("hashchange", listener);
      window.removeEventListener("popstate", listener);
    };
    // Router-only navigation can change the hash without a native event.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [href]);
}
