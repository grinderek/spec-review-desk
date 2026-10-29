# Durable question and Apply execution

Desk currently loses queued questions on restart and treats a process PID or streamed log as
execution outcome. Persist request and attempt identity before dispatch, retain a terminal receipt
outside the server process, and accept the receipt and its review consequences together.

The first S4 slice covers reviewer questions and Apply. Both public Apply continuation paths obey
the same recorded-owner-decision and current-approval gates. Unknown outcome blocks conflicting
work until explicit recovery or continuation. Initiative runs and verification are separate slices;
this change does not claim S4-S7 are complete.
