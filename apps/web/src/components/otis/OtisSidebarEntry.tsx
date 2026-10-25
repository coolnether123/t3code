import { useRouter } from "@tanstack/react-router";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useSidebar } from "../ui/sidebar";
import { buildThreadRouteParams } from "../../threadRoutes";
import { OtisButton } from "./OtisButton";

export function OtisSidebarEntry() {
  const environmentId = usePrimaryEnvironmentId();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <OtisButton
      environmentId={environmentId}
      onOpen={(thread) => {
        if (isMobile) setOpenMobile(false);
        return router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(thread),
        });
      }}
    />
  );
}
