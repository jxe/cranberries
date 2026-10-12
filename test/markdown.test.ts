import { test } from "node:test";
import assert from "node:assert/strict";
import { markdown as paragraphs, type Mark } from "../src/markdown";
// The marks of a text that is one paragraph.
const markdown = (text: string) => {
  const [p, ...rest] = paragraphs(text) as Exclude<Mark, string>[];
  assert.equal(rest.length, 0);
  return p.children;
};
test("links, bare URLs and emphasis become marks; other text is kept", () => {
  assert.deepEqual(markdown("See [the rules](https://a.example/r), ok?"), [
    "See ",
    { tag: "a", href: "https://a.example/r", children: ["the rules"] },
    ", ok?",
  ]);
  assert.deepEqual(markdown("Go to https://a.example/x."), [
    "Go to ",
    {
      tag: "a",
      href: "https://a.example/x",
      children: ["https://a.example/x"],
    },
    ".",
  ]);
  assert.deepEqual(
    markdown("**very** *nice* `code` 2 * 3 * 4 snake_case_name"),
    [
      { tag: "strong", children: ["very"] },
      " ",
      { tag: "em", children: ["nice"] },
      " ",
      { tag: "code", children: ["code"] },
      " 2 * 3 * 4 snake_case_name",
    ],
  );
});
test("only web and mail links are linked", () => {
  assert.deepEqual(markdown("[x](javascript:alert(1)) <b>hi</b>"), [
    "[x](javascript:alert(1)) <b>hi</b>",
  ]);
});
test("headings and list items are blocks; other line breaks survive", () => {
  assert.deepEqual(markdown("# Setup\nfirst\nsecond\n- one\n2. two\nlast"), [
    { tag: "h", children: ["Setup"] },
    "first",
    "\n",
    "second",
    "\n",
    { tag: "li", marker: "•", children: ["one"] },
    { tag: "li", marker: "2.", children: ["two"] },
    "last",
  ]);
});
test("blank lines divide paragraphs, however many there are", () => {
  assert.deepEqual(paragraphs("\none\ntwo\n\n \n\nthree\n\n"), [
    { tag: "p", children: ["one", "\n", "two"] },
    { tag: "p", children: ["three"] },
  ]);
  assert.deepEqual(paragraphs(" \n"), []);
});
