# Bing Wallpaper Folder

A GNOME Shell extension that treats your wallpaper folder as the source of
truth: it downloads the daily Bing image into it and lets you browse, search
and apply every image in the folder from a panel menu.

Available on [extensions.gnome.org](https://extensions.gnome.org/) (pending
review): <https://extensions.gnome.org/extension/bing-wallpaper-folder/>

## Features

- **Daily Bing fetch** — pulls the Bing HPImageArchive feed (configurable
  market and resolution) and downloads only images you do not already have.
- **Folder is the source of truth** — every regular image file in the
  wallpaper folder (default `~/Pictures/BingWallpaper`) shows up in the menu;
  no dependency on dconf state or a particular downloader.
- **Portable sidecar metadata** — titles, copyright and source URLs are stored
  in `.bing-wallpaper-folder.json` inside the wallpaper folder, so metadata
  travels with the folder when you copy, back up or move machines. Filename
  parsing and file mtime are used as graceful fallbacks.
- **On-demand thumbnails** — nothing is decoded while the menu is closed.
  Thumbnails decode in idle batches when the menu opens, are released
  immediately when it closes, and are capped by an in-memory LRU (64 entries)
  plus a persistent on-disk PNG cache.
- **Memory-pressure aware** — reacts to `GMemoryMonitor` warnings: medium
  pressure clears the in-memory cache, critical pressure also unloads visible
  image content while the menu is closed.
- **Panel menu with search, pagination, previous / random / next, manual
  refresh, one-click folder opening and a full preferences window.**
- Optionally applies the newest image automatically and can set the lock
  screen background as well.

## Install

### From extensions.gnome.org

Open the [extension page](https://extensions.gnome.org/extension/bing-wallpaper-folder/)
with the GNOME Shell integration browser extension installed and toggle it on.

### From source

```sh
gnome-extensions pack --force --extra-source=LICENSE .
gnome-extensions install --force bing-wallpaper-folder@torosfanny.github.io.shell-extension.zip
```

Then log out and back in (or run `gnome-extensions enable
bing-wallpaper-folder@torosfanny.github.io` on an X11 session).

## Requirements

GNOME Shell 45–51 (pure GJS/ESM, no external binaries or scripts). Network
access to `www.bing.com` is only needed for the daily fetch; browsing and
switching wallpapers already in the folder works fully offline.

## License

Copyright (C) 2026 TorosFanny

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE) for
more details.
