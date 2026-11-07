// Compact JSON that matches Go's json.Marshal byte-for-byte for the shapes we sign:
// - object keys in insertion order (callers build objects in Go struct field order)
// - undefined fields omitted (Go `omitempty` pointer fields)
// - integers only (uint64 as number or bigint); floats are rejected because
//   decimals must be sent as canonical strings
// - Go's default HTML-safe string escaping (<, >, & and U+2028/U+2029)

export type CanonicalValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return goQuote(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      if (value < 0n) throw new Error("Negative integers are not used in signed payloads");
      return value.toString();
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error(
          `Only safe integers may be signed as JSON numbers (got ${value}); use a decimal string or bigint`,
        );
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => {
            if (item === undefined) throw new Error("undefined is not allowed inside arrays");
            return canonicalJson(item);
          })
          .join(",")}]`;
      }
      const parts: string[] = [];
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        parts.push(`${goQuote(key)}:${canonicalJson(item)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`Unsupported value in signed payload: ${typeof value}`);
  }
}

const HEX = "0123456789abcdef";

function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (
      code < 0x20 ||
      ch === "<" ||
      ch === ">" ||
      ch === "&" ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      out += "\\u" + [12, 8, 4, 0].map((shift) => HEX[(code >> shift) & 0xf]).join("");
    } else out += ch;
  }
  return out + '"';
}
