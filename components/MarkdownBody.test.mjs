import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { normalizeDisplayMath, loadMathMarkdownPlugins } = await jiti.import("../lib/markdown.ts");
const { GithubRepoContext } = await jiti.import("../lib/github-refs.ts");

function renderMarkdown(markdown) {
  return renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      onOpenFile() {},
    }, markdown),
  );
}

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const html = renderMarkdown("[file](components/MarkdownBody.tsx)");

  assert.match(html, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("renders math as plain text until the lazy KaTeX pipeline loads", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.doesNotMatch(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders LaTeX parenthesis delimiters as inline math", async () => {
  await loadMathMarkdownPlugins();
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders paired LaTeX bracket delimiters as display math", async () => {
  await loadMathMarkdownPlugins();
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

function renderWithRepo(markdown, repo) {
  return renderToStaticMarkup(
    React.createElement(GithubRepoContext.Provider, { value: repo }, React.createElement(MarkdownBody, null, markdown)),
  );
}

test("links bare #N to the session repository and owner/repo#N to its own", () => {
  const html = renderWithRepo("On PR #3460 (see can1357/oh-my-pi#12130).", "kahme247/ompweb");

  assert.match(html, /<a href="https:\/\/github\.com\/kahme247\/ompweb\/issues\/3460"[^>]*>#3460<\/a>/);
  assert.match(html, /<a href="https:\/\/github\.com\/can1357\/oh-my-pi\/issues\/12130"[^>]*>can1357\/oh-my-pi#12130<\/a>/);
});

test("leaves bare #N plain without a repository but still links owner/repo#N", () => {
  const html = renderWithRepo("#12 and a/b#7", null);

  assert.doesNotMatch(html, /issues\/12/);
  assert.match(html, /href="https:\/\/github\.com\/a\/b\/issues\/7"/);
});

test("does not link references in code, existing links, or glued to words and paths", () => {
  const html = renderWithRepo("`#1` [see #2](https://x.test) C#3 file.ts#4 a/b/c#5 #6x #0 https://x.test/p#7", "o/r");

  assert.doesNotMatch(html, /github\.com/);
});
