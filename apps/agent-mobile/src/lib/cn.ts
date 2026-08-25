import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Merge Tailwind class strings, resolving conflicts (later wins). Same helper
// shape the web packages use, so class composition works the same across
// web and mobile.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
