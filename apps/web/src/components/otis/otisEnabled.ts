/**
 * Otis surfaces (sidebar button and the Otis screen) ship by default. A build
 * sets `VITE_OTIS_ENABLED=false` to leave them out, as the Mac release does.
 */
export const otisEnabled = import.meta.env.VITE_OTIS_ENABLED !== "false";

/** The Otis call control is opt-in: a build must set `VITE_OTIS_CALL_ENABLED=true`. */
export const otisCallEnabled = otisEnabled && import.meta.env.VITE_OTIS_CALL_ENABLED === "true";
