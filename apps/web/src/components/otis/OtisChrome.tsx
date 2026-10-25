import { OtisRing } from "./OtisRing";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { MenuIcon, PhoneIcon, Minimize2Icon, MicOffIcon, Volume2Icon } from "lucide-react";
import { useSidebar } from "../ui/sidebar";
import "./otis.css";

export function OtisChrome(props: {
  canCall?: boolean;
  active: boolean;
  ready: boolean;
  status: string;
  error?: string | undefined;
  retry?: (() => void) | undefined;
  start: () => void;
  end: () => void;
  mute: (muted: boolean) => void;
  speaker: (enabled: boolean) => void;
}) {
  const error = props.error
    ? /insufficient_scope|EnvironmentScopeRequiredError/.test(props.error)
      ? "This device can't start calls. Pair it with full access."
      : "The call could not connect. Please try again."
    : undefined;
  const router = useRouter();
  const [full, setFull] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [seconds, setSeconds] = useState(0);
  const { setOpenMobile, toggleSidebar, isMobile } = useSidebar();
  useEffect(() => {
    if (!props.active) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [props.active]);
  const showCall = full && props.active;
  const chats = () => {
    if (isMobile) setOpenMobile(true);
    else if (props.active) {
      setFull(false);
      toggleSidebar();
    } else void router.navigate({ to: "/" });
  };
  return (
    <div
      className={
        showCall
          ? "pointer-events-auto absolute inset-0 font-sans text-white bg-(image:--otis-call-background)"
          : "pointer-events-none absolute inset-0 font-sans"
      }
    >
      <header
        className={
          showCall
            ? "pointer-events-none absolute inset-x-0 top-0 h-[190px]"
            : "pointer-events-none absolute inset-x-0 top-0 h-[190px] bg-(image:--otis-chat-header)"
        }
      >
        <button
          className={`pointer-events-auto absolute left-4 top-[58px] grid size-[52px] place-items-center rounded-full border text-otis-button-text ${showCall ? "border-white/35 bg-white/15" : "border-otis-line bg-otis-chrome"}`}
          aria-label="Chats"
          onClick={chats}
        >
          <MenuIcon />
          {!showCall ? (
            <span
              aria-hidden
              className="absolute top-[11px] right-2.5 size-[9px] rounded-full bg-otis-dot"
            />
          ) : null}
        </button>
        <div className="absolute top-[58px] left-1/2 -translate-x-1/2 text-center">
          <OtisRing calling={showCall} />
          <span
            className={
              showCall
                ? "mt-2 inline-block text-otis-call-name font-semibold"
                : "relative -mt-2 inline-block rounded-full border border-otis-line bg-otis-name-surface px-3.25 py-1.25 text-base font-semibold text-otis-text"
            }
          >
            Otis
          </span>
        </div>
        {props.canCall !== false ? (
          <button
            className={`pointer-events-auto absolute right-4 top-[58px] grid size-[52px] place-items-center rounded-full border text-otis-button-text disabled:opacity-50 ${showCall ? "border-white/35 bg-white/15" : "border-otis-line bg-otis-chrome"}`}
            aria-label={
              showCall ? "Minimize call" : props.active ? "Open active call" : "Call Otis"
            }
            disabled={!props.active && !props.ready}
            onClick={() => {
              if (showCall) {
                setFull(false);
                return;
              }
              setFull(true);
              if (!props.active) {
                setSeconds(0);
                setMuted(false);
                props.mute(false);
                props.start();
              }
            }}
          >
            {showCall ? <Minimize2Icon /> : <PhoneIcon />}
          </button>
        ) : null}
      </header>
      {showCall ? (
        <>
          <div className="absolute top-[210px] w-full text-center text-3xl font-medium tracking-otis-timer text-otis-timer [&_p]:p-3 [&_p]:text-sm [&_p]:tracking-normal">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            <p role="status">{props.status}</p>
            {error ? (
              <p role="alert">
                {error}
                {props.canCall !== false && props.retry ? (
                  <button onClick={props.retry}>Retry call</button>
                ) : null}
              </p>
            ) : null}
          </div>
          <div className="absolute inset-x-0 bottom-[52px] flex justify-around gap-2 px-5.5 text-center text-base [&_span]:mx-auto [&_span]:mb-2.5 [&_span]:grid [&_span]:size-[86px] [&_span]:max-w-[22vw] [&_span]:place-items-center [&_span]:rounded-full [&_svg]:size-[34px]">
            <button
              aria-pressed={speaker}
              onClick={() => {
                setSpeaker(!speaker);
                props.speaker(!speaker);
              }}
            >
              <span className="bg-otis-speaker text-black">
                <Volume2Icon />
              </span>
              Speaker
            </button>
            <button
              onClick={() => {
                props.end();
                setFull(false);
              }}
            >
              <span className="bg-otis-end text-white">
                <PhoneIcon className="rotate-[135deg]" />
              </span>
              End
            </button>
            <button
              aria-pressed={muted}
              onClick={() => {
                setMuted(!muted);
                props.mute(!muted);
              }}
            >
              <span className="border-(length:--otis-mute-border) border-otis-mute-line bg-otis-mute text-white">
                <MicOffIcon />
              </span>
              {muted ? "Unmute" : "Mute"}
            </button>
          </div>
        </>
      ) : (
        <>
          {props.active ? (
            <button
              className="pointer-events-auto absolute right-4 bottom-[150px] rounded-full bg-otis-chip px-4.5 py-3 text-otis-chip-text"
              onClick={() => setFull(true)}
            >
              Return to call
            </button>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="pointer-events-auto absolute inset-x-4 bottom-[210px] wrap-anywhere rounded-2xl bg-otis-chip px-4.5 py-3 text-otis-chip-text"
            >
              {error}
              {props.canCall !== false && props.retry ? (
                <button onClick={props.retry}>Retry call</button>
              ) : null}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
