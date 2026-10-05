import { useEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { defaultToastController } from "@zero/agent-core";

export function ToastLifecycle() {
  const location = useLocation();
  const live = useSyncExternalStore(defaultToastController.subscribe, defaultToastController.getSnapshot, defaultToastController.getSnapshot);
  const previous = useRef({ key: location.key, toasts: live });
  useEffect(() => {
    if (previous.current.key !== location.key) {
      for (const toast of previous.current.toasts) {
        if (toast.durationMs !== Infinity && live.includes(toast)) defaultToastController.dismiss(toast.id);
      }
    }
    previous.current = { key: location.key, toasts: defaultToastController.getSnapshot() };
  }, [location.key, live]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      for (const toast of defaultToastController.getSnapshot()) {
        if (toast.durationMs !== Infinity) defaultToastController.dismiss(toast.id);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  return null;
}
