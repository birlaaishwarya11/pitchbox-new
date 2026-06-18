// Robust extraction of a JSON object from model text. Works across providers
// (no tool-calling required), tolerating: a prose preamble, ```json fences, and
// raw control characters inside string values (which models occasionally emit
// and which JSON.parse rejects).

export function parseJsonObject(text: string): any | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  const attempts = [candidate];
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const slice = candidate.slice(start, end + 1);
    attempts.push(slice, escapeControlCharsInStrings(slice));
  }
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      // try the next, more aggressive, candidate
    }
  }
  return null;
}

/** Escape raw control characters that appear inside JSON string literals. */
export function escapeControlCharsInStrings(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (inString && code < 0x20) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }
  return out;
}
