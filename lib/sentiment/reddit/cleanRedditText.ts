export function cleanRedditText(value: string | null | undefined) {
  if (!value) return "";
  return value
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\/?u\/[A-Za-z0-9_-]+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function tokenizeRedditText(value: string) {
  return cleanRedditText(value)
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((token) => token.length >= 2 && token.length <= 32);
}
