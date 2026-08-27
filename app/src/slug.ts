/**
 * Stream-name slugging.
 *
 * Rules:
 *   - lowercase
 *   - spaces (and any other non-alphanumeric run) become dashes
 *   - a trailing "-camera" is stripped (e.g. "Living Room Camera" -> "living-room")
 *   - collisions across cameras are resolved by appending -2, -3, ...
 */

export function slugifyStreamName(name: string): string {
  let s = (name || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.endsWith("-camera")) s = s.slice(0, -"-camera".length);
  return s.replace(/-+$/g, "");
}

export interface SlugInput {
  did: string;
  name: string;
}

/** Assign a unique slug to each camera, de-duplicating by appending -N. */
export function assignUniqueSlugs(items: SlugInput[]): Record<string, string> {
  const used = new Set<string>();
  const map: Record<string, string> = {};
  for (const it of items) {
    const base = slugifyStreamName(it.name || it.did);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    map[it.did] = slug;
  }
  return map;
}
