import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionValidator } from '../src/validator.js';

const IFA = 'interfaces.eth0';
const IFB = 'interfaces.eth1';

test('concurrent edits: a session cannot bypass a lock held by another session', () => {
  const v = new TransactionValidator();

  assert.equal(v.lockCandidate('s1').ok, true);

  // s2 is blocked from editing and committing while s1 holds the lock.
  const edit = v.editConfig('s2', [{ path: `${IFA}.enabled`, value: true }]);
  assert.equal(edit.ok, false);
  assert.equal(edit.conflict, 'lock-denied');
  assert.equal(edit.holder, 's1');

  const commit = v.commit('s2');
  assert.equal(commit.ok, false);
  assert.equal(commit.conflict, 'lock-denied');

  // The lock owner proceeds normally.
  assert.equal(v.editConfig('s1', [{ path: `${IFA}.enabled`, value: true }]).ok, true);
  const ownerCommit = v.commit('s1');
  assert.equal(ownerCommit.ok, true);
  assert.equal(ownerCommit.candidateVersion, 1);
  assert.equal(ownerCommit.runningVersion, 1);

  // Lock conflicts are reported in the output.
  const conflicts = v.getLockConflicts();
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((c) => c.conflict === 'lock-denied' && c.holder === 's1'));
});

test('concurrent edits: lock is not stolen by unlock from another session', () => {
  const v = new TransactionValidator();
  v.lockCandidate('s1');
  const unlock = v.unlockCandidate('s2');
  assert.equal(unlock.ok, false);
  assert.equal(unlock.conflict, 'lock-denied');
  assert.equal(v.getState().lock.sessionId, 's1');
});

test('lock timeout: expired lock no longer blocks other sessions', () => {
  const v = new TransactionValidator();
  v.lockCandidate('s1', { timeout: 10 });

  v.advanceTime(5);
  assert.equal(
    v.editConfig('s2', [{ path: `${IFA}.enabled`, value: true }]).conflict,
    'lock-denied',
  );

  v.advanceTime(11); // lock (acquired at 0, ttl 10) has expired
  const edit = v.editConfig('s2', [{ path: `${IFA}.enabled`, value: true }]);
  assert.equal(edit.ok, true);
  assert.equal(v.getState().lock, null);

  // The expiry is visible in the log.
  assert.ok(v.log.some((e) => e.op === 'lock-expired' && e.sessionId === 's1'));
});

test('partial failure: rollback-on-error restores the exact pre-operation candidate', () => {
  const v = new TransactionValidator();
  v.editConfig('s1', [{ path: `${IFA}.enabled`, value: true }]);
  const before = structuredClone(v.getState().candidate);
  const versionBefore = v.getState().candidateVersion;

  const result = v.editConfig(
    's1',
    [
      { path: `${IFA}.mtu`, value: 1500 },
      { path: `${IFB}.mtu`, value: 10 }, // invalid: below minimum
      { path: `${IFB}.enabled`, value: true },
    ],
    { errorOption: 'rollback-on-error' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.deepEqual(result.applied, []);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(v.getState().candidate, before);
  assert.equal(v.getState().candidateVersion, versionBefore); // version untouched
});

test('partial failure: stop-on-error keeps prefix, continue-on-error skips bad edit', () => {
  const stop = new TransactionValidator();
  const stopResult = stop.editConfig(
    's1',
    [
      { path: `${IFA}.mtu`, value: 1500 },
      { path: `${IFB}.mtu`, value: 99999 }, // invalid
      { path: `${IFB}.enabled`, value: true },
    ],
    { errorOption: 'stop-on-error' },
  );
  assert.equal(stopResult.partial, true);
  assert.deepEqual(stop.getState().candidate, { interfaces: { eth0: { mtu: 1500 } } });

  const cont = new TransactionValidator();
  const contResult = cont.editConfig(
    's1',
    [
      { path: `${IFA}.mtu`, value: 1500 },
      { path: `${IFB}.mtu`, value: 99999 }, // invalid
      { path: `${IFB}.enabled`, value: true },
    ],
    { errorOption: 'continue-on-error' },
  );
  assert.equal(contResult.partial, true);
  assert.deepEqual(cont.getState().candidate, {
    interfaces: { eth0: { mtu: 1500 }, eth1: { enabled: true } },
  });
});

test('confirmed commit: confirm timeout rolls running back to the exact baseline', () => {
  const v = new TransactionValidator();
  v.editConfig('s1', [{ path: `${IFA}.enabled`, value: true }]);
  v.commit('s1'); // running v1: eth0 enabled

  v.editConfig('s1', [{ path: `${IFA}.mtu`, value: 9000 }]);
  const confirmed = v.commit('s1', { confirmed: true, confirmTimeout: 30 });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.rollbackTarget, 1); // baseline = running v1
  assert.deepEqual(v.getState().running, {
    interfaces: { eth0: { enabled: true, mtu: 9000 } },
  });

  v.advanceTime(31); // confirm timeout expires
  const state = v.getState();
  assert.deepEqual(state.running, { interfaces: { eth0: { enabled: true } } });
  assert.equal(state.pendingConfirmed, null);

  const rollback = v.getCommitResults().find((e) => e.op === 'rollback');
  assert.equal(rollback.reason, 'confirm-timeout');
  assert.equal(rollback.rollbackTarget, 1);
});

test('confirmed commit: expiry must not overwrite a later legitimate commit', () => {
  // The scenario from the bug report: s1 issues a confirmed commit, s2 keeps
  // editing the same node and commits legitimately; when s1's timer expires
  // the controller must NOT roll back over s2's commit.
  const v = new TransactionValidator();
  v.editConfig('s1', [{ path: `${IFA}.mtu`, value: 1500 }]);
  v.commit('s1'); // running v1

  v.editConfig('s1', [{ path: `${IFA}.mtu`, value: 9000 }]);
  v.commit('s1', { confirmed: true, confirmTimeout: 30 }); // baseline = v1

  // s2 modifies the same node and commits before the timer fires.
  v.editConfig('s2', [{ path: `${IFA}.mtu`, value: 4000 }]);
  const s2Commit = v.commit('s2');
  assert.equal(s2Commit.ok, true);
  assert.equal(s2Commit.cancelledPendingConfirmed, true);

  v.advanceTime(100); // s1's confirm deadline long past
  const state = v.getState();
  assert.deepEqual(state.running, { interfaces: { eth0: { mtu: 4000 } } });
  assert.equal(v.log.filter((e) => e.op === 'rollback').length, 0);
});

test('confirmed commit: a follow-up confirmed commit replaces the rollback baseline', () => {
  const v = new TransactionValidator();
  v.editConfig('s1', [{ path: `${IFA}.mtu`, value: 1500 }]);
  v.commit('s1', { confirmed: true, confirmTimeout: 10 }); // baseline v0 (empty)

  v.advanceTime(5);
  v.editConfig('s1', [{ path: `${IFA}.mtu`, value: 9000 }]);
  const second = v.commit('s1', { confirmed: true, confirmTimeout: 10 });
  assert.equal(second.rollbackTarget, 1); // baseline is now running v1 (mtu 1500)

  v.advanceTime(16); // second deadline (5+10) expires
  assert.deepEqual(v.getState().running, { interfaces: { eth0: { mtu: 1500 } } });
  const rollbacks = v.log.filter((e) => e.op === 'rollback');
  assert.equal(rollbacks.length, 1);
  assert.equal(rollbacks[0].rollbackTarget, 1);
});

test('cancel-commit reverts immediately to the pending baseline', () => {
  const v = new TransactionValidator();
  v.editConfig('s1', [{ path: `${IFA}.enabled`, value: true }]);
  v.commit('s1', { confirmed: true, confirmTimeout: 50 });
  const cancel = v.cancelCommit('s1');
  assert.equal(cancel.ok, true);
  assert.equal(cancel.rollbackTarget, 0);
  assert.deepEqual(v.getState().running, {});
  v.advanceTime(100);
  assert.equal(v.log.filter((e) => e.op === 'rollback').length, 0);
});

test('candidate edits by another session survive a confirmed-commit rollback', () => {
  // s1 commits confirmed; s2 edits candidate (same node) but does not commit.
  // Rollback restores running, and must leave s2's uncommitted candidate edits
  // untouched — the candidate is not reset to the old baseline.
  const v = new TransactionValidator();
  v.editConfig('s1', [{ path: `${IFA}.mtu`, value: 1500 }]);
  v.commit('s1', { confirmed: true, confirmTimeout: 20 });

  v.editConfig('s2', [{ path: `${IFA}.mtu`, value: 8000 }]);
  const candidateVersionBefore = v.getState().candidateVersion;

  v.advanceTime(25); // rollback fires
  const state = v.getState();
  assert.deepEqual(state.running, {}); // baseline restored
  assert.deepEqual(state.candidate, { interfaces: { eth0: { mtu: 8000 } } });
  assert.equal(state.candidateVersion, candidateVersionBefore);
});
