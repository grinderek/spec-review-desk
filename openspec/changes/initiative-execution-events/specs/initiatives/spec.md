# Initiative execution

#### Scenario: Create an initiative with the owner's brief

Executable contract: `features/initiatives.desk.yaml`, id `create-initiative`.

#### Scenario: Save the revised brief for future agent runs

Executable contract: `features/initiatives.desk.yaml`, id `revise-brief`.

#### Scenario: Keep an agent's slice plan as a draft until owner approval

Executable contract: `features/initiatives.desk.yaml`, id `draft-slice-plan`.

#### Scenario: Approve the slice plan before proposing changes

Executable contract: `features/initiatives.desk.yaml`, id `approve-slice-plan`.

#### Scenario: Resolve blocking owner questions before approving the plan

Executable contract: `features/initiatives.desk.yaml`, id `block-plan-approval`.

#### Scenario: Propose a ready slice as a change that still needs owner review

Executable contract: `features/initiatives.desk.yaml`, id `propose-independent-slice`.

#### Scenario: Refuse a dependent slice while its prerequisite is unfinished

Executable contract: `features/initiatives.desk.yaml`, id `respect-slice-dependencies`.

#### Scenario: Accept a research draft before agents can use it as an input

Executable contract: `features/initiatives.desk.yaml`, id `accept-research-input`.

#### Scenario: Propose a dependent slice once its prerequisite is owner approved

Executable contract: `features/initiatives.desk.yaml`, id `propose-after-prerequisite-approval`.

#### Scenario: Resume research with the reading permission chosen by the owner

Executable contract: `features/initiatives.desk.yaml`, id `respect-research-permission`.

#### Scenario: Restore the approved plan and research material from initiative history

Executable contract: `features/initiatives.desk.yaml`, id `restore-initiative-business-state`.

#### Scenario: Discard research without accepting it as agent input

Executable contract: `features/initiatives.desk.yaml`, id `discard-research-draft`.

#### Scenario: Record the owner's allowed research domains

Executable contract: `features/initiatives.desk.yaml`, id `research-domain-permission`.

#### Scenario: Recover completed research from its receipt without running the agent again

Executable contract: `features/initiatives.desk.yaml`, id `recover-recorded-research-result`.

#### Scenario: Keep unconfirmed research uncertain until the owner chooses what to do

Executable contract: `features/initiatives.desk.yaml`, id `uncertain-research-requires-owner`.

#### Scenario: Start another research attempt only after the owner explicitly resumes

Executable contract: `features/initiatives.desk.yaml`, id `owner-resumes-uncertain-research`.

#### Scenario: Stop unconfirmed research after proving its execution is inactive

Executable contract: `features/initiatives.desk.yaml`, id `owner-abandons-uncertain-research`.

#### Scenario: Preserve owner plan edits when recovering an older planner result

Executable contract: `features/initiatives.desk.yaml`, id `preserve-owner-plan-after-restart`.
