# Journaled discussions

S2 starts by moving discussion identity, messages, status and reviewer session into the review
journal. This applies to HTTP questions, request-changes, scenario choices and Apply conversations.
Internal backward compatibility is not required. Old embedded request-change threads and snapshots
without their supported history fail explicitly. No external workspace is converted.

The event assertion boundary is now the complete review journal. Existing contracts are updated
for actual discussion events. New owner rules cover opening and recovery of a closed conversation.
Decisions, Apply execution and initiative state remain outside this slice.
