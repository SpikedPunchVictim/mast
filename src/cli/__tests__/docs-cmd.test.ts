import { describe, it, expect } from 'vitest';
import { DOC_TOPICS, readDoc, listDocs, DocsError } from '../docs-cmd.js';
import { listRegisteredToolNames } from '../query.js';
import { CLI_VERSION } from '../version.js';

describe('readDoc', () => {
  it('returns content for every advertised topic', () => {
    for (const topic of DOC_TOPICS) {
      expect(readDoc(topic.name).length, `${topic.name} is empty`).toBeGreaterThan(0);
    }
  });

  /**
   * `mast query` answers an unknown tool by listing the real ones. An unknown topic
   * should cost the caller the same single round trip.
   */
  it('names the available topics when asked for one that does not exist', () => {
    expect(() => readDoc('nope')).toThrow(DocsError);
    try { readDoc('nope'); } catch (e) {
      for (const t of DOC_TOPICS) expect((e as Error).message).toContain(t.name);
    }
  });
});

describe('listDocs', () => {
  /**
   * The reason this command exists is that a user should not have to work out which
   * released docs match the binary they have. The listing therefore states the version.
   */
  it('states the version the docs belong to', () => {
    expect(listDocs()).toContain(CLI_VERSION);
  });

  it('describes every topic it offers', () => {
    const out = listDocs();
    for (const t of DOC_TOPICS) {
      expect(out).toContain(t.name);
      expect(out).toContain(t.summary);
    }
  });
});

/**
 * The skill text and the tool registry are two producers of one list (shape S-05).
 * If a tool is added, renamed, or removed and the skill is not updated, every agent
 * pasting it is told about a surface that no longer exists — or never hears about a
 * new one. This is the guard that makes that impossible to ship.
 */
describe('the skill text matches the tools that actually exist', () => {
  const skill = readDoc('skill');
  const registered = listRegisteredToolNames();

  it('registers at least one tool, so an empty registry cannot vacuously pass', () => {
    expect(registered.length).toBeGreaterThan(0);
  });

  it.each(registered)('documents %s', (name) => {
    expect(skill).toContain(name);
  });

  it('mentions no tool that is not registered', () => {
    const mentioned = [...new Set(skill.match(/\bmast_[a-z_]+\b/g) ?? [])];
    expect(mentioned.sort()).toEqual([...registered].sort());
  });
});
