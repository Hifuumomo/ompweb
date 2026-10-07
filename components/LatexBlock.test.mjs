import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { loadMathMarkdownPlugins } = await jiti.import("../lib/markdown.ts");
await loadMathMarkdownPlugins();

function render(markdown, isStreaming = false) {
  return renderToStaticMarkup(React.createElement(MarkdownBody, { isStreaming }, markdown));
}

test("bare LaTeX fences render fractions inside the code block", () => {
  const html = render("```latex\n\\frac{a}{b}\n```");
  assert.match(html, /markdown-code-block[\s\S]*class="katex-display"/);
  assert.match(html, /class="mfrac"/);
  assert.doesNotMatch(html, /<pre/);
});

test("math delimiters in tex fences are parsed instead of rendered literally", () => {
  for (const formula of ["$$x^2$$", String.raw`\[x^2\]`, String.raw`\(x^2\)`]) {
    const html = render(`\`\`\`tex\n${formula}\n\`\`\``);
    assert.match(html, /class="katex"/);
    assert.match(html, /class="msupsub"/);
    assert.doesNotMatch(html, /katex-error/);
  }
});

test("streaming math stays source and ordinary code is not treated as math", () => {
  const markdown = "```latex\n\\frac{a}{\n```";
  const html = render(markdown, true);
  assert.match(html, /<pre[\s\S]*\\frac\{a\}\{/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /class="katex"/);
  const ordinary = render("```text\n\\frac{a}{b}\n```");
  assert.match(ordinary, /<pre[\s\S]*\\frac\{a\}\{b\}/);
  assert.doesNotMatch(ordinary, /class="katex"/);
});

