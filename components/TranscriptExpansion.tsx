"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";

type Choice = { open: boolean; user: boolean };

interface ExpansionStore {
  get(id: string): Choice | undefined;
  snapshot(): number;
  subscribe(listener: () => void): () => void;
  set(id: string, open: boolean, user?: boolean): void;
  linkMessages(identities: ReadonlyMap<string, string>): void;
}

/** View-local choices survive lazy details, pagination and disclosure reshaping. */
function createExpansionStore(): ExpansionStore {
  const choices = new Map<string, Choice>();
  const listeners = new Set<() => void>();
  let version = 0;
  const linkedMessages = new Map<string, string>();
  return {
    get: (id: string) => choices.get(id),
    snapshot: () => version,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Move only source-block thinking choices; tool choices already have global call ids. */
    linkMessages(identities: ReadonlyMap<string, string>) {
      let changed = false;
      for (const [source, target] of identities) {
        if (linkedMessages.get(source) === target) continue;
        linkedMessages.set(source, target);
        const prefix = `thinking:${source}:`;
        for (const [id, choice] of choices) {
          if (!id.startsWith(prefix)) continue;
          const destination = `thinking:${target}:${id.slice(prefix.length)}`;
          if (!choices.get(destination)?.user) choices.set(destination, choice);
          choices.delete(id);
          changed = true;
        }
      }
      if (changed) {
        version += 1;
        for (const listener of listeners) listener();
      }
    },
    set(id: string, open: boolean, user = true) {
      const previous = choices.get(id);
      if (!user && previous?.user) return;
      if (previous?.open === open && previous.user === user) return;
      choices.set(id, { open, user });
      version += 1;
      for (const listener of listeners) listener();
    },
  };
}

const ExpansionContext = createContext<ExpansionStore | null>(null);

export function TranscriptExpansionProvider({ children, messageIdentities }: { children: ReactNode; messageIdentities?: ReadonlyMap<string, string> }) {
  const inherited = useContext(ExpansionContext);
  const [store] = useState(() => inherited ?? createExpansionStore());
  useLayoutEffect(() => {
    if (messageIdentities) store.linkMessages(messageIdentities);
  }, [store, messageIdentities]);
  return <ExpansionContext.Provider value={store}>{children}</ExpansionContext.Provider>;
}

/** Explicit container choices win; new wrappers keep already-open descendants visible. */
export function useTranscriptExpansion(id: string, defaultOpen = false, descendantIds: readonly string[] = [], rememberAutomatic = false) {
  const store = useContext(ExpansionContext)!;
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const choice = store.get(id);
  const open = choice?.open ?? (defaultOpen || descendantIds.some((child) => store.get(child)?.open));
  useEffect(() => {
    if (rememberAutomatic && defaultOpen && !choice) store.set(id, true, false);
  }, [store, id, defaultOpen, rememberAutomatic, choice]);
  const setOpen = useCallback((value: boolean) => store.set(id, value), [store, id]);
  return [open, setOpen] as const;
}

export const toolExpansionId = (toolCallId: string) => `tool:${toolCallId}`;
export const thinkingExpansionId = (messageId: string, sourceBlockIndex: number) => `thinking:${messageId}:${sourceBlockIndex}`;
