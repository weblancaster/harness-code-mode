import test from "node:test";
import assert from "node:assert/strict";
import { Catalog, sanitizeJsName } from "../core/catalog.js";

test("sanitizeJsName normalizes invalid chars, leading digits, and empty input", () => {
  assert.equal(sanitizeJsName("mcp__github__list-prs"), "mcp__github__list_prs");
  assert.equal(sanitizeJsName("123tool.name"), "_123tool_name");
  assert.equal(sanitizeJsName(""), "_tool");
  assert.equal(sanitizeJsName("read_file"), "read_file");
});

test("Catalog deduplicates colliding sanitized JS names with numeric suffixes", () => {
  const cat = new Catalog([
    { name: "my-tool", description: "first", schema: {} },
    { name: "my.tool", description: "second", schema: {} },
    { name: "my tool", description: "third", schema: {} },
  ]);
  const jsNames = cat.toWire().map((t) => t.js);
  assert.deepEqual(jsNames, ["my_tool", "my_tool_2", "my_tool_3"]);
  assert.equal(cat.jsToName.get("my_tool"), "my-tool");
  assert.equal(cat.jsToName.get("my_tool_2"), "my.tool");
  assert.equal(cat.jsToName.get("my_tool_3"), "my tool");
});

test("Catalog.search ranks BM25 matches on snake_case, camelCase, and MCP names", () => {
  const cat = new Catalog([
    { name: "mcp__github__list_prs", description: "List pull requests in a repo", schema: {} },
    { name: "mcp__weather__getForecast", description: "Get city weather forecast", schema: {} },
    { name: "read_file", description: "Read lines from a local file", schema: {} },
  ]);
  const prHits = cat.search("list prs", 5);
  assert.equal(prHits[0].name, "mcp__github__list_prs");
  assert.ok(prHits[0].score > 0);

  const weatherHits = cat.search("weather forecast", 5);
  assert.equal(weatherHits[0].name, "mcp__weather__getForecast");
});

test("Catalog.describe resolves registry/JS names and gives did-you-mean hints on typos", () => {
  const cat = new Catalog([
    { name: "mcp__tracker__list-issues", description: "List issues", schema: { type: "object" } },
    { name: "mcp__tracker__get_issue", description: "Get issue", schema: { type: "object" } },
  ]);
  const byReg = cat.describe("mcp__tracker__list-issues");
  assert.equal(byReg.ok, true);
  assert.equal(byReg.js, "mcp__tracker__list_issues");
  assert.deepEqual(byReg.schema, { type: "object" });

  const byJs = cat.describe("mcp__tracker__list_issues");
  assert.equal(byJs.ok, true);
  assert.equal(byJs.name, "mcp__tracker__list-issues");

  const typo = cat.describe("mcp__tracker__list_issue");
  assert.equal(typo.ok, false);
  assert.match(typo.error, /did you mean:.*mcp__tracker__list_issues/);
});

test("Catalog handles empty tool lists without NaN and produces wire-ready entries", () => {
  const cat = new Catalog([]);
  assert.deepEqual(cat.search("anything", 5), []);
  assert.equal(cat.describe("missing").ok, false);
  assert.deepEqual(cat.toWire(), []);
});
