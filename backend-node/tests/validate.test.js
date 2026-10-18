import { test } from "node:test";
import assert from "node:assert/strict";
import { boolean, integer, list, oneOf, optional, optionalText, parseParam, shape, text, validate } from "../src/http/validate.js";
import { HttpError } from "../src/errors.js";

const errorsOf = (schema, value) => {
  try {
    validate(schema, value, ["body"]);
    return [];
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 422);
    return error.detail;
  }
};

test("text trims, changes the case, and checks the length in characters", () => {
  assert.equal(validate(text({ min: 1, max: 3 }), "  ab ", ["body"]), "ab");
  assert.equal(validate(text({ upper: true }), "abc", ["body"]), "ABC");
  assert.equal(validate(text({ trim: false }), " a ", ["body"]), " a ");
  assert.equal(validate(text({ max: 2 }), "😀😀", ["body"]), "😀😀");
  assert.equal(errorsOf(text({ max: 2 }), "😀😀😀").length, 1);
  assert.deepEqual(errorsOf(text({ min: 2 }), "a"), [{ loc: ["body"], msg: "String should have at least 2 characters" }]);
  assert.match(errorsOf(text({ min: 1 }), "  ")[0].msg, /at least 1 character$/);
  assert.equal(errorsOf(text(), 5)[0].msg, "Input should be a valid string");
  assert.equal(errorsOf(text({ pattern: /^a+$/, message: "only a" }), "b")[0].msg, "only a");
  assert.equal(validate(text({ max: 2, truncate: true }), "abcd", ["body"]), "ab");
});

test("integer accepts only whole numbers in range", () => {
  assert.equal(validate(integer({ min: 1, max: 5 }), 3, ["body"]), 3);
  for (const bad of ["3", 3.5, NaN, Infinity, true, null, undefined, {}, [], 2 ** 60])
    assert.equal(errorsOf(integer(), bad).length, 1, String(bad));
  assert.match(errorsOf(integer({ min: 1 }), 0)[0].msg, /greater than or equal to 1/);
  assert.match(errorsOf(integer({ max: 1 }), 2)[0].msg, /less than or equal to 1/);
});

test("boolean, choices, and lists have exact types", () => {
  assert.equal(validate(boolean(), false, ["body"]), false);
  for (const bad of ["true", 1, 0, null]) assert.equal(errorsOf(boolean(), bad).length, 1);
  assert.equal(validate(oneOf("a", "b"), "a", ["body"]), "a");
  assert.match(errorsOf(oneOf("a", "b"), "c")[0].msg, /'a', 'b'/);
  assert.deepEqual(validate(list(integer()), [1, 2], ["body"]), [1, 2]);
  assert.deepEqual(errorsOf(list(integer(), { max: 1 }), [1, 2]).map((e) => e.msg), ["List should have at most 1 items"]);
  assert.deepEqual(errorsOf(list(integer(), { min: 1 }), []).map((e) => e.msg), ["List should have at least 1 item"]);
  assert.deepEqual(errorsOf(list(integer()), [1, "x", "y"]).map((e) => e.loc), [["body", 1], ["body", 2]]);
  assert.equal(errorsOf(list(integer()), "x")[0].msg, "Input should be a valid list");
});

test("a shape reports each field with its path and ignores unknown fields", () => {
  const schema = shape({
    name: text({ min: 1 }),
    age: optional(integer({ min: 0 }), 18),
    note: optionalText(5),
  });
  assert.deepEqual(validate(schema, { name: " A ", extra: 1 }, ["body"]), { name: "A", age: 18, note: null });
  assert.deepEqual(validate(schema, { name: "A", age: null, note: "   " }, ["body"]), { name: "A", age: 18, note: null });
  assert.equal(validate(schema, { name: "A", note: "abcdefgh" }, ["body"]).note, "abcde");
  assert.deepEqual(errorsOf(schema, {}), [{ loc: ["body", "name"], msg: "Field required" }]);
  assert.deepEqual(errorsOf(schema, { name: "", age: -1 }).map((e) => e.loc.join(".")), ["body.name", "body.age"]);
  for (const bad of [null, [], "x", 5]) assert.equal(errorsOf(schema, bad)[0].msg, "Input should be a valid object");
});

test("a shape check runs only when the fields are valid", () => {
  const schema = shape({ a: integer(), b: integer() }, (value, path, errors) => {
    if (value.a > value.b) errors.push({ loc: path, msg: "a must not be above b" });
  });
  assert.deepEqual(errorsOf(schema, { a: 2, b: 1 }).map((e) => e.msg), ["a must not be above b"]);
  assert.deepEqual(errorsOf(schema, { a: "x", b: 1 }).map((e) => e.msg), ["Input should be a valid integer"]);
  assert.deepEqual(validate(schema, { a: 1, b: 2 }, ["body"]), { a: 1, b: 2 });
});

test("a missing own property is not read from the prototype", () => {
  const schema = shape({ toString: text() });
  assert.equal(errorsOf(schema, {})[0].msg, "Field required");
  const polluted = shape({ constructor: optional(text()) });
  assert.equal(validate(polluted, {}, ["body"]).constructor, null);
});

test("path and query numbers are checked", () => {
  assert.equal(parseParam("id", "42", "path"), 42);
  for (const bad of ["", "0", "-1", "1.5", "abc", "1e3", "12345678901234567890", " 1", "01x"])
    assert.throws(() => parseParam("id", bad, "path"), (error) => error.status === 422, bad);
  assert.equal(parseParam("lane", "999", "query", { min: 1, max: 999 }), 999);
  assert.throws(() => parseParam("lane", "1000", "query", { min: 1, max: 999 }), (error) => error.detail[0].loc.join(".") === "query.lane");
  assert.equal(parseParam("n", "0", "query", { min: 0 }), 0);
});
