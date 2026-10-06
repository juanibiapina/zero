import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { IconSuggester } from "@zero/agent-core";
import { fetchIconSuggestions } from "@/lib/icon-suggestions";

export function useNewProjectIcon({ title, enabled }: { title: string; enabled: boolean }) {
  const [suggester] = useState(() => new IconSuggester({ request: (input, signal) => fetchIconSuggestions(input, signal) }));
  const choice = useSyncExternalStore(suggester.subscribe, suggester.getChoice);
  useEffect(() => suggester.update({ title, enabled }), [suggester, title, enabled]);
  useEffect(() => () => suggester.dispose(), [suggester]);
  const pick = useCallback((icon: string) => suggester.pick(icon), [suggester]);
  const reset = useCallback(() => suggester.reset(), [suggester]);
  return { choice, pick, reset };
}
