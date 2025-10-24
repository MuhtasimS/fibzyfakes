export function sanitizeContextForHistory(parts, mentionedUsername) {
  const placeholder = mentionedUsername
    ? `[Context for user @${mentionedUsername} was included in this turn.]`
    : '[Context for this turn included retrieved conversations or persona updates.]';
  const seenTexts = new Set();
  return parts.reduce((acc, part) => {
    if (part && part.text && part.text.includes('--- Additional Context')) {
      if (!seenTexts.has(placeholder)) {
        acc.push({ text: placeholder });
        seenTexts.add(placeholder);
      }
      return acc;
    }
    if (part?.text) {
      if (seenTexts.has(part.text)) {
        return acc;
      }
      seenTexts.add(part.text);
    }
    acc.push(part);
    return acc;
  }, []);
}

export const __test = {
  sanitizeContextForHistory,
};
