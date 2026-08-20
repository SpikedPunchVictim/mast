// Resolving a pinned OSS corpus for the `clone` scenario family.
//
// The fixture project is a definition materialised from `projects/*.mjs`. A corpus is a real
// repository at a real commit, which raises three questions the fixture never had to answer:
// where does it come from, how do we know it is the right one, and what happens when it is not
// available. This module answers all three in one place.
//
// THE PIN IS NOT REDEFINED HERE. It is imported from `eval/pins.mjs`, which is where the E1
// registration committed it. Two literals that agree today is S-05, and a corpus SHA is the
// worst place for it: at the wrong commit every frozen golden is silently invalid rather than
// loudly broken (`eval/paths.mjs` records this — `chunk_id` is `sha256(path + start_line)`, so
// line drift alone breaks frozen targets).
//
// UNAVAILABLE IS SKIP, NEVER PASS. A corpus needs a network on a cache miss. A release runner
// with no network must not report a green that silently excludes the whole family — that is S-07
// one level up from the zero-scenario guard, which is why `--forbid-skip` exists in run.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PINS } from '../../eval/pins.mjs';

/** Where eval already keeps its worktrees. Checked first, never written to. */
const EVAL_WORKTREE_ROOT = join(homedir(), '.cache', 'mast-eval', 'e1-wt');

/** Where THIS harness keeps corpora it cloned itself. Written to; safe to delete. */
const HARNESS_CORPUS_ROOT = join(homedir(), '.cache', 'mast-eval', 'integration-corpus');

/** Written only after a clone has fully completed. Its presence is the completion signal. */
const MARKER = '.mast-corpus-ok';

const CLONE_URLS = {
  n8n: 'https://github.com/n8n-io/n8n.git',
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Is `dir` a git checkout sitting exactly at `sha`, with nothing modified?
 *
 * These are the two checks `assertCorpusPinned` (`eval/e1-common.mjs`) performs, PORTED rather
 * than imported — deliberately. There, a failure is a hard gate error that stops an experiment.
 * Here it must be a fallthrough to the next source, because "eval's worktree is missing" is a
 * normal state for a machine that has never run an experiment, not a harness failure.
 */
export function isCleanCheckoutAt(dir, sha) {
  if (!existsSync(dir)) return 'it does not exist';
  let head;
  try {
    head = git(['-C', dir, 'rev-parse', 'HEAD']);
  } catch (err) {
    // The overwhelmingly likely cause, and the reason this is a fallthrough rather than a throw:
    // eval's n8n entry is a WORKTREE whose parent repository lives outside the cache (measured
    // 2026-08-20: `~/temp/enterprise-apps/n8n`). Delete the parent and every git command in the
    // worktree fails while the files sit there looking perfectly usable.
    return `it is not usable as a git checkout (${String(err.message ?? err).split('\n')[0]})`;
  }
  if (head !== sha) return `it is at ${head}, not the pinned ${sha}`;
  const dirty = git(['-C', dir, 'status', '--porcelain']);
  if (dirty !== '') return `it is dirty:\n${dirty.split('\n').slice(0, 10).join('\n')}`;
  return null;
}

/**
 * A harness-owned clone is usable only if ALL FOUR hold: the marker exists, the marker names the
 * pin, HEAD is the pin, and the tree is clean.
 *
 * The marker is what makes a TORN clone undetectable-as-usable impossible. A crash partway
 * through `git fetch` leaves a directory full of plausible files and no marker, and without the
 * marker check a half-corpus would be indexed and its (short) file count read as the truth —
 * S-07 exactly, and the failure would look like a mast defect rather than a cache defect.
 *
 * Exported so the torn-clone case can be exercised directly: on a machine where every corpus is
 * already cached, the fallback paths are otherwise unreachable and would ship unobserved.
 */
export function harnessCloneState(dir, sha) {
  const marker = join(dir, MARKER);
  if (!existsSync(marker)) return 'no completion marker — a previous clone did not finish';
  const recorded = readFileSync(marker, 'utf-8').trim();
  if (recorded !== sha) return `marker records ${recorded}, not the pinned ${sha}`;
  return isCleanCheckoutAt(dir, sha);
}

function cloneAt(url, sha, dest, log) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  log(`[corpus] cloning ${url} at ${sha.slice(0, 12)} (network) — this is slow and happens once`);
  git(['init', '--quiet'], dest);
  git(['-C', dest, 'remote', 'add', 'origin', url]);
  git(['-C', dest, 'fetch', '--depth', '1', '--quiet', 'origin', sha]);
  git(['-C', dest, 'checkout', '--quiet', 'FETCH_HEAD']);
  // LAST. Anything that throws above leaves no marker, so the next run rebuilds rather than
  // trusting a partial tree.
  writeFileSync(join(dest, MARKER), `${sha}\n`);
}

/**
 * Resolve a corpus by name.
 *
 * @returns `{ root, sha, source }` when usable, or `{ skip: <reason> }` when it is not. NEVER
 *   throws for an absent corpus — a missing corpus is an environment fact, and the caller turns
 *   it into a SKIP. It DOES throw for an unknown corpus name, which is a typo in a scenario and
 *   must not silently narrow the suite.
 */
export function resolveCorpus(name, { log = () => {}, allowClone = true } = {}) {
  const pin = PINS[name];
  if (pin === undefined) {
    throw new Error(`unknown corpus '${name}' — known: ${Object.keys(PINS).join(', ')}. A typo'd corpus would silently skip the family it belongs to.`);
  }
  const sha = pin.sha;

  const evalWorktree = join(EVAL_WORKTREE_ROOT, name);
  const evalProblem = isCleanCheckoutAt(evalWorktree, sha);
  if (evalProblem === null) {
    log(`[corpus] ${name}: using eval worktree ${evalWorktree} at ${sha.slice(0, 12)}`);
    return { root: evalWorktree, sha, source: 'eval-worktree' };
  }
  log(`[corpus] ${name}: eval worktree unusable — ${evalProblem}`);

  const own = join(HARNESS_CORPUS_ROOT, `${name}-${sha.slice(0, 12)}`);
  const ownProblem = harnessCloneState(own, sha);
  if (ownProblem === null) {
    log(`[corpus] ${name}: using harness clone ${own}`);
    return { root: own, sha, source: 'harness-clone' };
  }
  log(`[corpus] ${name}: harness clone unusable — ${ownProblem}`);

  if (!allowClone) return { skip: `corpus '${name}' is not cached and cloning is disabled` };
  const url = CLONE_URLS[name];
  if (url === undefined) return { skip: `corpus '${name}' is not cached and no clone URL is known for it` };

  try {
    cloneAt(url, sha, own, log);
  } catch (err) {
    // Offline, rate-limited, DNS, a withdrawn commit — all the same outcome to a scenario: it
    // cannot run. The git error travels verbatim into the SKIP reason so the cause is diagnosable
    // from the results artifact alone.
    rmSync(own, { recursive: true, force: true });
    return { skip: `corpus '${name}' could not be cloned: ${String(err.message ?? err).split('\n')[0]}` };
  }
  const problem = harnessCloneState(own, sha);
  if (problem !== null) return { skip: `corpus '${name}' cloned but ${problem}` };
  return { root: own, sha, source: 'harness-clone-fresh' };
}

/**
 * Re-assert that a corpus the harness only ever READ is still untouched.
 *
 * Called after any scenario that mutated a working copy hardlinked from it. A difference here is
 * a HARNESS fault (ERROR), never a mast fault: mast is never pointed at the cache. This is the
 * belt to `writeUnlinked`'s braces (`lib/mutations.mjs`), and it exists because the failure it
 * catches is silent, shared across every later run, and survives the process.
 */
export function assertCorpusUntouched(corpus) {
  const problem = isCleanCheckoutAt(corpus.root, corpus.sha);
  if (problem !== null) {
    throw new Error(
      `the pinned corpus at ${corpus.root}: ${problem}. A scenario wrote THROUGH a hardlink into the shared cache: ` +
      `every later run over this corpus is now reading mutated source. Delete it and re-resolve.`,
    );
  }
}

export function knownCorpora() {
  return Object.keys(PINS);
}
