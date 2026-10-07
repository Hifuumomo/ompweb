import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MermaidBlock } = await jiti.import("./MermaidBlock.tsx");

// Simple sequenceDiagram for testing
const mermaidSrc = `sequenceDiagram
    Alice->>Bob: Hello
    Bob-->>Alice: Hi`;

test("MermaidBlock opens the diagram preview without requiring a click", () => {
  const html = renderToStaticMarkup(
    React.createElement(MermaidBlock, { code: mermaidSrc }),
  );

  assert.match(html, />(Source|mermaidBlock\.source)</);
  assert.match(html, /mermaid-block-loading/);
  assert.doesNotMatch(html, /Alice/);
});

test("MermaidBlock with isStreaming falls back to source view", () => {
  const html = renderToStaticMarkup(
    React.createElement(MermaidBlock, { code: mermaidSrc, isStreaming: true }),
  );

  assert.match(html, /disabled/);
  assert.match(html, />(Preview|mermaidBlock\.preview)</);
  assert.match(html, /Alice/);
  assert.match(html, /-&gt;&gt;/);
});

