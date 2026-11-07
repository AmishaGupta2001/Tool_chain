/**
 * Pulls a numbered list ("1. ...", "2) ...", "**3.** ...") out of a model response.
 * Returns [] if it doesn't find at least two items, so the UI can fall back to
 * showing the whole output as a single option.
 */
export function parseNumberedOptions(text: string): string[] {
  const re = /^\s*(?:\*\*|__)?(\d{1,2})[.):](?:\*\*|__)?\s*(.+)$/;

  const clean = (s: string) =>
    s
      .replace(/^(\*\*|__)+|(\*\*|__)+$/g, "")
      .replace(/^["“”'‘’]+|["“”'‘’]+$/g, "")
      .trim();

  let items: string[] = [];
  let open = false; // true while the last line belonged to an item

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      open = false;
      continue;
    }

    const m = line.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n === 1) {
        items = [m[2]]; // a new list starts; keep the latest one
        open = true;
        continue;
      }
      if (n === items.length + 1) {
        items.push(m[2]);
        open = true;
        continue;
      }
    }

    // Wrapped caption text belongs to the previous item.
    if (open && items.length) items[items.length - 1] += `\n${line.trim()}`;
  }

  const cleaned = items.map(clean).filter(Boolean);
  return cleaned.length >= 2 ? cleaned : [];
}