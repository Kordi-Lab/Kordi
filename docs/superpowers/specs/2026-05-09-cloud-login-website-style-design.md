# Cloud Login Website Style Design

## Goal
Make the Cloud Edition account gate simple and visually aligned with the Kordi AI website PR (#201), while preserving the product rule that Cloud users log into Kordi before model-provider setup.

## Visual Direction
Use the website’s warm paper surface, ink text, soft borders, and three-circle cyan/magenta/yellow Kordi paint mark. Avoid the current dark glass, heavy gradients, dense explanatory cards, and generic AI/neon treatment.

## Layout
Render a compact Codex-style native login window instead of the normal full app frame. The whole window uses the warm PR #201 paper surface; do not add a dark outside backdrop or an inner card shell. The centered content contains the paint mark, “Welcome to Kordi” or “Create account,” Google/GitHub/X sign-in placeholders, tabs, fields, primary button, and one short note: “Model setup comes next.” Sign-up mode includes avatar upload and random avatar controls.

## Behavior
Keep the existing preview-only state: tabs switch locally, avatar upload/random preview is local UI state, the form prevents submit, and auth controls remain disabled until server/session endpoints are implemented. The root Cloud gate behavior remains unchanged. In native runtime, resize and center the window for login/signup, then restore the normal app window size after auth.

## Testing
Update the Cloud login unit test to assert the website-style mark and warm/simple copy, and to ensure the old provider-heavy/dark explanatory language is gone.
