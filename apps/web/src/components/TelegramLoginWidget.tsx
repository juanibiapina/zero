import { useEffect, useRef } from "react";

const TELEGRAM_BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string;

export interface TelegramAuthPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramAuthPayload) => void;
  }
}

// Renders the official Telegram Login Widget script tag. The widget
// injects an iframe and invokes window.onTelegramAuth on success.
export function TelegramLoginWidget({
  onAuth,
}: {
  onAuth: (payload: TelegramAuthPayload) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.onTelegramAuth = onAuth;
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", TELEGRAM_BOT_USERNAME);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    containerRef.current?.appendChild(script);
    return () => {
      delete window.onTelegramAuth;
      script.remove();
    };
  }, [onAuth]);

  return <div ref={containerRef} />;
}
