export async function readJsonOrNull<T>(readJson: () => Promise<unknown>): Promise<T | null> {
  try {
    return (await readJson()) as T;
  } catch {
    return null;
  }
}
