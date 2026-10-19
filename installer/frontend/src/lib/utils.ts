import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** cn merges Tailwind classes so a caller's class always wins over a default. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
