// Read CSV text into rows of fields. A field in quotes can hold commas, quotes
// (written twice), and line breaks. A row that has only empty text is skipped.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  const endRow = () => {
    if (row.length || field) rows.push([...row, field]);
    row = [];
    field = "";
    fieldStart = true;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (char === ",") {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      endRow();
    } else {
      field += char;
      fieldStart = false;
    }
  }
  endRow();
  return rows;
}
