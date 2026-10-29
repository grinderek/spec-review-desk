# Initiative business events

Initiative metadata, brief, input acceptance, research permissions and slice plans currently depend
on mutable files. Move those decisions into an initiative journal so loss of a materialized view
does not lose the owner's scope, plan or source material. Internal snapshot compatibility is not
required. Existing workspaces without the journal are not imported automatically.

Keep the current HTTP operations and public workflow. Runs still use the mixed YAML snapshot until
S4. New executable contracts observe initiative event deltas explicitly, while owner decisions
continue to observe their review stream and permissions through subsequent GETs.
