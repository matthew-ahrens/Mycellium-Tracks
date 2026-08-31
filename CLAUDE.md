See @README.md for the full architecture, data model, what's built, and
what's still open. Read it in full before touching code - it's kept
current and is the real source of truth, not this file.

# How to work on this project

This is Matt's own cultivation tracker, actively used daily. It's not a
generic codebase - work on it the way these rules describe, not the way
you'd default to on an unfamiliar project.

**One thing at a time.** Don't bundle several unrelated changes into one
response or one plan. If Matt gives you a list of notes or several ideas
at once, don't build all of them - name what you heard, ask which one to
start with, then do that one thing before moving to the next.

**Ask before big changes.** Anything touching the database schema,
authentication, or the overall architecture (e.g. "should this support
multiple users") needs Matt's explicit go-ahead before you write code -
propose the shape, wait for confirmation. Small, contained fixes (a CSS
bug, a missing field, a broken button) don't need this - just fix them.

**Verify, don't assume.** Check the actual Supabase schema and the actual
current file contents before making claims or writing code against them.
Several real bugs in this project's history came from code assuming a
column or a CSS class existed when it didn't. If you're not sure, check
before you guess.

**When something's ambiguous, ask - don't build the most likely guess.**
A wrong guess costs more to unwind than a clarifying question costs to ask.

**Update README.md continuously, not at the end.** It's the persistent
memory between sessions - a fresh session (or a fresh chat thread) only
knows what's in this file, nothing else. Write to it the moment something
happens, not batched for later: the instant a decision gets made, a
change gets finished, a real bug gets found, or an idea comes up that
isn't getting built right now. Don't wait for a natural stopping point to
write it all up - sessions have been cut off mid-change without warning
more than once (usage limits, interrupted terminal), and anything not
already on disk in README.md at that moment is gone. When you finish
something, add it to "Built." When you find a real bug, log it under
"Known gaps" with enough detail that a future session (or a future you)
can act on it without re-discovering it. Log ideas rather than either
building them blind or letting them disappear. This is why a periodic
background job isn't the fix here - a scheduled task starts a fresh
session with no memory of the current conversation, so it can't capture
context from a thread that's still in progress. The README only stays
current if whichever session is actually live writes to it as it goes.

**Plain, direct language.** Matt prefers being told the honest tradeoff
over being told what sounds good. If something is a bigger lift than it
looks, say so plainly before starting.
