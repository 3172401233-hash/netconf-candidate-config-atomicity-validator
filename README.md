# netconf-candidate-config-atomicity-validator

验证 NETCONF candidate 配置提交、回滚和并发修改的事务正确性。

**这是一个纯内存模拟器：不连接任何真实设备，不打开 socket，不发送 NETCONF
报文。** 它用逻辑时钟（tick）确定性地复现锁超时和 confirmed-commit 计时器，
用于校验控制器在多会话并发场景下的事务逻辑是否正确。

## 模型

- 共享 `candidate` 数据存储 + `running` 数据存储，各自带单调递增版本号。
- 会话级 candidate 锁（可带超时）：一个会话无法绕过另一会话持有的锁，
  其 `edit-config` / `commit` / `discard-changes` 会被拒绝并记录 `lock-denied` 冲突。
- `edit-config` 支持 `stop-on-error` / `continue-on-error` / `rollback-on-error`；
  `rollback-on-error` 在部分失败时把 candidate 恢复到操作前快照（版本号不变）。
- `commit confirmed` 记录提交时刻的 running 快照作为回滚基线；
  计时器到期时精确恢复该基线。**关键不变量**：挂起的 confirmed commit 期间
  任何后续合法提交（普通 commit 或新的 confirmed commit）会取消/替换待回滚
  基线，因此到期回滚绝不会覆盖后续合法提交，也不会重置其他会话未提交的
  candidate 修改。

## 输出

每次操作记录到日志，提交类结果包含：候选版本（`candidateVersion`）、
运行版本（`runningVersion`）、锁冲突（`conflict: 'lock-denied'` + 持锁会话）、
回滚目标（`rollbackTarget`，即基线 running 版本号）。

## 使用

```bash
node --test   # 运行测试：并发编辑、锁超时、部分失败、confirmed commit
node demo.js  # 复现“confirmed commit 到期 vs 并发修改同一节点”场景
```

要求 Node.js >= 24.16.0，无第三方依赖。

## 示例

```js
import { TransactionValidator } from './src/validator.js';

const v = new TransactionValidator();
v.lockCandidate('A', { timeout: 40 });
v.editConfig('A', [{ path: 'interfaces.eth0.mtu', value: 9000 }]);
v.commit('A', { confirmed: true, confirmTimeout: 30 });
v.unlockCandidate('A');

// 会话 B 合法提交同一节点 —— 取消 A 的待回滚基线
v.editConfig('B', [{ path: 'interfaces.eth0.mtu', value: 4000 }]);
v.commit('B');

v.advanceTime(100); // A 的 confirm 计时器到期，但不会覆盖 B 的提交
console.log(v.getCommitResults());
```
