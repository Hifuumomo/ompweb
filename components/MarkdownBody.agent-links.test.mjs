import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { AgentLinkContext } = await jiti.import("../lib/agent-links.ts");

afterEach(cleanup);

test("clicking an agent:// link opens it in-app with nested-then-base candidates", () => {
  const opened = [];
  const { container } = render(
    React.createElement(AgentLinkContext.Provider, { value: (ids) => opened.push(ids) },
      React.createElement(MarkdownBody, null, "See agent://Parent/Child.")),
  );
  const link = container.querySelector('a[href="agent://Parent/Child"]');

  assert.equal(fireEvent.click(link, { button: 0 }), false, "click default must be prevented");
  assert.equal(fireEvent(link, new window.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })), false, "middle-click default must be prevented");
  assert.deepEqual(opened, [["Parent.Child", "Parent"]]);
});
