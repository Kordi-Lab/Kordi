# Emoji loading and playback

Noto and Blob emoji on iOS use a shared preparation repository. A request key
includes the emoji identity, asset revision, target pixel size, animation mode,
and source locations. Multiple views subscribe to one job for that key.
Cancelling one subscriber does not cancel other subscribers; the final
subscriber cancels preparation when it leaves.
Jobs replay their latest phase to late subscribers, including while persistence
is finishing after a memory-cache eviction.

The repository publishes a first frame before preparing the complete animation.
Noto displays its Unicode emoji immediately while a first frame is unavailable.
Already visible copies share a playback entry, so another copy can display its
current frame even if the repository's memory cache has evicted that animation.

Preparation runs away from the main actor, with at most four jobs, including
cache writes, active at a time. The decoded animation cache has a 32 MB budget
and the first-frame cache a 4 MB budget. These are cache budgets, not a limit on frames
retained by currently visible views.
Disk writes and pruning are serialized. Memory warnings discard repository
caches while visible playback entries retain the frames they need.

The app's cache directory contains prepared PNG frames and their individual
durations in versioned binary property lists, plus separate first-frame PNGs.
This cache contains only public emoji assets, never message attachments. It is
bounded to 128 MB and 512 entries, expires entries after 30 days, and rebuilds
corrupt entries from their source. A prepared entry is limited to 32 MB, 600
frames, and a maximum target dimension of 512 pixels. Oversized animations
retain the first-frame presentation.

One main-thread display clock updates the backing layers of matching visible
copies. Frame selection follows the original individual durations and elapsed
time, skipping late frames rather than slowing the animation. Playback stops
when there are no visible targets or the application becomes inactive. Reduced
Motion requests static images. No per-frame SwiftUI state is published.

Desktop Noto previews retain their PNG element while an independent animated
image loads. CSS replaces the still only after the animation's image load event.
Leaving the preview removes the animated element and reveals the same still.
Unicode remains visible if neither rendition can load. The existing native
image loader continues to coalesce requests.

Regression coverage includes repeated copies, subscriber cancellation, bounded
preparation, persistent cache reuse and eviction, corrupt cache recovery,
variable frame durations, joining an existing playback frame, and desktop
still-image continuity during loading and failures.
