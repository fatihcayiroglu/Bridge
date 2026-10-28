# P7 Wayland surface acknowledgement evidence

The previous acceptance predicate independently searched for a seat, a
`get_toplevel` request and any `ack_configure`. A log containing a role request
on surface 14 and an acknowledgement on surface 99 passed. The new regression
failed against that original implementation before the correction was made.

The predicate now tracks each surface object in protocol order using POSIX awk.
An acknowledgement qualifies only after that same object acquired a toplevel
role. Destroying the object or assigning a popup role removes that association;
an object ID reused for a new toplevel may qualify again. Both @ and # notation
remain supported. The parser consumes the complete file without a pipe.

The existing positive, negative and closed-summary privacy controls remain.
The local GNU Bash suite passed 5 positive, 11 negative and 1 privacy controls,
with zero skipped controls. These fixtures prove the predicate behavior, not
that a compositor or physical desktop worked. Real packaged native Wayland
acceptance is required separately.

Desktop CI now runs for stacked PRs as well as main/develop candidates and
checks out the exact PR head on all three operating systems. It retains the
existing six independent Weston sessions, 60-second deadline, client DISPLAY
isolation, Chromium sandbox and non-publishing package builds. No retries,
assertion reductions or X11 substitution are introduced. The patched local
deepmerge dependency is inherited from the separate root security candidate.

This corrects a possible false-positive acceptance result. It does not establish
the cause of the historical intermittent #416 startup failure. Physical
GNOME/KDE UX, production signing and reviewer acceptance remain outstanding.
#416 and P7 stay open; no production merge or deployment is authorized here.
