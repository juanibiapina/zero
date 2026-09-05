import { useCSSVariable } from 'uniwind';

// Read a `--color-*` design token as a string. `useCSSVariable` is typed
// `string | number | undefined` (CSS variables can be numeric, e.g. spacing);
// color props (@expo/ui, NativeTabs, placeholderTextColor, android_ripple) want
// a string, and every color token resolves to one at runtime. This is the one
// place that cast lives.
export function useColor(name: `--color-${string}`): string {
  return useCSSVariable(name) as string;
}
