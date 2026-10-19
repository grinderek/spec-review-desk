# Owner decisions and patch completion

S2 moves owner decisions and review patch lifecycle into explicit review events. A chosen decision
must survive a failed Git command. A materialized patch must remain unconfirmed until Desk verifies
the resulting commit. Neither a lost YAML view nor a repeated owner request may create a second
choice or a second commit.

The change covers owner and agent-raised questions, scenario choice discussions, dismissal,
reattachment, whole-scope decision recording, patch rejection/recheck/application and resolving
scenario decisions through a confirmed patch. There is no snapshot import or legacy writer.

The executable rules live under `features/`. S4 still owns agent attempts, startup reconciliation
and migration of the remaining managed Git operations to the shared effect protocol.
