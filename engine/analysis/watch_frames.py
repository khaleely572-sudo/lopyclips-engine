#!/usr/bin/env python3
"""Pick still frames from one short clip section using the /watch skill's frame engine.

Usage: watch_frames.py <section.mp4> <out_dir> <start_s> <end_s> <max_frames>
Times are seconds inside the section file. Prints {"engine": ..., "frames": [{"t": seconds, "path": ...}]} as JSON.
The skill lives in ~/.claude/skills/watch unless WATCH_SKILL_DIR points elsewhere.
"""
import json
import os
import sys
from pathlib import Path

skill = Path(os.environ.get("WATCH_SKILL_DIR") or Path.home() / ".claude" / "skills" / "watch") / "scripts"
if not (skill / "frames.py").exists():
    sys.exit(f"The /watch skill was not found at {skill}")
sys.path.insert(0, str(skill))

from frames import auto_fps_focus, extract_scene_or_uniform  # noqa: E402

video, out_dir = sys.argv[1], Path(sys.argv[2])
start, end, max_frames = float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5])
fps, target = auto_fps_focus(end - start, max_frames)
frames, meta = extract_scene_or_uniform(
    video, out_dir, fps=fps, target_frames=target, resolution=512, max_frames=max_frames, start_seconds=start, end_seconds=end
)
print(json.dumps({"engine": meta.get("engine"), "frames": [{"t": f["timestamp_seconds"], "path": f["path"]} for f in frames]}))
