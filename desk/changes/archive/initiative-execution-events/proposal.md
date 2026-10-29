# Durable initiative execution

Research, planner and author runs must survive a Desk restart without losing a completed result
or starting another external attempt without evidence. Move run lifecycle into the initiative
journal, retain versioned execution inputs and accept only a sealed safe receipt from an inactive
attempt. Preserve Docker isolation and the owner's explicit research permission gate.

Planner and author Git effects need their own recorded identities and verified receipts. A failed
hook or a crash before recording completion leaves a visible uncertain run; recovery observes that
effect, and an owner resume can finish the same known intent without another Codex execution.
