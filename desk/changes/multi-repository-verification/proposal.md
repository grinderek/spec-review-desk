# Verification across participating source repositories

A pilot specification checkout can exercise several independently versioned applications.
Its runner declares additional source roots. The immutable input manifest captures their
HEADs and working files as well as the specification checkout. Dispatch and acceptance
recapture the saved scope; freshness checks also compare the current configured scope.
Saved rerun requests retain their source roots. A changed component invalidates the result.

Gherkin cards render the executable step text and examples directly, so the product's
business vocabulary stays with its own rules. No parallel scenario documentation is maintained.
