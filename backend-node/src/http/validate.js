import { HttpError } from "../errors.js";

// A small schema language. Each schema has `parse(value, path, errors)`. It
// returns the clean value and adds a message to `errors` for a wrong value.
const length = (text) => [...text].length;
const add = (errors, path, msg) => errors.push({ loc: path, msg });
const MISSING = Symbol("missing");

export const text = ({ min = 0, max = Infinity, trim = true, upper = false, truncate = false, pattern, message } = {}) => ({
  parse(value, path, errors) {
    if (typeof value !== "string") return add(errors, path, "Input should be a valid string");
    let result = trim ? value.trim() : value;
    if (upper) result = result.toUpperCase();
    if (truncate && length(result) > max) result = [...result].slice(0, max).join("");
    if (length(result) < min)
      return add(errors, path, `String should have at least ${min} character${min === 1 ? "" : "s"}`);
    if (length(result) > max) return add(errors, path, `String should have at most ${max} characters`);
    if (pattern && !pattern.test(result)) return add(errors, path, message ?? "String has the wrong format");
    return result;
  },
});

export const integer = ({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => ({
  parse(value, path, errors) {
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      return add(errors, path, "Input should be a valid integer");
    if (value < min) return add(errors, path, `Input should be greater than or equal to ${min}`);
    if (value > max) return add(errors, path, `Input should be less than or equal to ${max}`);
    return value;
  },
});

export const boolean = () => ({
  parse(value, path, errors) {
    if (typeof value !== "boolean") return add(errors, path, "Input should be a valid boolean");
    return value;
  },
});

export const oneOf = (...values) => ({
  parse(value, path, errors) {
    if (!values.includes(value)) return add(errors, path, `Input should be ${values.map((item) => `'${item}'`).join(", ")}`);
    return value;
  },
});

// A field that may be missing or null. The result is `fallback` then.
export const optional = (schema, fallback = null) => ({
  optional: true,
  fallback,
  parse: (value, path, errors) => (value === null ? fallback : schema.parse(value, path, errors)),
});

// Text that may be missing, null, or empty. An empty text becomes null. A long text is cut.
export const optionalText = (max) => {
  const inner = text({ max, truncate: true });
  return optional({
    parse(value, path, errors) {
      const result = inner.parse(value, path, errors);
      return result === "" ? null : result;
    },
  });
};

export const list = (item, { min = 0, max = Infinity } = {}) => ({
  parse(value, path, errors) {
    if (!Array.isArray(value)) return add(errors, path, "Input should be a valid list");
    if (value.length < min) return add(errors, path, `List should have at least ${min} item${min === 1 ? "" : "s"}`);
    if (value.length > max) return add(errors, path, `List should have at most ${max} items`);
    return value.map((entry, index) => item.parse(entry, [...path, index], errors));
  },
});

// `check(result, path, errors)` may add rules that use several fields.
export const shape = (fields, check) => ({
  parse(value, path, errors) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return add(errors, path, "Input should be a valid object");
    const result = {};
    const before = errors.length;
    for (const [name, schema] of Object.entries(fields)) {
      const entry = Object.hasOwn(value, name) ? value[name] : MISSING;
      if (entry === MISSING || (entry === null && schema.optional)) {
        if (schema.optional) result[name] = schema.fallback;
        else add(errors, [...path, name], "Field required");
      } else result[name] = schema.parse(entry, [...path, name], errors);
    }
    if (check && errors.length === before) check(result, path, errors);
    return result;
  },
});

// Check `value` with `schema`. Throw status 422 with all the messages.
export function validate(schema, value, root) {
  const errors = [];
  const result = schema.parse(value, root, errors);
  if (errors.length) throw new HttpError(422, errors);
  return result;
}

// The parameters from the path and the query string are text. Make them numbers.
export function parseParam(name, raw, where, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = /^\d{1,15}$/.test(raw ?? "") ? Number(raw) : NaN;
  return validate(integer({ min, max }), value, [where, name]);
}
