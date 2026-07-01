// URL-query feature toggles.
//
// Enable a feature by visiting any page with `?ff_<name>=1` (also accepts
// `true`/`on`); disable with `?ff_<name>=0` (also `false`/`off`). The choice
// is persisted to localStorage so it survives client-side navigation, which
// strips the query string from react-router links.

import { useEffect } from "react";
import { useSearchParams } from "react-router";

const storageKey = (name: string) => `ff:${name}`;

const parseFlag = (value: string | null): boolean | null => {
  if (value === null) return null;
  if (value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  return null;
};

export function useFeature(name: string): boolean {
  const [params] = useSearchParams();
  const key = storageKey(name);
  const fromUrl = parseFlag(params.get(`ff_${name}`));

  // Persist an explicit URL choice for later navigations.
  useEffect(() => {
    if (fromUrl === true) localStorage.setItem(key, "1");
    else if (fromUrl === false) localStorage.removeItem(key);
  }, [fromUrl, key]);

  // The URL wins on the current render (avoids a redirect race before the
  // effect runs); otherwise fall back to the persisted value.
  return fromUrl ?? localStorage.getItem(key) === "1";
}
