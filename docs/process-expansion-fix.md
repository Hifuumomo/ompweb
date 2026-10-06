# Process detail expansion fix

## Status

Source changes and the verification record are complete. The final affected component suites pass 53/53 tests in separate runs. Typecheck and final affected-file lint pass. Actual AppShell browser checks confirm the covered behavior. Main started the normal local source service after verification. Pure thinking/text submission without a tool ID remains an acceptance gap; see below. No production build or packaged deployment was performed.

| Responsibility | Owner | Current state |
| --- | --- | --- |
| Architecture review | OmpwebArchitect | Read-only report received |
| Source changes and behavior tests | ExpansionCoder | Complete; browser and test findings corrected |
| Final checks and browser UI smoke | ExpansionVerifier | Final evidence received; covered behavior passes with stated limits |
| This record and the bug changelog item | ExpansionReporter | Complete |
| Integration and delivery | Main | Normal local source service started; owns delivery and later packaged deployment |

## Reported problem

The user opens process details while an agent works. New thinking or tool activity can close details that the user opened. The fix must also preserve a user's closed choice.

## Source and installation boundary

| Target | Evidence at the architecture review | Effect on this repair |
| --- | --- | --- |
| Global npm package | `@kahme247/ompweb` version `0.5.1`, in `C:/Users/ASUS/AppData/Roaming/npm/node_modules/@kahme247/ompweb` | Uses a packaged `.next` build. Local source edits do not update this installation. |
| Local checkout | `D:/Code/ompweb`; `package.json` also reports `0.5.1`; reviewed HEAD was `6c86c1397456aa363db5be9a4c13122dc2d03da3` on `fix/preserve-process-details-expansion` | Already has separate text and activity segments. Preserve this implementation. |
| Runtime | OMP `18.7.0`, as supplied in the architecture context | No real model request is permitted for this repair. |

A matching package version does not establish that these frontends have the same code. The architecture review did not establish which frontend build the user's browser loaded.

## Confirmed mechanisms

- In npm `0.5.1`, the outer process group key includes `finalAssistantIdx`. A tool cluster key includes its tool count. Changes to these values can replace mounted components and reset their local expansion state.
- The local checkout has a different text/activity layout. Its outer identity uses `userIdx` and `segmentIdx`; inner identities still include message or group positions.
- `ProcessDetailsGroup`, thinking blocks, tool blocks, and tool groups store expansion in local component state. Closing an outer group removes its detail body. Closing a tool group removes its child tools.
- A single tool and a group of tools use different rendering structures. An unchanged `toolCallId` cannot preserve local state when its parent or component type changes.
- Live and idle transcript paths differ. The streaming `MessageView` also has a different parent path from committed history. Stable React keys alone do not preserve local state across these boundaries.
- The reviewed tool effect opens a tool on entry to its running state when the default allows it. It does not close tools on an ordinary result update. It also has no explicit user-choice priority.
- The reviewed client contract did not provide a confirmed general mapping from a live message to its committed entry ID. The repair must establish a reliable mapping for thinking and activity boundaries.

These mechanisms explain how choices can be lost. They do not prove that every user-observed collapse has the same cause. When the live-tail condition remains true, the reviewed frontend does not render an outer process group for that tail. The exact layer and event sequence in the user's report were not captured.

The prior isolated React experiment showed that an unchanged key preserves state, while a changed key or rendering path can reset it. That experiment was a mechanism check, not an end-to-end test of this repair.

## Required behavior

```text
User selects open or closed
            |
            v
Session-view memory state <---- stable source identity
            |
            +---- process activity container
            +---- thinking source block
            +---- toolCallId
            +---- tool-group boundary
            |
            v
Restore choice after update, remount, or live/committed transition
```

- Keep explicit user choices above default and automatic opening rules.
- Preserve choices when thinking, tool input, partial output, or final results change.
- Preserve choices when a group grows or a single tool becomes a group.
- Preserve child choices when an outer process group or tool group closes and opens again.
- Preserve choices across live/idle changes and streaming-to-committed transfer.
- Use stable entry, source-block, tool, and activity-boundary identities. Do not use array positions, member counts, content comparison, or optional timestamps to guess message identity.
- Keep choices in the session view's memory. Do not add localStorage or cross-page persistence. Do not transfer choices to unrelated sessions.
- Keep paging, lazy detail loading, and the local layout in which assistant text stays visible.

## Implementation evidence

The file list and design come from the coder's completion report. The following verification section records the verifier's actual results.

| Changed files | Design or coverage |
| --- | --- |
| `components/TranscriptExpansion.tsx` (new) | Session-view memory store with `user` and `auto` records. Explicit user choices take priority. Nested providers use the same store. |
| `components/ChatWindow.tsx` | Stable activity identity uses the anchor entry ID and the preceding text's source entry ID and block index. Live and idle views use a common activity container. Text stays separate and visible. Detail bodies remain lazy. |
| `components/MessageView.tsx` | Tools use `toolCallId`. Groups use the first tool ID and preserve the visibility of open children. Tool input choices also persist. Restored deferred thinking loads through an effect with the original entry ID and source block index. Memo comparisons include the new state inputs. |
| `lib/chat-transcript-plan.ts`, `lib/message-display.ts` | Carry stable activity and source-block identity through transcript planning and display. |
| `lib/session-sync.ts`, `lib/rpc-manager.ts` | Carry the runtime message identity into HTTP live snapshots; preserve SSE message identity with the web stream namespace. |
| `hooks/useAgentSession-stream.ts`, `hooks/useAgentSession.ts` | Read identities from updates, message end events, and snapshots. Map tool-bearing assistant messages to a canonical tool identity. Transfer thinking source-block choices in a layout effect. |
| `components/ChatWindow.expansion.test.mjs` (new), `lib/chat-transcript-plan.test.mjs`, `lib/rpc-manager.test.mjs`, `hooks/useAgentSession.rpc.test.mjs` | Add component, planning, RPC, and state-machine behavior coverage. Final affected component suites pass; other selected suites passed in the first combined run. |
| `components/MessageView.test.mjs` | Replace wall-clock timing in the existing StrictMode Markdown-copy feedback test with the repository's Node mock timers. Keep exact clipboard and **Copied** checks, and check return to **Markdown** after 1500 ms. Production copy code is unchanged. |

### Streaming identity boundary

OMP `18.7.0` already sends a `messageId` such as `msg-N` through `RpcSessionEventForwarder`. This ID is a counter within the runtime process. It is not a persisted entry ID and does not identify initial history. The local HTTP snapshot now exposes `streamingMessageId`; SSE retains the runtime `messageId` with `web.streamId` as its namespace.

Tool IDs are shared by RPC events and persisted history. For an assistant message with tools, the first `toolCallId` supplies its canonical identity. The hook can therefore transfer its tool and thinking choices on commit without comparing content or timestamps.

For a message with only thinking and text, the runtime does not supply a reliable mapping to its persisted entry ID. The coder reports that this cross-entry transfer remains uncovered and that Main limited the implementation to avoid changes to external OMP. This is an acceptance gap relative to the full target above. Do not describe all streaming thinking transitions as fixed.

The verifier observed both commit orders. In the history-first order, committed history and streaming content appear together before `message_end`. After `message_end`, only the committed view remains, with its open choice preserved. In the end-first order, streaming content disappears before history arrives; the first committed view restores the open choices. These existing display-timing limits remain. Choice restoration passes for tool-bearing messages; duplicate-free or gap-free display was not established.

## Verification evidence

All checks below were executed by `ExpansionVerifier` in `D:/Code/ompweb`, with Node `v24.11.1` and npm `11.6.2`. The reporter did not run checks.

### Executed commands

| Command | Actual result |
| --- | --- |
| `node --experimental-strip-types --test components/ChatWindow.expansion.test.mjs components/MessageView.test.mjs lib/chat-transcript-plan.test.mjs lib/rpc-manager.test.mjs hooks/useAgentSession.rpc.test.mjs hooks/useAgentSession-sync.test.mjs` | Exit 1; 269 tests, 268 passed, one Markdown-copy feedback failure. The 216 tests outside the two affected component suites passed. Duration: 142.61 s. |
| `npm run typecheck` | Exit 0; no TypeScript diagnostics. Repeated successfully after the final production revisions. |
| `npm run lint` | Exit 0; zero errors and 11 warnings. The edited ChatWindow's unused `bIdx` was removed. The other ten warnings are in files outside this repair's edited production files; no baseline comparison was run. Duration: 128.07 s. |
| `node --experimental-strip-types --test components/ChatWindow.expansion.test.mjs components/MessageView.test.mjs` | Timed out at 120 s after the timer-fixture revision froze Testing Library's `waitFor`. ChatWindow's ten tests printed pass. The fixture was corrected. |
| `node --experimental-strip-types --test components/MessageView.test.mjs` | Final exit 0; 43/43 passed, zero failures. Duration: 1.77 s. |
| `npm run typecheck && node node_modules/eslint/bin/eslint.js components/ChatWindow.tsx components/MessageView.tsx components/MessageView.test.mjs components/ChatWindow.expansion.test.mjs` | Exit 0; typecheck clean. Lint reported an unused `waitFor` import, which the coder then removed. |
| `node --experimental-strip-types --test components/ChatWindow.expansion.test.mjs` | Final exit 0; 10/10 passed, zero failures, including resolved-cache thinking reopen. Duration: 2.11 s. |
| `node node_modules/eslint/bin/eslint.js components/ChatWindow.tsx components/MessageView.tsx components/MessageView.test.mjs components/ChatWindow.expansion.test.mjs` | Final exit 0; no output. Duration: 3.05 s. |

The final affected suites pass 53/53 in two independent runs. There was no single final 269/269 rerun and no full `npm test` run.

### Findings corrected during verification

- The actual AppShell smoke found deferred thinking stuck at **Loading** after a resolved-cache remount. Setting content triggered effect cleanup before `finally` cleared loading. The coder moved content/error and loading updates into the success/error handlers. The final component test and browser reopen passed; the browser used one detail request.
- The first combined run's StrictMode Markdown-copy test expected **Copied** but read **Markdown** after 4861 ms. Production feedback lasts 1500 ms. Scheduling delay is `[INFERENCE]`, not a confirmed cause. The coder used the repository's Node mock timers. The first timer revision then froze `waitFor` and timed out. The final fixture flushes promises within `act`, directly checks exact clipboard content and **Copied**, then advances 1500 ms and checks **Markdown**. Production copy code was unchanged.

### Actual browser smoke

Managed Chromium opened the repository's real Next AppShell at `http://127.0.0.1:30178/?session=expansion-smoke`. Browser-only `fetch` and `EventSource` fixtures drove `useAgentSession` and the real transcript components. This was not a minimal React demonstration.

| Scene | Observed result |
| --- | --- |
| Open process details, thinking, and one read tool | `aria-expanded` was true; detail content was visible. |
| Close and reopen the outer group | Child open choices remained. A 180 ms deferred request used `entries/smoke-assistant-1/thinking?blockIndex=0`. After the cache fix, reopen restored the correct text with one request. |
| Replace history: one tool becomes two, then three, then four | The original tool stayed open after the new wrapper and growth to three. A manually closed group stayed closed on growth to four. Assistant text stayed visible. |
| SSE live/idle and tool execution updates | Manual outer and group closed choices stayed closed. With automatic tool opening enabled, a manually closed tool stayed closed on later execution start/update. |
| Prepend 60 historical messages and load earlier content | Catch-up consumed three bounded HTTP pages of 25/25/12 items. Existing outer/thinking open choices and tool closed choices survived shifted indices. **Scroll up to load earlier messages** revealed the eleven hidden messages without resetting choices. |
| Live thinking updates, then native tool ID adoption | Thinking stayed open at the same native message identity and when the message acquired its tool ID. |
| History-first commit | After `message_end` and `agent_end`, outer, thinking, and tool were open without another click. The pre-end duplicate display remains as described above. |
| Message-end-first commit | After delayed history arrived, the first committed idle view had outer, thinking, and tool open. The pre-history display gap remains as described above. |
| Fixture browser errors and normal root | The fixture recorded no browser errors. After fixture disposal, `/` rendered AppShell/new-session UI with no observed JavaScript crash. Some GET/update requests were aborted; no prompt or session selection was performed. |

### Coverage and isolation limits

- Pure thinking/text with no tool ID has no reliable cross-entry commit mapping. Same-live-message updates pass; pure no-tool submission continuity is unsupported and unverified.
- Browser deferred loading used source block index 0. Changed source-block subsets and indices were covered by component tests, not a second browser scene.
- Session-host separation, filtering, and paging remounts were covered by component tests. No actual branch, fork, compaction, or real LLM execution was attempted.
- Browser fixtures intercepted every fixture API request and EventSource. No real `/api/agent/new` or prompt request was sent.
- Server environment isolation was attempted with `PI_CODING_AGENT_DIR` and a disabled `OMP_WEB_OMP_BIN`, but it did not establish isolation. The unmocked root later displayed real project/session metadata and the OMP version. Only browser fixture isolation is evidenced. No keys were directly read or output, and no prompt or session mutation was performed.
- Google font downloads failed in development; Next used fallback fonts. No configuration was changed.

### Screenshot evidence

The verifier recorded these temporary screenshots. They were not copied into the repository.

- `C:/Users/ASUS/AppData/Local/Temp/omp-sshots-159c16b2c77ebb26.webp`: expanded historical thinking, four-tool group, shifted indices.
- `C:/Users/ASUS/AppData/Local/Temp/omp-sshots-159c174dd47ebb27.webp`: history-first committed thinking and tool open.
- `C:/Users/ASUS/AppData/Local/Temp/omp-sshots-159c17a24bdc29e3.webp`: end-first committed thinking and tool open.
- `C:/Users/ASUS/AppData/Local/Temp/omp-sshots-159c17f41fe4d8b0.webp`: unmocked root AppShell.

`AGENTS.md` prohibits `next build` in the development checkout because it can damage the development `.next` state.

## Deployment status

The source repair was checked on a local Next development server. No production build, npm publish, global npm update, or production service deployment was performed. The installed global npm `0.5.1` package is not updated by this source repair.

The verifier released both browser tabs, cleared fixture storage, and created no repository smoke fixture files. Main's first normal-service start failed with `EADDRINUSE`. The verifier then confirmed its own Next process tree (`25580` → `36832`), stopped it with `taskkill 25580 /T/F`, and observed no listener on port `30178`.

Main then started `ompweb-fixed-local` with `npm run dev`, PID `45240`, at `http://127.0.0.1:30178/`. The server reported ready in 373 ms. Main's unmocked browser check saw the title **tmp-omp web** and **What should we work on**. Main took a screenshot and closed the check tab without sending a prompt or selecting a session. Main also inspected the verifier's end-first screenshot and confirmed that the outer group, thinking, and tool were expanded.

The global npm service/package associated with port `30177` was not updated. The running local source development service is distinct from that installation.

A later packaged build and installation are separate deployment work. The development checkout must not run `next build`.

## Evidence sources

- Architecture context: `local://ompweb-collapse-architect.md`.
- Full read-only architecture report: `agent://OmpwebArchitect`.
- Local development rules: `AGENTS.md`.
- Implementation completion and correction reports: messages from `ExpansionCoder`.
- Final verification report: `local://ompweb-expansion-verification.json`, plus the verifier's final process-cleanup message.
- Normal local source-service start and unmocked root check: final coordination message from Main.
