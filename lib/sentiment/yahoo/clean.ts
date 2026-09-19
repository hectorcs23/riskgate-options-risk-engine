const htmlEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " "
};

export function cleanYahooText(text: string) {
  return text
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#x")) {
        const parsed = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : " ";
      }
      if (lower.startsWith("#")) {
        const parsed = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : " ";
      }
      return htmlEntities[lower] ?? " ";
    })
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
