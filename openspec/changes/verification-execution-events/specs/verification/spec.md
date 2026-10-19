# Verification execution

#### Scenario: Show the actual verification result for a reviewed contract

Executable contract: `features/implementation.desk.yaml`, id `display-verification-result`.

#### Scenario: A partial or foreign report cannot replace the previous successful run

Executable contract: `features/verification-recovery.desk.yaml`, id `reject-incomplete-verification`.

#### Scenario: Restart accepts an already completed verification without running it again

Executable contract: `features/verification-recovery.desk.yaml`, id `recover-verification-receipt`.

#### Scenario: Rebuilding a lost verification view preserves the recorded result and history

Executable contract: `features/verification-recovery.desk.yaml`, id `rebuild-verification-projection`.

#### Scenario: A successful verification becomes stale after its source inputs change

Executable contract: `features/verification-recovery.desk.yaml`, id `mark-verification-source-drift`.


#### Scenario: Verification waits while implementation is running in the same worktree

#### Scenario: An uncertain verification blocks implementation in its worktree

#### Scenario: An uncertain verification blocks a new Git approval commit in its worktree

#### Scenario: Restart preserves a requested rerun after accepting the previous result

#### Scenario: Stop cancels the saved rerun together with the active verification
