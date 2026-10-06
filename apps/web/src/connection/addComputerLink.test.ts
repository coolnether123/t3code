import { describe, expect, it } from "vite-plus/test";

import {
  addComputerHash,
  addComputerHostLabel,
  readAddComputerLink,
  stripAddComputerLink,
} from "./addComputerLink";

const millieLink = "https://millie.example.ts.net/pair#token=ABC123";

describe("add-computer links", () => {
  it("round-trips another computer's pairing link through the hash", () => {
    const url = new URL(`https://elora.example.ts.net/#${addComputerHash(millieLink)}`);
    expect(readAddComputerLink(url)).toBe(millieLink);
  });

  it("survives next to this computer's own pairing token", () => {
    const url = new URL(
      `https://elora.example.ts.net/pair#token=OWN&${addComputerHash(millieLink)}`,
    );
    expect(readAddComputerLink(url)).toBe(millieLink);
    const stripped = stripAddComputerLink(url);
    expect(readAddComputerLink(stripped)).toBeNull();
    expect(stripped.hash).toBe("#token=OWN");
  });

  it("ignores pages without a link and labels the host briefly", () => {
    expect(readAddComputerLink(new URL("https://elora.example.ts.net/#add-computer="))).toBeNull();
    expect(readAddComputerLink(new URL("https://elora.example.ts.net/"))).toBeNull();
    expect(addComputerHostLabel(millieLink)).toBe("millie");
    expect(addComputerHostLabel("not a url")).toBe("not a url");
  });
});
