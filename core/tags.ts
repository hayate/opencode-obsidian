// The tags that fence recorded data off from instructions: the payload's memory block, the
// summarizer's transcript. Text placed inside one should not be able to close it early.
//
// This is a mitigation, not a boundary: it covers the spellings below, not every look-alike a
// model might read as the tag (letters from other scripts are not listed). What gets past it can
// mislead the reader of the block; the summarizer, at least, has no tools to act with (D10).

// Fullwidth Latin letters sit at a fixed offset from ASCII (U+FF21 is "A").
const FULLWIDTH = 0xfee0;

function letter(c: string): string {
  return /[a-z]/i.test(c) ? `[${c}${String.fromCodePoint((c.codePointAt(0) ?? 0) + FULLWIDTH)}]` : c;
}

// Any spelling a reader could take for the tag, opening or closing: any case, fullwidth letters,
// invisible characters anywhere in it (inside a word too), spaces, any dash or "_" between its
// words, and look-alike angle brackets and slashes.
export function tagPattern(...words: string[]): RegExp {
  const word = (w: string): string => [...w].map(letter).join("\\p{Cf}*");
  return new RegExp(
    `[<\\uFE64\\uFF1C][\\s\\p{Cf}]*[\\/\\uFF0F\\u2215\\u2044]?[\\s\\p{Cf}]*${words.map(word).join("[\\s\\p{Cf}\\p{Pd}_\\uFF3F]*")}`,
    "giu",
  );
}

export function escapeTag(text: string, tag: RegExp): string {
  return text.replace(tag, (found) => `&lt;${found.slice(1)}`);
}
