# Grounding Mac refresh regressions

Refs #2190 and tracker #2202 observations O02, O06, O08 and O09.

The historical Mac findings were reviewed against main revision
`ab90e69d32e99f20e7ea4ddf8219df7b15c409bb`. The following checks use synthetic
responses and the real client store/components, without shared accounts or a deployed service.

- A completed room refreshes its roster and results without navigation. Idle visible
  pages reconcile with the server every 30 seconds; pending work keeps its faster polling.
- A fresh sharing withdrawal replaces a loaded match. A denied room read clears
  cached membership/results; transient service errors preserve content for retry.
- A delayed card poll cannot replace the selected profile's card. A match read
  started before sharing withdrawal cannot restore the withdrawn cached card.
- Focus resumes polling immediately, including when a hidden WebView timer has not fired.
  Unmount removes the timer and listeners.
- Pasting a full four-digit code fills all boxes. Escape also clears the pending code.
- RFC 3339 source instants and card build dates render on the same local day;
  date-only source values remain calendar dates. The server timestamp-preservation
  change is a separate follow-up, and previously truncated dates cannot be recovered.

The first five store/paste regressions failed against the recorded main revision
before implementation. Existing build and Pair completion tests already passed on
that revision. Resume handling is a controlled lifecycle regression, not proof of
one root cause for every historical native loading symptom.

Fresh API revocation and removal of already-loaded UI are distinct boundaries.
The client changes do not modify server authorization or claim an offline data purge.

O06 remains open: the earlier missing Meet card later rendered in canceled state.
No permanent renderer absence is established. Native initial-plan delivery and
RSVP/confirmation still need an exclusive shared-client test window on the fixed
build. No shared native client, backend, account, connection, or history was changed.
