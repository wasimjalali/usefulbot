# Checks a mounted Useful-Bot-macOS.dmg: the app and its version, the
# Applications link, the hidden background and the window layout Finder will
# read from .DS_Store. scripts/release-mac.mjs runs it with the dmgbuild venv's
# Python on the volume it mounted read-only. Prints the layout as JSON; exits 1
# on any mismatch. The expected values match macos/dmg/settings.py and
# macos/dmg/background.swift.
#
#   python verify.py <mount point> <app name> <volume name> <version> <build>
import json
import os
import plistlib
import re
import subprocess
import sys

from ds_store import DSStore
from mac_alias import Alias

mount, app, volume, version, build = sys.argv[1:6]
problems = []

names = sorted(os.listdir(mount))
for want in (app, "Applications", ".background.tiff", ".DS_Store"):
    if want not in names:
        problems.append(f"missing {want}")
extra = [n for n in names if n not in (app, "Applications", ".background.tiff", ".DS_Store", ".fseventsd", ".Trashes")]
if extra:
    problems.append(f"unexpected entries {extra}")
link = os.path.join(mount, "Applications")
if not os.path.islink(link) or os.readlink(link) != "/Applications":
    problems.append("Applications is not a link to /Applications")

# The same build as the release: not a stale bundle left in macos/dist.
info_path = os.path.join(mount, app, "Contents", "Info.plist")
info = {}
if os.path.isfile(info_path):
    with open(info_path, "rb") as f:
        info = plistlib.load(f)
else:
    problems.append(f"{app} has no Contents/Info.plist")
if info.get("CFBundleShortVersionString") != version or info.get("CFBundleVersion") != build:
    problems.append(f"{app} is {info.get('CFBundleShortVersionString')} ({info.get('CFBundleVersion')}), not {version} ({build})")

# Both representations of the background: 660x440 at 1x, 1320x880 at 2x.
tiff = subprocess.run(["tiffutil", "-info", os.path.join(mount, ".background.tiff")], capture_output=True, text=True).stdout
sizes = [(int(w), int(h)) for w, h in re.findall(r"Image Width: (\d+) Image Length: (\d+)", tiff)]
if sorted(sizes) != [(660, 440), (1320, 880)]:
    problems.append(f"background sizes are {sizes}, not 660x440 and 1320x880")

layout = {"backgroundSizes": sizes}
with DSStore.open(os.path.join(mount, ".DS_Store"), "r") as store:
    for entry in store:
        if entry.code == b"Iloc":
            layout.setdefault("icons", {})[entry.filename] = list(entry.value)
        elif entry.code == b"icvp" and entry.filename == ".":
            layout["iconSize"] = entry.value.get("iconSize")
            layout["backgroundType"] = entry.value.get("backgroundType")
            alias_bytes = entry.value.get("backgroundImageAlias")
            if alias_bytes:
                alias = Alias.from_bytes(alias_bytes)
                layout["backgroundVolume"] = alias.volume.name
                layout["backgroundFile"] = alias.target.filename
        elif entry.code == b"bwsp" and entry.filename == ".":
            for key in ("WindowBounds", "ShowToolbar", "ShowSidebar", "ShowPathbar", "ShowStatusBar", "ShowTabView"):
                layout[key] = entry.value.get(key)

if layout.get("icons", {}).get(app) != [170, 180]:
    problems.append(f"{app} is not at (170, 180)")
if layout.get("icons", {}).get("Applications") != [490, 180]:
    problems.append("Applications is not at (490, 180)")
if layout.get("backgroundType") != 2:
    problems.append("the window has no background picture")
# Finder finds the background through this alias, by volume name: a build
# that ran while another volume had the name points at the wrong one.
if layout.get("backgroundVolume") != volume or layout.get("backgroundFile") != ".background.tiff":
    problems.append(f"the background alias points at {layout.get('backgroundVolume')!r}/{layout.get('backgroundFile')!r}")
if layout.get("iconSize") != 128:
    problems.append("icon size is not 128")
if layout.get("WindowBounds") != "{{200, 160}, {660, 428}}":
    problems.append(f"window bounds are {layout.get('WindowBounds')}")
for key in ("ShowToolbar", "ShowSidebar", "ShowPathbar", "ShowStatusBar", "ShowTabView"):
    if layout.get(key) is not False:
        problems.append(f"{key} is not off")

print(json.dumps({"entries": names, **layout}))
if problems:
    print("; ".join(problems), file=sys.stderr)
    sys.exit(1)
