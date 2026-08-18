export const IDENTITY_COLOR_NAMES = [
  "Purple",
  "Cyan",
  "Pink",
  "Green",
  "Blue",
  "Magenta",
  "Teal",
  "Rose",
  "Violet",
  "Lime"
] as const;

export const IDENTITY_COLOR_COUNT = IDENTITY_COLOR_NAMES.length;

export type IdentityKind = "goal" | "app" | "site" | "category";

function normalizeIdentityId(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/\s+/gu, "-");
  if (normalized.length === 0) return "__unknown__";
  return normalized === "other" || normalized === "__other__" ? "__other__" : normalized;
}

export function getIdentityKey(kind: IdentityKind, id: string): string {
  return `${kind}:${normalizeIdentityId(id)}`;
}

export function getIdentityColorIndex(kind: IdentityKind, id: string): number {
  const key = getIdentityKey(kind, id);
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % IDENTITY_COLOR_COUNT;
}

export function resolveIdentityColorIndex(
  kind: IdentityKind,
  id: string,
  explicitColorIndex?: number
): number {
  return explicitColorIndex !== undefined
    && Number.isInteger(explicitColorIndex)
    && explicitColorIndex >= 0
    && explicitColorIndex < IDENTITY_COLOR_COUNT
    ? explicitColorIndex
    : getIdentityColorIndex(kind, id);
}

export function getIdentityColor(kind: IdentityKind, id: string, explicitColorIndex?: number): string {
  const index = resolveIdentityColorIndex(kind, id, explicitColorIndex);
  return `var(--dh-identity-color-${index + 1})`;
}
