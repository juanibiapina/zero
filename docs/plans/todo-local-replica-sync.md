# Move my todo data to a complete local replica

## Decision

Use TinyBase as the complete signed-in todo store. One `TaskDO` per account owns
Tasks, Projects, manual Waiting conditions, and After
relationships. The phone keeps an account-scoped Expo SQLite TinyBase replica
and synchronizes it over an authenticated WebSocket. Web and old clients keep
using the existing REST contracts, which route to the same `TaskDO`.

TinyBase last-writer-wins is accepted when disconnected clients change the same
cell without seeing each other's edit. It is not permission to lose a row, an
invalid relationship, a terminal record, or a queued action.

**Completed 2026-09-26:** the migrated account was verified in production, and
the user confirmed that all other accounts had no todo data to import. `TaskDO`
is now the unconditional todo authority for every account. The migration marker,
operator endpoint, and legacy todo RPC surface were removed. `UserDO` remains
the authority for agent conversations and other non-todo state; its old todo
tables were not deleted.

## Cutover implementation (historical)

- `UserDO` stores a durable `legacy` / `frozen` / `switched` authority marker.
  Every legacy todo mutation checks that marker inside the Durable Object, so a
  request that raced the freeze cannot write afterward.
- The operator-only migration endpoint prepares, switches, or aborts one import
  generation. Prepare freezes the source, reads every row including completed,
  Done, and resolved rows, imports stable IDs into an inaccessible `TaskDO`, and
  compares every persisted field. A failed pre-switch import can be discarded
  and the unchanged source unfrozen.
- Switch activates the verified destination before changing routing. If the
  operation is interrupted between those writes, retry rolls forward; it never
  creates two writable authorities.
- All todo REST reads and writes consult the authority marker. Old web/mobile
  REST callers therefore write to `TaskDO` after the switch without knowing
  about TinyBase.
- Mobile fetches and caches the account's authority. A switched account renders
  every todo screen from one account-named TinyBase SQLite replica. Raw invalid
  relationships remain stored and appear in the recovery view with local repair
  actions.
- The old mobile collections continue running behind the selected TinyBase UI.
  Their durable outbox entries replay through the unchanged REST URLs and land
  in `TaskDO`; the old cache is not another visible authority.
- Account deletion purges and locks `TaskDO` for fixture or switched accounts so
  an offline replica cannot repopulate erased data.

`UserDO` retains conversations, settings, and other non-todo data. Its old todo
tables remain a frozen recovery copy after switching. Recovery after a switch is
forward on `TaskDO`; returning to the old tables would require a separate,
verified reverse migration.

## Small proof set

Keep the proof proportional to the design. The release needs these three
end-to-end checks, not a matrix for every domain verb:

1. **Replica persistence.** On the Pixel connected to `mini`, create linked and
   loose work, Waiting/After relationships, and recurrence; force-stop, reopen
   offline, repair one deliberately invalid relationship, reconnect, and see the
   same accepted and recovery views.
2. **Convergence.** Two independent clients plus REST edit different cells and
   one shared cell, disconnect/reconnect, and converge. The shared cell uses the
   accepted last-writer-wins result; no row or relationship disappears.
3. **Preserving switch.** A disposable legacy account containing open and
   terminal rows plus a queued old-client REST action is prepared, interrupted
   once between destination activation and routing, retried, and compared
   field-for-field. The queued action then reaches `TaskDO`, and another account
   cannot read the data.

Package tests and typechecks remain useful regression checks. Do not add a
separate fixture seeder or a behavior flow for every endpoint. Run
`gob run bin/ci`; where host `workerd` cannot start, use the touched-package
checks and the Podman-backed Pixel harness on `mini`.

## Real-account switch

A separate authorization is required. Then:

1. Deploy the prepared Worker while the account remains `legacy`.
2. Let known old clients come online so their current queues can start replaying.
3. Prepare the account with a unique generation. Todo writes visibly retry while
   the source is frozen.
4. Inspect the field-for-field result and switch the same generation.
5. Open the updated phone online once, then run the persistence check offline
   and compare representative REST/server records.
6. Keep the frozen source and old phone files until the result is accepted.

There is no fleet migration, cohort machinery, guest mode, or new sync protocol.
Changing sync libraries or switching a real account needs a new explicit
decision.

## Branch evidence (2026-09-25)

- `gob run bin/ci` passed the full repository pipeline, including lint,
  typechecks, builds, package tests, and deploy dry-runs.
- The Pixel 7 TaskDO harness on `mini` passed offline restart, REST-to-phone
  synchronization, and linked Project/Task offline restart in 473 seconds.
- The existing two-client and real-Worker proofs establish independent-cell
  merge and accepted same-cell last-writer-wins convergence.
- A disposable real Worker imported one completed Task, one Done Project, and
  one resolved Waiting row with exact parity. A write during freeze was rejected;
  retrying the identical old REST request after switching created it in TaskDO.
  The route test also interrupts the switch after destination activation and
  proves that retry rolls forward.

This evidence preceded the later authorized production switch described above.
