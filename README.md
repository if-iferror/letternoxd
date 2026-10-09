# Letternoxd

**Mark films "Not interested," add badges.** A free, open-source extension for Letterboxd, with a one-click watchlist button too.

Letterboxd lets you hide films you've watched or watchlisted, but there's no way to say "I've seen the trailer, I'm never watching this." Letternoxd adds that.

> Unofficial. Letternoxd is a fan-made browser extension and isn't affiliated with or endorsed by Letterboxd.

## What it does

- **Not interested (⃠)**: hover any poster and click ⃠ in the top-right corner. On a film's own page, use **Nah** next to Watch / Like / Watchlist.
- **A tidier filter menu**: Letterboxd's Show/Hide pairs become one row each (Show · Fade · Hide · Only), with Not interested, Liked and Watchlist fades added alongside its own "Fade watched films". Faded films keep their badges so you can tell them apart.
- **One-click watchlist**: a watchlist button sits in each poster's hover bar, so you no longer need the "…" menu.
- **Status badges**: a small badge in each poster's top-left corner: green eye for seen, orange heart for loved, blue clock for your watchlist (with a thin blue border). Your star rating sits just below. Turn them on or off with "Status badges" in the eye menu.
- **Rate in one click**: on hover, the top-left "…" becomes your rating ("☆ 3.5"), or "☆ Rate" for films you've seen but not rated. Click it to rate.
- **Coloured fades**: fade watched films toward dark green, loved films toward dark orange and watchlist films toward dark blue, each on its own, so you can still tell them apart.
- **Changed your mind?** Watching, loving or watchlisting a film takes it off "not interested" automatically, and its ⃠ stays greyed out until you undo those.
- **Seen it? Off the watchlist.** Marking a film watched (or loving it) takes it off your watchlist too.
- **Instant**: everything updates the moment you click, and films you've marked are hidden before the page finishes drawing.

## Where your data lives

Films you mark are saved to a **private list called "Not Interested"** on your own Letterboxd account (the extension creates it the first time you click ⃠). Nothing is lost if you reinstall or switch computers, and you can edit the list on Letterboxd like any other.

Letternoxd collects nothing. It only talks to letterboxd.com, as you, and keeps its settings in your browser.

## Install

**From the Chrome Web Store** (Chrome, Arc, Brave, Edge): *link coming soon*.

**From Firefox Add-ons** (Firefox 128 or later): *link coming soon*.

The same files work in both browsers.

**From this repository, in Chrome, Arc, Brave or Edge:**

1. Download this repository (green **Code** button → **Download ZIP**) and unzip it somewhere permanent.
2. Go to `chrome://extensions` (Arc: `arc://extensions`, Brave: `brave://extensions`, Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right), click **Load unpacked**, and choose the unzipped folder.
4. Reload any open Letterboxd tabs.

To update, replace the files, click ↻ on the extension's card, and reload Letterboxd.

**From this repository, in Firefox:**

1. Download and unzip this repository as above.
2. Go to `about:debugging#/runtime/this-firefox` and click **Load Temporary Add-on…**.
3. Choose the `manifest.json` file inside the unzipped folder.
4. Reload any open Letterboxd tabs.

Firefox removes temporary add-ons when it restarts, so for everyday use install it from Firefox Add-ons instead.

## Good to know

- The filter works after each page loads, so a page may show a few fewer posters than usual. A note under the grid says how many were hidden.
- Page totals (e.g. "1,234 films") still count hidden films.
- Desktop browsers only; the Letterboxd apps aren't affected.
- It relies on how Letterboxd's website works today, so a redesign may need an update.

## Troubleshooting

Open the browser console on a Letterboxd page and run:

- `lbNotInterested.state()` to see what the extension knows (your list, saved films, settings).
- `lbNotInterested.resync()` to re-read your "Not Interested" list now. It otherwise refreshes every 6 hours, when you return to a tab after 10 minutes, and whenever you click ⃠.

## License

MIT
