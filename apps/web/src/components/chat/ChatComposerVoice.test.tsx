import { describe, expect, it } from "vite-plus/test";
import source from "./ChatComposer.tsx?raw";

// The controller must stay mounted while text UI collapses or asks for approval.
// Real viewport rendering is verified by the parent-run acceptance helper.
describe("composer voice lifecycle boundary", () => {
  it("keeps the toolbar outside the mobile collapsed and approval branches", () => {
    expect(source).not.toContain("isComposerCollapsedMobile || isComposerApprovalState ? null : (");
    expect(source).not.toContain('showMobilePendingAnswerActions && "hidden sm:flex"');
    const voice = source.indexOf("<ThreadVoiceControls");
    const textActions = source.indexOf("<ComposerFooterPrimaryActions", voice);
    expect(voice).toBeGreaterThan(0);
    expect(textActions).toBeGreaterThan(voice);
    expect(source.slice(voice, textActions)).toContain("!isComposerApprovalState ? (");
  });
  it("allows voice to attach while ordinary tool approvals or input are pending", () => {
    const voice = source.slice(source.indexOf("<ThreadVoiceControls"));
    const enabled = voice.slice(voice.indexOf("enabled={"), voice.indexOf("environmentId={"));
    expect(enabled).not.toContain("pendingApprovals");
    expect(enabled).not.toContain("pendingUserInputs");
  });
});
