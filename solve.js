// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
// run(input) returns exactly csv-reader's {columns, rows, errors} for {text, header}.
//
// Written from scratch from the broken-row policy in RULES.txt (the reference was
// read only to pin the exact semantics down). Strategy: a single sticky scan for
// the next delimiter instead of one character at a time, bulk slices instead of
// per-character appends, and a per-record fast path for lines holding no quote
// and no CR (one split(',') for the whole record). Field readers report through
// shared locals (fValue, fEnded, fAdded) instead of allocating a result object
// per field. A field that opens with a quote runs to the next quote that is not
// doubled; what follows its closing quote, up to the next comma or line break, is
// appended as it stands; a quote that never closes is a literal and the text
// after it is read again as unquoted. Fields stay strings, never trimmed or
// converted.

// The next comma, LF or CR at or after pos, in one scan (shared: run() is never
// re-entered, and readUnquoted always sets lastIndex before each exec).
const DELIM = /[,\n\r]/g;

const COMMA = 44;
const LF = 10;
const CR = 13;
const QUOTE = 34;
const BOM = 0xfeff;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === BOM) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended (0 = comma, 1 = line break,
  // 2 = end of text), and how many characters the last unquoted scan appended.
  let fValue = '';
  let fEnded = 0;
  let fAdded = 0;

  // The quoted content in [from, to): each CRLF and each lone CR becomes one LF and
  // counts one line. Returns the normalized string; updates `line`.
  function finishSpan(from, to) {
    if (from >= to) return '';
    const cr = text.indexOf('\r', from);
    const nl = text.indexOf('\n', from);
    if ((cr === -1 || cr >= to) && (nl === -1 || nl >= to)) return text.slice(from, to);
    const norm = text.slice(from, to).replace(/\r\n?/g, '\n');
    let n = 0;
    let i = norm.indexOf('\n');
    while (i !== -1) {
      n += 1;
      i = norm.indexOf('\n', i + 1);
    }
    line += n;
    return norm;
  }

  // Reads an unquoted field from pos, starting from `init` ('' normally, '"' when
  // re-reading a quote that never closes, or a quoted field's value for quote junk).
  // Reports through fValue, fEnded, fAdded; fAdded counts only the characters this
  // scan appended, not `init`.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    let seg = pos; // start of the current kept segment
    while (true) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (seg < len) {
          value += text.slice(seg);
          added += len - seg;
        }
        pos = len;
        fValue = value;
        fEnded = 2;
        fAdded = added;
        return;
      }
      const end = m.index;
      const ch = m[0];
      if (ch === ',') {
        if (seg < end) {
          value += text.slice(seg, end);
          added += end - seg;
        }
        pos = end + 1;
        fValue = value;
        fEnded = 0;
        fAdded = added;
        return;
      }
      if (ch === '\n') {
        if (seg < end) {
          value += text.slice(seg, end);
          added += end - seg;
        }
        pos = end + 1;
        line += 1;
        fValue = value;
        fEnded = 1;
        fAdded = added;
        return;
      }
      // ch === '\r': with an LF after it, a line break; alone, dropped (stray_cr).
      if (text.charCodeAt(end + 1) === LF) {
        if (seg < end) {
          value += text.slice(seg, end);
          added += end - seg;
        }
        pos = end + 2;
        line += 1;
        fValue = value;
        fEnded = 1;
        fAdded = added;
        return;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (seg < end) {
        value += text.slice(seg, end);
        added += end - seg;
      }
      pos = end + 1;
      seg = pos;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Reports through fValue,
  // fEnded (fAdded is the junk scan's, only where junk was read).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let q = pos + 1; // scan position inside the quotes
    let seg = q; // start of the current content segment
    while (true) {
      const close = text.indexOf('"', q);
      if (close === -1) {
        // The quote never closes: it is a literal character, and the text after it
        // is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(close + 1) === QUOTE) {
        // A doubled quote: one literal quote; keep scanning after it.
        value += finishSpan(seg, close) + '"';
        q = close + 2;
        seg = q;
        continue;
      }
      value += finishSpan(seg, close);
      pos = close + 1;
      if (pos >= len) {
        fValue = value;
        fEnded = 2;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === COMMA) {
        pos += 1;
        fValue = value;
        fEnded = 0;
        return;
      }
      if (c === LF) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = 1;
        return;
      }
      if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = 1;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next
      // comma or line break; quote_junk when anything was appended.
      readUnquoted(value);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  // Records the fields of one record (already read) in rows/columns, recording a
  // short_row or long_row error when its width differs from the first record's.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's line: up to the next LF, or the end of the text.
    const lineEnd = text.indexOf('\n', pos);
    const atEnd = lineEnd === -1;
    const end = atEnd ? len : lineEnd;
    // A CR right before that LF is the line break's own CR, not content.
    const contentEnd = !atEnd && end > pos && text.charCodeAt(end - 1) === CR ? end - 1 : end;
    const lineStr = text.slice(pos, contentEnd);
    if (lineStr.indexOf('"') === -1 && lineStr.indexOf('\r') === -1) {
      // No quote and no CR on the line: the whole record is plain fields.
      const fields = lineStr.split(',');
      pos = atEnd ? len : lineEnd + 1;
      if (!atEnd) line += 1;
      finishRecord(fields);
      continue;
    }

    // A quoted field or a stray CR somewhere on the line: read field by field.
    const fields = [];
    let lastQuoted = false;
    while (true) {
      if (text.charCodeAt(pos) === QUOTE) {
        lastQuoted = true;
        readQuoted();
      } else {
        lastQuoted = false;
        readUnquoted('');
      }
      fields.push(fValue);
      if (fEnded !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its
    // stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
