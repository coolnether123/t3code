/**
 * A link that signs a device in to one computer can also carry another
 * computer's pairing link in its hash, `#add-computer=<pairing url>`, so a phone
 * reaches both computers from one tap. The pairing route keeps the value through
 * sign-in, and the app asks before adding the computer.
 */
const ADD_COMPUTER_PARAM = "add-computer";

function hashParams(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.replace(/^#/, ""));
}

export function readAddComputerLink(url: URL): string | null {
  const value = hashParams(url).get(ADD_COMPUTER_PARAM)?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export function addComputerHash(pairingUrl: string): string {
  return new URLSearchParams([[ADD_COMPUTER_PARAM, pairingUrl]]).toString();
}

export function stripAddComputerLink(url: URL): URL {
  const next = new URL(url.toString());
  const params = hashParams(next);
  params.delete(ADD_COMPUTER_PARAM);
  next.hash = params.toString();
  return next;
}

/** Short host name for the confirmation, such as "millies-macbook-pro". */
export function addComputerHostLabel(pairingUrl: string): string {
  try {
    return new URL(pairingUrl).hostname.split(".")[0] || pairingUrl;
  } catch {
    return pairingUrl;
  }
}
