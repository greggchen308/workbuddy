// Constitution §3 (CLAUDE.md) detection signature: a hash immediately followed by a zero-width
// space (U+200B) is the confirmed corruption artifact left by the tag-misparse bug. Construct the
// character via its code point -- never paste it raw, it silently vanishes in transcription.
const ZWSP = String.fromCharCode(0x200b);

export interface CorruptionScanResult {
  corrupted: boolean;
  occurrences: number;
}

export function scanForCorruptionSignature(kramdown: string): CorruptionScanResult {
  const pattern = new RegExp("#" + ZWSP, "g");
  const matches = kramdown.match(pattern) ?? [];
  return { corrupted: matches.length > 0, occurrences: matches.length };
}
