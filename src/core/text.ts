// `split` always returns at least one element, so `[0]` can't be undefined at runtime; the `!` only answers noUncheckedIndexedAccess.
export const firstLine = (s: string): string => s.split("\n")[0]!;
