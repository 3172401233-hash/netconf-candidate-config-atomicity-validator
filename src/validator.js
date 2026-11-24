/**
 * NETCONF candidate-configuration transaction validator (pure simulation).
 *
 * Models a shared candidate datastore and a running datastore with:
 *  - session-scoped locks on the candidate datastore (with lock timeout)
 *  - edit-config error options: stop-on-error / continue-on-error / rollback-on-error
 *  - confirmed commit with a confirm timeout and an exact rollback baseline
 *  - concurrent modification detection across sessions
 *
 * Time is a logical clock (ticks) advanced explicitly via advanceTime(),
 * so lock expiry and confirm-timeout expiry are deterministic in tests.
 *
 * This module never opens a socket or talks to a real device.
 */

export class LockDeniedError extends Error {
  constructor(op, sessionId, holder) {
    super(`lock-denied: <${op}> from session "${sessionId}" blocked; ` +
          `candidate datastore is locked by session "${holder}"`);
    this.name = 'LockDeniedError';
    this.tag = 'lock-denied';
    this.holder = holder;
  }
}

export class EditError extends Error {
  constructor(path, reason) {
    super(`edit failed at "${path}": ${reason}`);
    this.name = 'EditError';
    this.path = path;
  }
}

function parsePath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new EditError(String(path), 'path must be a non-empty string');
  }
  return path.split('.');
}

function getAt(root, segments) {
  let node = root;
  for (const seg of segments) {
    if (node === null || typeof node !== 'object' || !(seg in node)) return undefined;
    node = node[seg];
  }
  return node;
}

function setAt(root, segments, value) {
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (node[seg] === null || typeof node[seg] !== 'object') node[seg] = {};
    node = node[seg];
  }
  node[segments[segments.length - 1]] = value;
}

function deleteAt(root, segments) {
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    node = node?.[segments[i]];
    if (node === null || typeof node !== 'object') return false;
  }
  const leaf = segments[segments.length - 1];
  if (!(leaf in node)) return false;
  delete node[leaf];
  return true;
}

/** Minimal schema so edit-config can fail realistically (drives partial-failure paths). */
function validateLeaf(path, value) {
  if (/\.mtu$/.test(path)) {
    if (!Number.isInteger(value) || value < 68 || value > 9216) {
      throw new EditError(path, `mtu must be an integer in [68, 9216], got ${JSON.stringify(value)}`);
    }
  }
  if (/\.enabled$/.test(path)) {
    if (typeof value !== 'boolean') {
      throw new EditError(path, `enabled must be a boolean, got ${JSON.stringify(value)}`);
    }
  }
}

export class TransactionValidator {
  constructor({ now = 0 } = {}) {
    this.now = now;
    this.running = {};
    this.candidate = {};
    this.runningVersion = 0;
    this.candidateVersion = 0;
    /** @type {{sessionId: string, expiresAt: number} | null} */
    this.lock = null;
    /**
     * Pending confirmed commit. Any later legitimate commit replaces or
     * cancels it, so an expiring timer can never clobber a newer commit.
     * @type {{sessionId: string, baseline: object, baselineVersion: number,
     *          deadline: number, generation: number} | null}
     */
    this.pendingConfirmed = null;
    this.commitGeneration = 0;
    /** @type {object[]} ordered result log, one entry per operation/timer event */
    this.log = [];
  }

  _record(entry) {
    const full = {
      at: this.now,
      candidateVersion: this.candidateVersion,
      runningVersion: this.runningVersion,
      ...entry,
    };
    this.log.push(full);
    return full;
  }

  /** Fire lock-expiry and confirm-timeout events due at the current time. */
  _sweep() {
    if (this.lock && this.now >= this.lock.expiresAt) {
      const expired = this.lock;
      this.lock = null;
      this._record({
        op: 'lock-expired',
        sessionId: expired.sessionId,
        ok: true,
        detail: `lock held by session "${expired.sessionId}" expired`,
      });
    }
    if (this.pendingConfirmed && this.now >= this.pendingConfirmed.deadline) {
      const pending = this.pendingConfirmed;
      this.pendingConfirmed = null;
      this.running = pending.baseline;
      this.runningVersion += 1;
      this._record({
        op: 'rollback',
        reason: 'confirm-timeout',
        sessionId: pending.sessionId,
        ok: true,
        rollbackTarget: pending.baselineVersion,
        detail: `confirmed commit (generation ${pending.generation}) timed out; ` +
                `running restored to baseline version ${pending.baselineVersion}`,
      });
    }
  }

  /** Advance the logical clock, firing any timers that come due. */
  advanceTime(to) {
    if (to < this.now) throw new RangeError('cannot move time backwards');
    this.now = to;
    this._sweep();
    return this.getState();
  }

  _assertNotLockedByOther(op, sessionId) {
    this._sweep();
    if (this.lock && this.lock.sessionId !== sessionId) {
      throw new LockDeniedError(op, sessionId, this.lock.sessionId);
    }
  }

  lockCandidate(sessionId, { timeout = Infinity } = {}) {
    this._sweep();
    if (this.lock && this.lock.sessionId !== sessionId) {
      return this._record({
        op: 'lock',
        sessionId,
        ok: false,
        conflict: 'lock-denied',
        holder: this.lock.sessionId,
      });
    }
    this.lock = { sessionId, expiresAt: this.now + timeout };
    return this._record({ op: 'lock', sessionId, ok: true, expiresAt: this.lock.expiresAt });
  }

  unlockCandidate(sessionId) {
    this._sweep();
    if (!this.lock) {
      return this._record({ op: 'unlock', sessionId, ok: false, error: 'no lock held' });
    }
    if (this.lock.sessionId !== sessionId) {
      return this._record({
        op: 'unlock',
        sessionId,
        ok: false,
        conflict: 'lock-denied',
        holder: this.lock.sessionId,
      });
    }
    this.lock = null;
    return this._record({ op: 'unlock', sessionId, ok: true });
  }

  /**
   * Apply edits to the candidate datastore.
   * edits: [{ op: 'merge'|'replace'|'delete', path: 'a.b.c', value? }]
   * errorOption: 'stop-on-error' | 'continue-on-error' | 'rollback-on-error'
   */
  editConfig(sessionId, edits, { errorOption = 'stop-on-error' } = {}) {
    let denied;
    try {
      this._assertNotLockedByOther('edit-config', sessionId);
    } catch (err) {
      denied = this._record({
        op: 'edit-config', sessionId, ok: false,
        conflict: err.tag, holder: err.holder,
      });
      return denied;
    }

    const snapshot = structuredClone(this.candidate);
    const applied = [];
    const failed = [];

    for (const edit of edits) {
      try {
        const segments = parsePath(edit.path);
        const op = edit.op ?? 'merge';
        if (op === 'delete') {
          if (!deleteAt(this.candidate, segments)) {
            throw new EditError(edit.path, 'target node does not exist');
          }
        } else {
          validateLeaf(edit.path, edit.value);
          setAt(this.candidate, segments, structuredClone(edit.value));
        }
        applied.push(edit.path);
      } catch (err) {
        failed.push({ path: edit.path, error: err.message });
        if (errorOption === 'rollback-on-error') {
          this.candidate = snapshot;
          return this._record({
            op: 'edit-config', sessionId, ok: false, errorOption,
            applied: [], failed,
            rolledBack: true,
            detail: 'rollback-on-error: candidate restored to pre-operation snapshot',
          });
        }
        if (errorOption === 'stop-on-error') break;
        // continue-on-error: keep going
      }
    }

    const changed = applied.length > 0;
    if (changed) this.candidateVersion += 1;
    return this._record({
      op: 'edit-config', sessionId, ok: failed.length === 0, errorOption,
      applied, failed,
      partial: applied.length > 0 && failed.length > 0,
    });
  }

  /**
   * Commit candidate into running.
   * confirmed: start/extend a confirmed commit; confirmTimeout in ticks.
   * A plain (non-confirmed) commit finalizes any pending confirmed commit,
   * so its rollback timer is cancelled and can never revert this commit.
   */
  commit(sessionId, { confirmed = false, confirmTimeout = null } = {}) {
    try {
      this._assertNotLockedByOther('commit', sessionId);
    } catch (err) {
      return this._record({
        op: 'commit', sessionId, ok: false,
        conflict: err.tag, holder: err.holder,
      });
    }
    if (confirmed && (confirmTimeout === null || confirmTimeout <= 0)) {
      return this._record({
        op: 'commit', sessionId, ok: false,
        error: 'confirmed commit requires a positive confirmTimeout',
      });
    }

    const baseline = structuredClone(this.running);
    const baselineVersion = this.runningVersion;
    this.running = structuredClone(this.candidate);
    this.runningVersion += 1;
    this.commitGeneration += 1;

    if (confirmed) {
      this.pendingConfirmed = {
        sessionId,
        baseline,
        baselineVersion,
        deadline: this.now + confirmTimeout,
        generation: this.commitGeneration,
      };
      return this._record({
        op: 'commit', sessionId, ok: true, confirmed: true,
        rollbackTarget: baselineVersion,
        confirmDeadline: this.pendingConfirmed.deadline,
      });
    }

    // A legitimate follow-up commit finalizes the configuration: any pending
    // confirmed-commit rollback is cancelled rather than allowed to overwrite
    // this newer commit when its timer expires.
    const cancelledPending = this.pendingConfirmed !== null;
    this.pendingConfirmed = null;
    return this._record({
      op: 'commit', sessionId, ok: true, confirmed: false,
      cancelledPendingConfirmed: cancelledPending,
    });
  }

  /** cancel-commit: revert immediately to the pending baseline. */
  cancelCommit(sessionId) {
    this._sweep();
    if (!this.pendingConfirmed) {
      return this._record({
        op: 'cancel-commit', sessionId, ok: false,
        error: 'no confirmed commit in progress',
      });
    }
    const pending = this.pendingConfirmed;
    this.pendingConfirmed = null;
    this.running = pending.baseline;
    this.runningVersion += 1;
    return this._record({
      op: 'cancel-commit', sessionId, ok: true,
      rollbackTarget: pending.baselineVersion,
    });
  }

  /** discard-changes: reset candidate to running. */
  discardChanges(sessionId) {
    try {
      this._assertNotLockedByOther('discard-changes', sessionId);
    } catch (err) {
      return this._record({
        op: 'discard-changes', sessionId, ok: false,
        conflict: err.tag, holder: err.holder,
      });
    }
    this.candidate = structuredClone(this.running);
    this.candidateVersion += 1;
    return this._record({ op: 'discard-changes', sessionId, ok: true });
  }

  getState() {
    return {
      now: this.now,
      running: structuredClone(this.running),
      candidate: structuredClone(this.candidate),
      runningVersion: this.runningVersion,
      candidateVersion: this.candidateVersion,
      lock: this.lock ? { ...this.lock } : null,
      pendingConfirmed: this.pendingConfirmed
        ? {
            sessionId: this.pendingConfirmed.sessionId,
            baselineVersion: this.pendingConfirmed.baselineVersion,
            deadline: this.pendingConfirmed.deadline,
            generation: this.pendingConfirmed.generation,
          }
        : null,
    };
  }

  /** All commit/rollback results, the primary output of the validator. */
  getCommitResults() {
    return this.log.filter(
      (e) => e.op === 'commit' || e.op === 'rollback' || e.op === 'cancel-commit',
    );
  }

  getLockConflicts() {
    return this.log.filter((e) => e.conflict === 'lock-denied');
  }
}
