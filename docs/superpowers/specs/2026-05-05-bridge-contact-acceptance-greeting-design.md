# Bridge Contact Acceptance Greeting Design

## Goal
When a Bridge user accepts an incoming contact request, the accepter automatically sends the requester a normal direct message: `i accept your request, let's chat`.

## Behavior
- Trigger only after an incoming pending contact request is approved.
- Send the greeting from the accepting user to the original requester.
- Use the normal Bridge direct-message transport so both users see the greeting as a regular chat message.
- Approval is primary: if the greeting send fails, the contact remains approved and the UI surfaces the send error.
- Rejecting requests and manually adding contacts do not send this greeting.

## Implementation Notes
- The frontend approval orchestration already has access to the active Bridge host and request id.
- Before approval, resolve the requester node id from the pending incoming request.
- After approval succeeds, open/create the direct person conversation and call the existing Bridge send-message API with the greeting text.
- Merge returned Bridge states after approval, open, and send so the local UI updates without losing state.

## Tests
- Unit-test the request-to-greeting-target resolution helper.
- Verify it returns the requester for pending incoming requests.
- Verify it returns null for outgoing or non-pending requests.
