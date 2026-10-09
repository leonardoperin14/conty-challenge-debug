export function normalizeKey(key: string): string {
  return key.replace(/\u200B/g, "").trim().toLowerCase();
}
