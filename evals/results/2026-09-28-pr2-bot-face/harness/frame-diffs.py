import subprocess, sys, glob, re
d, x, y, w, h = sys.argv[1], *map(int, sys.argv[2:6])
files = sorted(glob.glob(d + "/*.jpg"))
t = [int(re.search(r'_(\d+)ms', f).group(1)) for f in files]
lst = d + "/list.txt"
open(lst, "w").write("".join(f"file '{f}'\n" for f in files))
raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-framerate", "60", "-pattern_type", "glob", "-i", d + "/*.jpg", "-vf", f"crop={w}:{h}:{x}:{y},format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
n = w * h; frames = [raw[i*n:(i+1)*n] for i in range(len(raw)//n)]
diffs = [sum(abs(a-b) for a, b in zip(f1, f2)) / n for f1, f2 in zip(frames, frames[1:])]
top = sorted(range(len(diffs)), key=lambda i: -diffs[i])[:8]
print("frames", len(frames), "mean diff", round(sum(diffs)/len(diffs), 2), "moving frames", sum(1 for v in diffs if v > 0.3))
print("largest steps (ms, diff):", [(t[i+1], round(diffs[i], 1)) for i in sorted(top)])
