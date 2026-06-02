export function hasMatchingSecretHeader(expected: string | undefined, actual: string | undefined): boolean {
  return !!expected && actual === expected;
}
