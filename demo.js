/**
 * Reproduces the reported scenario end to end:
 * two NETCONF clients edit the candidate concurrently; one issues a
 * confirmed commit; the other keeps modifying the same node; the confirm
 * timer expires. Prints candidate versions, lock conflicts and rollback
 * targets for every commit.
 *
 * Pure simulation — no real device is contacted.
 */
import { TransactionValidator } from './src/validator.js';

const v = new TransactionValidator();
const NODE = 'interfaces.eth0';

console.log('--- Scenario: confirmed commit vs. concurrent modification ---\n');

// t=0: session A locks the candidate and stages a change.
v.lockCandidate('A', { timeout: 40 });
v.editConfig('A', [{ path: `${NODE}.mtu`, value: 1500 }]);
v.commit('A'); // running v1

// Session B tries to edit while A holds the lock -> lock-denied.
v.editConfig('B', [{ path: `${NODE}.mtu`, value: 9000 }]);

// t=5: A stages another change and issues a confirmed commit (timeout 30).
v.advanceTime(5);
v.editConfig('A', [{ path: `${NODE}.mtu`, value: 9000 }]);
v.commit('A', { confirmed: true, confirmTimeout: 30 });
v.unlockCandidate('A');

// t=10: B (lock now free) modifies the SAME node and commits legitimately.
v.advanceTime(10);
v.editConfig('B', [{ path: `${NODE}.mtu`, value: 4000 }]);
v.commit('B'); // finalizes config; cancels A's pending rollback

// t=40: A's confirm deadline (5+30=35) has passed. The rollback must NOT
// fire and overwrite B's commit.
v.advanceTime(40);

console.log('Commit results:');
for (const r of v.getCommitResults()) {
  console.log(
    `  t=${r.at} ${r.op} session=${r.sessionId} ok=${r.ok}` +
      (r.rollbackTarget !== undefined ? ` rollbackTarget=v${r.rollbackTarget}` : '') +
      (r.cancelledPendingConfirmed ? ' (cancelled pending confirmed commit)' : '') +
      ` -> candidate v${r.candidateVersion}, running v${r.runningVersion}`,
  );
}

console.log('\nLock conflicts:');
for (const c of v.getLockConflicts()) {
  console.log(`  t=${c.at} ${c.op} session=${c.sessionId} blocked by lock holder "${c.holder}"`);
}

const s = v.getState();
console.log('\nFinal state:');
console.log(`  running   v${s.runningVersion}: ${JSON.stringify(s.running)}`);
console.log(`  candidate v${s.candidateVersion}: ${JSON.stringify(s.candidate)}`);
console.log(
  `\nB's legitimate commit (mtu=4000) survived the expired confirm timer: ` +
    `${s.running.interfaces?.eth0?.mtu === 4000}`,
);
