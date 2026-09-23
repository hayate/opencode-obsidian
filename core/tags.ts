// The tags that fence recorded data off from instructions: the payload's memory block, the
// summarizer's transcript. Text placed inside one must not be able to close it early.

// Any spelling a reader could take for the tag (case, spaces, invisible characters, "_" or "-"
// between its words, look-alike angle brackets), opening or closing.
export function tagPattern(...words: string[]): RegExp {
  return new RegExp(`[<\\uFE64\\uFF1C][\\s\\p{Cf}]*\\/?[\\s\\p{Cf}]*${words.join("[\\s\\p{Cf}_-]*")}`, "giu");
}

export function escapeTag(text: string, tag: RegExp): string {
  return text.replace(tag, (found) => `&lt;${found.slice(1)}`);
}
