export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonRecord(source: string | null | undefined): Record<string, unknown> | null {
  const normalized = String(source || '').trim();
  if (!normalized) return null;
  try {
    const parsed = JSON.parse(normalized);
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
