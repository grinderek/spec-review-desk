# Show agent usage without inventing charges

#### Scenario: Keep unreported token usage and actual billing unknown

After an agent attempt without CLI token usage, the usage API reports one completed attempt with unknown usage and actual billing. It never substitutes zero for an unknown invoice or token count.

#### Scenario: Preserve the selected execution profile

Research and Apply record the profile before execution. Owner resume and validation retries use the persisted profile. Routing cannot alter approval requirements or owner decisions.

#### Scenario: Continue when the local router is unavailable

A missing, timed-out or invalid Kev response selects Sol/high and records the fallback reason. The run uses existing scoped tools and approval gates.
