#!/usr/bin/env python3
"""Check rendered bubble motion in the synthetic brief-trajectory UI recording.

Record TrajectoryExpansionUITests.testBriefConversationExpansionRecording with
simctl recordVideo on a task-owned iPhone simulator in its default light theme.
Only use synthetic preview data. Keep the recording outside the repository.
Requires ffmpeg and ffprobe; no Python packages are needed.
"""

import argparse
import json
import subprocess


def measure(recording):
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-of", "json", recording,
    ]))
    stream = next(item for item in probe["streams"] if item["codec_type"] == "video")
    width, height = stream["width"], stream["height"]
    # This column crosses both short outgoing bubbles, clear of their avatars.
    x = int(width * 0.83) // 2 * 2
    pixels = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", recording, "-vf",
        f"fps=60,crop=2:{height}:{x}:0,format=rgb24", "-f", "rawvideo", "-",
    ])
    frame_size = height * 6
    positions = []
    for frame in range(len(pixels) // frame_size):
        column = memoryview(pixels)[frame * frame_size:(frame + 1) * frame_size]
        runs = []
        start = None
        for y in range(int(height * 0.3), int(height * 0.88)):
            red, green, blue = column[y * 6:y * 6 + 3]
            outgoing_fill = blue > red + 15 and green > red + 4
            if outgoing_fill and start is None:
                start = y
            elif not outgoing_fill and start is not None:
                if y - start >= 25:
                    runs.append((start, y))
                start = None
        if len(runs) == 2:
            positions.append((runs[0][0], runs[1][0]))
    if len(positions) < 30:
        raise ValueError("The recording must show both synthetic outgoing bubbles for at least 30 frames")
    return {
        "sampled_frames": len(positions),
        "upper_bubble_drift_pixels": max(p[0] for p in positions) - min(p[0] for p in positions),
        "lower_bubble_drift_pixels": max(p[1] for p in positions) - min(p[1] for p in positions),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording")
    parser.add_argument("--max-drift-pixels", type=float, default=6,
                        help="Two points in the 3x iPhone fixture, including video compression rounding")
    args = parser.parse_args()
    result = measure(args.recording)
    result["passed"] = max(result["upper_bubble_drift_pixels"], result["lower_bubble_drift_pixels"]) <= args.max_drift_pixels
    print(json.dumps(result))
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
