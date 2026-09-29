# dmgbuild settings for Useful-Bot-macOS.dmg (https://dmgbuild.readthedocs.io).
# scripts/release-mac.mjs passes the app and the rendered background as
# defines:  dmgbuild -s settings.py -D app=... -D background=... "Useful Bot" out.dmg
# The window width and icon centres must match macos/dmg/background.swift.
import os.path

app = defines["app"]  # noqa: F821 (dmgbuild provides `defines`)
app_name = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
# No hide_extensions: it sets Finder info on the bundle, which breaks
# `codesign --verify --strict` on the copy people drag out. Finder hides
# ".app" by default anyway.

background = defines["background"]  # noqa: F821
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
# Window frame: 400 points of content under a 28-point title bar.
window_rect = ((200, 160), (660, 428))
default_view = "icon-view"
arrange_by = None
show_icon_preview = False
icon_size = 128
text_size = 13
label_pos = "bottom"
icon_locations = {
    app_name: (170, 180),
    "Applications": (490, 180),
}
