# ticket-compliance

Check that the change does what its ticket asks and nothing unrelated.

The ticket reference is in the run input (`ticket`). If there is no ticket,
return an empty `findings` list and say so in `notes`.

Report as findings, with `category: "ticket-compliance"`: requirements of
the ticket the change does not implement, and changes the ticket does not
justify. Cite the changed file and lines for each.
