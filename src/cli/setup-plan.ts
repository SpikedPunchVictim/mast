import { z } from 'zod';
import type { Harness, HookEvent } from './hook.js';
import { isMastCommand } from './setup-command.js';

/** Seconds, in all three harnesses. Session start builds the primer; search must stay cheap. */
const SESSION_START_TIMEOUT = 30;
const SEARCH_TIMEOUT = 5;

interface HookDef {
  readonly event: HookEvent;
  /** The harness's own name for the event, which is also the key in its hooks object. */
  readonly nativeEvent: string;
  readonly matcher?: string;
  readonly timeout: number;
}

/**
 * The hooks each harness gets. The Claude session-start group has no matcher on purpose:
 * that matches every source, including `compact`. VS Code has no search hook because its
 * docs say matchers are ignored (it would run on every tool call) and the search tool's
 * name is undocumented.
 */
export const HOOK_DEFS: Readonly<Record<Harness, readonly HookDef[]>> = {
  claude: [
    { event: 'session-start', nativeEvent: 'SessionStart', timeout: SESSION_START_TIMEOUT },
    { event: 'search', nativeEvent: 'PreToolUse', matcher: 'Grep|Glob', timeout: SEARCH_TIMEOUT },
  ],
  cursor: [
    { event: 'session-start', nativeEvent: 'sessionStart', timeout: SESSION_START_TIMEOUT },
    { event: 'search', nativeEvent: 'postToolUse', matcher: 'Grep', timeout: SEARCH_TIMEOUT },
  ],
  vscode: [{ event: 'session-start', nativeEvent: 'SessionStart', timeout: SESSION_START_TIMEOUT }],
};

export type Commands = Readonly<Partial<Record<HookEvent, string>>>;
export type PlanMode =
  | { readonly kind: 'install'; readonly commands: Commands }
  | { readonly kind: 'remove' };

export type ItemState = 'missing' | 'outdated' | 'current';
export interface PlanItem {
  readonly label: string;
  readonly state: ItemState;
}

export type PlanResult =
  | {
      readonly ok: true;
      /** The whole file's next value, or null when the file should be deleted. */
      readonly next: object | null;
      /** False means the file must not be written at all. */
      readonly changed: boolean;
      /** Install mode: the state of each hook found. */
      readonly items: readonly PlanItem[];
      /** Remove mode: how many of mast's entries were taken out. */
      readonly removedCount: number;
    }
  | { readonly ok: false; readonly problem: string };

// Zod is used to validate, not to rebuild: a parsed loose object puts its known keys
// first, which would reorder a user's file. `passThrough` validates and hands back the
// original value, so key order survives and only mast's entries are edited.
const rootShape = z.looseObject({ hooks: z.looseObject({}).optional() });
const handlerShape = z.looseObject({ command: z.string().optional() });
const groupShape = z.looseObject({ matcher: z.string().optional(), hooks: z.array(handlerShape) });
const flatEntryShape = z.looseObject({ command: z.string().optional() });

type Root = z.infer<typeof rootShape>;
type Group = z.infer<typeof groupShape>;
type FlatEntry = z.infer<typeof flatEntryShape>;

function passThrough<S extends z.ZodType>(schema: S): z.ZodType<z.infer<S>> {
  return z.custom<z.infer<S>>((value) => schema.safeParse(value).success);
}

type Read<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly problem: string };

function readTyped<S extends z.ZodType>(schema: S, value: unknown, where: string): Read<z.infer<S>> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const found = result.error.issues
      .slice(0, 3)
      .map((issue) => `${[where, ...issue.path.map(String)].join('.')}: ${issue.message}`);
    return { ok: false, problem: `unexpected structure (${found.join('; ')})` };
  }
  return { ok: true, data: structuredClone(passThrough(schema).parse(value)) };
}

function readRoot(existing: unknown): Read<Root> {
  return existing === null ? { ok: true, data: {} } : readTyped(rootShape, existing, 'file');
}

const fail = (problem: string): PlanResult => ({ ok: false, problem });

function hooksOf(root: Root): { [key: string]: unknown } {
  const hooks = root.hooks ?? {};
  root.hooks = hooks;
  return hooks;
}

/**
 * Claude Code: `hooks.<Event>` is a list of groups, each `{matcher?, hooks: [handler]}`.
 * Within a group only mast's handler is touched; a group mast empties is removed, a group
 * with other handlers keeps them.
 */
export function planClaude(existing: unknown, mode: PlanMode): PlanResult {
  const rootRead = readRoot(existing);
  if (!rootRead.ok) return fail(rootRead.problem);
  const root = rootRead.data;
  const items: PlanItem[] = [];
  let removedCount = 0;
  let changed = false;

  for (const def of HOOK_DEFS.claude) {
    const rawGroups = root.hooks?.[def.nativeEvent];
    const read = rawGroups === undefined ? null : readTyped(z.array(groupShape), rawGroups, `hooks.${def.nativeEvent}`);
    if (read !== null && !read.ok) return fail(read.problem);
    let groups: Group[] = read === null ? [] : read.data;
    const isMast = (command: string | undefined): boolean => isMastCommand(command, 'claude', def.event);
    const touched = new Set<Group>();

    if (mode.kind === 'remove') {
      for (const group of groups) {
        const kept = group.hooks.filter((h) => !isMast(h.command));
        if (kept.length === group.hooks.length) continue;
        removedCount += group.hooks.length - kept.length;
        group.hooks = kept;
        touched.add(group);
      }
      if (touched.size === 0) continue;
      groups = groups.filter((g) => !touched.has(g) || g.hooks.length > 0);
      changed = true;
      if (groups.length === 0) delete hooksOf(root)[def.nativeEvent];
      else hooksOf(root)[def.nativeEvent] = groups;
      continue;
    }

    const command = mode.commands[def.event];
    if (command === undefined) continue;
    const handler = { type: 'command', command, timeout: def.timeout };
    const found = groups.flatMap((group) => group.hooks.filter((h) => isMast(h.command)).map((h) => ({ group, h })));
    const first = found[0];
    const duplicates = found.slice(1);
    const fresh = (): Group => ({ ...(def.matcher === undefined ? {} : { matcher: def.matcher }), hooks: [{ ...handler }] });

    let state: ItemState = 'current';
    if (first === undefined) {
      groups.push(fresh());
      state = 'missing';
    } else {
      const sameHandler =
        first.h['type'] === handler.type && first.h.command === command && first.h['timeout'] === handler.timeout;
      if (!sameHandler || first.group.matcher !== def.matcher) {
        state = 'outdated';
        const ownsGroup = first.group.hooks.every((h) => isMast(h.command));
        if (ownsGroup || first.group.matcher === def.matcher) {
          Object.assign(first.h, handler);
          if (ownsGroup) {
            if (def.matcher === undefined) delete first.group.matcher;
            else first.group.matcher = def.matcher;
          }
        } else {
          // The group's matcher also scopes someone else's handler, so it cannot be edited.
          first.group.hooks = first.group.hooks.filter((h) => h !== first.h);
          touched.add(first.group);
          groups.push(fresh());
        }
      }
    }
    for (const dup of duplicates) {
      dup.group.hooks = dup.group.hooks.filter((h) => h !== dup.h);
      touched.add(dup.group);
      state = 'outdated';
    }
    groups = groups.filter((g) => !touched.has(g) || g.hooks.length > 0);
    items.push({ label: def.nativeEvent, state });
    if (state !== 'current') {
      changed = true;
      hooksOf(root)[def.nativeEvent] = groups;
    }
  }
  return { ok: true, next: root, changed, items, removedCount };
}

/** Cursor (`hooks.json`) and VS Code (`mast.json`): `hooks.<event>` is a flat list of entries. */
function planFlat(harness: 'cursor' | 'vscode', existing: unknown, mode: PlanMode): PlanResult {
  const rootRead = readRoot(existing);
  if (!rootRead.ok) return fail(rootRead.problem);
  const root = rootRead.data;
  const items: PlanItem[] = [];
  let removedCount = 0;
  let changed = false;

  if (mode.kind === 'install' && harness === 'cursor' && !('version' in root)) {
    root['version'] = 1;
    items.push({ label: 'version', state: 'missing' });
    changed = true;
  }

  for (const def of HOOK_DEFS[harness]) {
    const rawEntries = root.hooks?.[def.nativeEvent];
    const read = rawEntries === undefined ? null : readTyped(z.array(flatEntryShape), rawEntries, `hooks.${def.nativeEvent}`);
    if (read !== null && !read.ok) return fail(read.problem);
    const entries: FlatEntry[] = read === null ? [] : read.data;
    const isMast = (e: FlatEntry): boolean => isMastCommand(e.command, harness, def.event);

    if (mode.kind === 'remove') {
      const kept = entries.filter((e) => !isMast(e));
      if (kept.length === entries.length) continue;
      removedCount += entries.length - kept.length;
      changed = true;
      if (kept.length === 0) delete hooksOf(root)[def.nativeEvent];
      else hooksOf(root)[def.nativeEvent] = kept;
      continue;
    }

    const command = mode.commands[def.event];
    if (command === undefined) continue;
    const wanted: FlatEntry =
      harness === 'cursor'
        ? { command, type: 'command', ...(def.matcher === undefined ? {} : { matcher: def.matcher }), timeout: def.timeout }
        : { type: 'command', command, timeout: def.timeout };
    const found = entries.filter(isMast);
    const first = found[0];
    let state: ItemState = 'current';
    let next = entries;
    if (first === undefined) {
      next = [...entries, wanted];
      state = 'missing';
    } else {
      const same =
        Object.entries(wanted).every(([key, value]) => first[key] === value) && 'matcher' in first === 'matcher' in wanted;
      if (!same) {
        Object.assign(first, wanted);
        if (!('matcher' in wanted)) delete first['matcher'];
        state = 'outdated';
      }
      if (found.length > 1) {
        next = entries.filter((e) => e === first || !isMast(e));
        state = 'outdated';
      }
    }
    items.push({ label: def.nativeEvent, state });
    if (state !== 'current') {
      changed = true;
      hooksOf(root)[def.nativeEvent] = next;
    }
  }

  // mast.json belongs to mast outright: once its last entry goes, so does the file.
  const hooksLeft = root.hooks === undefined ? 0 : Object.keys(root.hooks).length;
  if (harness === 'vscode' && removedCount > 0 && Object.keys(root).length === 1 && hooksLeft === 0) {
    return { ok: true, next: null, changed, items, removedCount };
  }
  return { ok: true, next: root, changed, items, removedCount };
}

export const planCursor = (existing: unknown, mode: PlanMode): PlanResult => planFlat('cursor', existing, mode);
export const planVscode = (existing: unknown, mode: PlanMode): PlanResult => planFlat('vscode', existing, mode);

export function planFor(harness: Harness, existing: unknown, mode: PlanMode): PlanResult {
  if (harness === 'claude') return planClaude(existing, mode);
  return harness === 'cursor' ? planCursor(existing, mode) : planVscode(existing, mode);
}
