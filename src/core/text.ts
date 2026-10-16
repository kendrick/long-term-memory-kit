// `split` always returns at least one element, so `[0]` can't be undefined at runtime; the `!` only answers noUncheckedIndexedAccess.
export const firstLine = (s: string): string => s.split("\n")[0]!;

// Code-unit order, not localeCompare: output must sort the same on every machine and locale.
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
