import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("ui scale zoom rules shrink the html box so the painted result fits the viewport", async () => {
  const source = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const box = String.raw`calc\(100%\s*\/\s*var\(--ui-scale\)\)`;

  for (const name of ["compact", "comfortable", "large"]) {
    const block = source.match(new RegExp(`html\\[data-ui-scale="${name}"\\]\\s*\\{[^}]*\\}`));
    assert.ok(block, `missing html[data-ui-scale="${name}"]`);
    assert.match(block[0], /zoom:\s*[\d.]+;/);
    assert.match(block[0], new RegExp(`height:\\s*${box}`));
    assert.match(block[0], new RegExp(`max-height:\\s*${box}`));
    assert.match(block[0], new RegExp(`width:\\s*${box}`));
    assert.match(block[0], new RegExp(`max-width:\\s*${box}`));
  }

  // Layered copies lose to the unlayered html, body height. This rule is what applies.
  assert.match(
    source,
    /html\[data-ui-scale="compact"\],\s*html\[data-ui-scale="comfortable"\],\s*html\[data-ui-scale="large"\]\s*\{[^}]*height:\s*calc\(100%\s*\/\s*var\(--ui-scale\)\)/,
  );
});

test("upstream's coarse-pointer 44px targets apply only in the Accessible mode", async () => {
  const source = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  // Narrow-viewport and touch-sidebar layout blocks size rows for the layout, not
  // per control; Compact overrides those explicitly. Only top-level rules and
  // upstream's per-control `@media (pointer: coarse)` blocks belong behind the mode.
  const ungated = [];
  for (const match of source.matchAll(/min-(?:height|width):\s*44px/g)) {
    const open = source.lastIndexOf("{", match.index);
    const selector = source.slice(source.lastIndexOf("}", open) + 1, open).trim();
    if (selector.includes('html[data-touch-targets="accessible"]')) continue;
    let depth = 0;
    let context = "";
    for (let i = open - 1; i >= 0; i--) {
      if (source[i] === "}") depth++;
      else if (source[i] === "{" && depth-- === 0) {
        context = source.slice(source.lastIndexOf("}", i) + 1, i).trim();
        break;
      }
    }
    if (context === "" || /^@media\s*\(pointer:\s*coarse\)$/.test(context)) ungated.push(selector);
  }
  assert.deepEqual(ungated, [], "44px rules outside the Accessible mode override Compact and Auto");
});

test("touch targets density options define accessible and compact modes with inline source tag", async () => {
  const source = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(source, /@source\s+inline\("data-touch-targets"\);/);
  assert.match(source, /html\[data-touch-targets="compact"\]\s+\.composer-primary-action\s*\{[^}]*min-height:\s*28px/);
  assert.match(source, /html\[data-touch-targets="compact"\]\s+\.session-item-row\s*\{[^}]*min-height:\s*30px/);
  assert.match(source, /html\[data-touch-targets="compact"\]\s+\.settings-card\s*\{[^}]*padding:\s*10px 16px/);
});
