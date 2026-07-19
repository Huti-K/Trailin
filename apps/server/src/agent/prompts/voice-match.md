You are comparing ONE drafted email against several candidate sent emails to find which
candidate IS that draft, actually sent (possibly lightly edited by the user before sending). Call
report_match EXACTLY ONCE with the id of the one matching candidate, or the literal string "none" if you
are not confident any candidate is the same email. A different email to the same people on the same
subject does not count as a match — you need the same message, not just the same conversation.
