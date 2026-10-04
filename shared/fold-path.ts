/**
 * The form a path (or a name in a shell line) is compared in. The volume folds
 * case and Unicode compatibility forms alike (U+017F long s opens
 * `.claude/settings.json` as `.claude/ſettings.json`), so lowercase alone
 * lets a spelling through. NFKC first, then up and down to fold what
 * lowercasing leaves (Kelvin sign). Every protected-name check uses this one.
 */
export function foldPath(text: string): string {
  return text.normalize("NFKC").toUpperCase().toLowerCase();
}
