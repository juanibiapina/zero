import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/clerk-react";
import { Button } from "@/components/ui/button";
import {
  GOOGLE_WORKSPACE_SCOPES,
  missingScopes,
} from "../google-scopes";
import {
  TelegramLoginWidget,
  type TelegramAuthPayload,
} from "@/components/TelegramLoginWidget";

const GOOGLE_SCOPES_MUTABLE: string[] = [...GOOGLE_WORKSPACE_SCOPES];
const TELEGRAM_BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string;


// ─── Stepper ───────────────────────────────────────────────────────

const STEP_LABELS = ["Google", "Telegram", "Ready"] as const;

function Stepper({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="flex items-center px-6 py-5 sm:px-8 lg:px-10">
      {STEP_LABELS.map((label, i) => {
        const isComplete = i < activeIndex;
        const isActive = i === activeIndex;

        return (
          <div key={label} className="flex flex-1 items-center last:flex-none">
            {/* Circle + label */}
            <div className="flex items-center gap-2.5">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors duration-300 ${
                  isComplete
                    ? "bg-foreground text-background"
                    : isActive
                      ? "bg-foreground text-background"
                      : "border border-border text-muted-foreground"
                }`}
              >
                {isComplete ? (
                  <svg width="12" height="10" viewBox="0 0 12 10" fill="none" className="stroke-current">
                    <path d="M1 5.5L4 8.5L11 1.5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={`text-sm transition-colors duration-300 ${
                  isActive
                    ? "font-medium text-foreground"
                    : isComplete
                      ? "text-muted-foreground"
                      : "text-muted-foreground/50"
                }`}
              >
                {label}
              </span>
            </div>

            {/* Connecting line (not after the last step) */}
            {i < STEP_LABELS.length - 1 && (
              <div className="mx-4 h-px flex-1 bg-border">
                <div
                  className="h-full bg-foreground transition-all duration-500 ease-out"
                  style={{ width: isComplete ? "100%" : "0%" }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Steps ─────────────────────────────────────────────────────────

function GoogleStep({ onSkip }: { onSkip: () => void }) {
  const { user } = useUser();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const redirectTo = (url: URL | null | undefined) => {
    if (url) window.location.href = url.toString();
  };

  return (
    <>
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          Connect your Google account
        </h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Zero needs access to Gmail, Calendar, Drive, and Sheets to work with
          your data. You can revoke access at any time from settings.
        </p>
      </div>
      <div className="flex items-center gap-3 pt-2">
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void (async () => {
              try {
                const result = await user.createExternalAccount({
                  strategy: "oauth_google",
                  additionalScopes: GOOGLE_SCOPES_MUTABLE,
                  redirectUrl: window.location.origin,
                });
                redirectTo(result.verification?.externalVerificationRedirectURL);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? "Connecting…" : "Connect Google"}
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Skip this step
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </>
  );
}

function TelegramStep({ onSkip }: { onSkip: () => void }) {
  const [error, setError] = useState<string | null>(null);

  const onAuth = useCallback(
    (payload: TelegramAuthPayload) => {
      void (async () => {
        setError(null);
        try {
          const res = await fetch("/api/telegram-link", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            setError(`Link failed: ${res.status}`);
          }
          window.location.reload();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    },
    [],
  );

  return (
    <>
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          Link your Telegram
        </h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          This connects your Telegram account so you can chat with Zero
          directly. Use the button below to authorize.
        </p>
      </div>
      <div className="pt-2">
        <TelegramLoginWidget onAuth={onAuth} />
      </div>
      <Button variant="ghost" onClick={onSkip}>
        Skip this step
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <>
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          You're all set
        </h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Everything is connected. Open Telegram and send a message to start
          your first conversation with Zero.
        </p>
      </div>
      <div className="flex items-center gap-3 pt-2">
        <a
          href={`https://t.me/${TELEGRAM_BOT_USERNAME}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onFinish}
        >
          <Button>Open in Telegram</Button>
        </a>
        <Button variant="ghost" onClick={onFinish}>
          Go to settings
        </Button>
      </div>
    </>
  );
}

// ─── Wizard ────────────────────────────────────────────────────────

type Step = "google" | "telegram" | "done";
const STEP_ORDER: Step[] = ["google", "telegram", "done"];

function determineStep(
  googleConnected: boolean,
  telegramConnected: boolean,
): Step {
  if (!googleConnected) return "google";
  if (!telegramConnected) return "telegram";
  return "done";
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const { isLoaded, user } = useUser();
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [telegramLoaded, setTelegramLoaded] = useState(false);
  const [entered, setEntered] = useState(false);

  // Fetch telegram state
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/telegram-id");
      if (!res.ok) {
        if (!cancelled) setTelegramLoaded(true);
        return;
      }
      const data = (await res.json()) as { telegramId: string | null };
      if (!cancelled) {
        setTelegramId(data.telegramId);
        setTelegramLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Entrance animation
  useEffect(() => {
    if (isLoaded && telegramLoaded) {
      requestAnimationFrame(() => setEntered(true));
    }
  }, [isLoaded, telegramLoaded]);

  const google = user?.externalAccounts.find((a) => a.provider === "google");
  const googleConnected = google
    ? missingScopes(google.approvedScopes, GOOGLE_WORKSPACE_SCOPES).length === 0
    : false;

  // Fire onboarding task once when Google is connected
  const googleTaskFiredRef = useRef(false);
  useEffect(() => {
    if (!googleConnected || googleTaskFiredRef.current) return;
    googleTaskFiredRef.current = true;
    void fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Onboard this new user using your google-onboarding skill." }),
    });
  }, [googleConnected]);
  const telegramConnected = telegramId !== null;

  const currentStep = determineStep(googleConnected, telegramConnected);

  // Animation state
  const [displayedStep, setDisplayedStep] = useState<Step>(currentStep);
  const [animating, setAnimating] = useState(false);
  const [slideDirection, setSlideDirection] = useState<"left" | "right">("left");
  const prevStepRef = useRef(currentStep);

  useEffect(() => {
    if (!isLoaded || !telegramLoaded) return;
    if (currentStep === prevStepRef.current) return;
    const fromIdx = STEP_ORDER.indexOf(prevStepRef.current);
    const toIdx = STEP_ORDER.indexOf(currentStep);
    prevStepRef.current = currentStep;
    setSlideDirection(toIdx > fromIdx ? "left" : "right");
    setAnimating(true);
    const timeout = setTimeout(() => {
      setDisplayedStep(currentStep);
      requestAnimationFrame(() => setAnimating(false));
    }, 200);
    return () => clearTimeout(timeout);
  }, [currentStep, isLoaded, telegramLoaded]);

  // Mark onboarding seen when done step is displayed
  const completedRef = useRef(false);
  useEffect(() => {
    if (displayedStep !== "done" || completedRef.current) return;
    completedRef.current = true;
    void (async () => {
      await fetch("/api/user-settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ onboardingSeen: true }),
      });
    })();
  }, [displayedStep]);

  const markComplete = useCallback(() => {
    if (!completedRef.current) {
      completedRef.current = true;
      void (async () => {
        await fetch("/api/user-settings", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ onboardingSeen: true }),
        });
      })();
    }
    onComplete();
  }, [onComplete]);

  const advanceToNext = useCallback(() => {
    if (!displayedStep) return;
    const idx = STEP_ORDER.indexOf(displayedStep);
    if (idx >= STEP_ORDER.length - 1) return;
    const next = STEP_ORDER[idx + 1];
    setSlideDirection("left");
    setAnimating(true);
    setTimeout(() => {
      setDisplayedStep(next);
      requestAnimationFrame(() => setAnimating(false));
    }, 200);
  }, [displayedStep]);

  if (!isLoaded || !telegramLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const displayedStepIndex = STEP_ORDER.indexOf(displayedStep);

  const contentTranslate = animating
    ? slideDirection === "left"
      ? "-translate-x-3 opacity-0"
      : "translate-x-3 opacity-0"
    : "translate-x-0 opacity-100";

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12 sm:px-6">
      <div
        className={`w-full max-w-lg md:max-w-xl lg:max-w-2xl transition-all duration-500 ease-out motion-reduce:transition-none ${
          entered
            ? "translate-y-0 opacity-100"
            : "translate-y-4 opacity-0"
        }`}
      >
        {/* Card */}
        <div className="overflow-hidden rounded-xl border border-border">
          {/* Stepper header */}
          <Stepper activeIndex={displayedStepIndex} />

          <div className="border-t border-border" />

          {/* Content — fixed height so the card never resizes between steps */}
          <div className="flex h-[320px] flex-col justify-center px-6 py-8 sm:px-8 lg:px-10 lg:py-10">
            <div
              className={`flex flex-col gap-6 transition-all duration-200 ease-out motion-reduce:transition-none ${contentTranslate}`}
            >
              {displayedStep === "google" && (
                <GoogleStep onSkip={advanceToNext} />
              )}
              {displayedStep === "telegram" && (
                <TelegramStep onSkip={advanceToNext} />
              )}
              {displayedStep === "done" && (
                <DoneStep onFinish={markComplete} />
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between px-1">
          <p className="text-xs text-muted-foreground/60">
            You can change these connections later in settings.
          </p>
          <button
            className="text-xs text-muted-foreground/60 transition-colors hover:text-foreground"
            onClick={markComplete}
          >
            Skip setup
          </button>
        </div>
      </div>
    </div>
  );
}
