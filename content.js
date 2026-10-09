/*
 * Letterboxd: Not Interested
 * MIT License — see LICENSE.
 *
 * Runs in the page's own JavaScript world (manifest "world": "MAIN") so it can
 * use the same CSRF token and signed-in session as Letterboxd's own buttons.
 *
 * Storage
 *   - "Not interested" films live in a private Letterboxd list named
 *     "Not Interested" on your account, so they survive reinstalls.
 *   - A local cache of that list and your menu choices is kept in
 *     localStorage so pages can be filtered instantly (even before they draw).
 */
(() => {
  "use strict";

  if (window.__lbNotInterested) return;
  window.__lbNotInterested = true;

  // ================================================================ config
  const NS = "lbni";
  const LIST_NAME = "Not Interested";
  const LIST_SLUG_GUESS = "not-interested";
  const RESYNC_AFTER_MS = 6 * 60 * 60 * 1000; // full re-read of the list
  const RESYNC_ON_RETURN_MS = 10 * 60 * 1000; // re-read when you come back to the tab
  const PREDICTION_MS = 8000; // how long an optimistic guess is trusted
  const MODES = ["show", "fade", "hide", "only"];

  // ================================================================ storage
  const readJSON = (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  };
  const writeJSON = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };

  const PREFS_KEY = `${NS}:prefs`;
  const LAST_USER_KEY = `${NS}:lastUser`;
  const cacheKey = (user) => `${NS}:v1:${user}`;

  const prefs = { mode: "hide", indicators: true, ...readJSON(PREFS_KEY, {}) };
  // Watched / Liked / Watchlist rows run in the browser (instant, no reload):
  // "show" | "fade" | "hide" | "only".
  prefs.filters = { watched: "show", liked: "show", watchlist: "show", ...(prefs.filters || {}) };
  if (prefs.fadeLiked) prefs.filters.liked = "fade";
  if (prefs.fadeWatchlist) prefs.filters.watchlist = "fade";
  if (!readJSON(PREFS_KEY, {}).filters && /(?:^|;\s*)hideMyWatchedFilms=true/.test(document.cookie)) {
    prefs.filters.watched = "fade"; // carry over Letterboxd's own "Fade watched films"
    writeJSON(PREFS_KEY, prefs);
  }
  delete prefs.fadeLiked;
  delete prefs.fadeWatchlist;
  if (!MODES.includes(prefs.mode)) prefs.mode = "hide";
  // Badge style: "current" (eye / heart + rating pill), "ratings" (the rating
  // number itself, green = seen, orange = liked) or "none".
  const BADGE_STYLES = ["current", "ratings", "none"];
  if (!BADGE_STYLES.includes(prefs.badgeStyle)) prefs.badgeStyle = prefs.indicators === false ? "none" : "current";
  const setBadgeStyle = (style) => {
    if (style !== "none") prefs.lastBadgeStyle = style;
    prefs.badgeStyle = style;
    prefs.indicators = style !== "none";
    savePrefs();
  };
  // How a rating number looks in the "ratings" style: "plain" (3.5),
  // "star" (★3.5), "half" (3½) or "instar" (the number inside a star).
  const RATING_LOOKS = ["plain", "star", "half", "instar"];
  if (!RATING_LOOKS.includes(prefs.ratingLook)) prefs.ratingLook = "plain";
  const savePrefs = () => writeJSON(PREFS_KEY, prefs);

  let USER = null; // set once the page is ready
  let cache = { lids: [], slugs: [], syncedAt: 0, lidSet: new Set(), slugSet: new Set() };

  function loadCache(user) {
    const c = readJSON(cacheKey(user), null) || { lids: [], slugs: [], syncedAt: 0 };
    c.lidSet = new Set(c.lids);
    c.slugSet = new Set(c.slugs);
    cache = c;
  }
  function saveCache() {
    if (!USER) return;
    cache.lids = [...cache.lidSet];
    cache.slugs = [...cache.slugSet];
    const { lidSet, slugSet, ...plain } = cache;
    writeJSON(cacheKey(USER), plain);
  }

  // ================================================================ instant first paint
  // Before Letterboxd's page has even drawn, hide or fade the films you've
  // marked, using the cached list. The live logic takes over (and removes
  // this) on its first pass.
  const isFilmPage = () => /^\/film\//.test(location.pathname);
  (function earlyStyle() {
    if ((prefs.mode !== "hide" && prefs.mode !== "fade") || isFilmPage()) return;
    // Only pages with Letterboxd's film filter, where the live filter applies.
    if (!/^\/(films\/|[^/]+\/(watchlist|films|list|likes)\/)/.test(location.pathname)) return;
    const user = readJSON(LAST_USER_KEY, null);
    const c = user && readJSON(cacheKey(user), null);
    if (!c?.slugs?.length) return;
    if (new RegExp(`^/[^/]+/list/${c.slug || LIST_SLUG_GUESS}(/|$)`).test(location.pathname)) return;
    const sel = c.slugs
      .map((s) => `li:has(> [data-item-slug="${CSS.escape(s)}"])`)
      .join(",");
    const rule =
      prefs.mode === "hide"
        ? `${sel}{display:none!important}`
        : `:is(${sel}):not(:hover) > *{opacity:.2}`;
    const style = document.createElement("style");
    style.id = `${NS}-early`;
    style.textContent = rule;
    const root = document.head || document.documentElement;
    if (root) root.append(style);
    else document.addEventListener("readystatechange", () => document.head?.append(style), { once: true });
  })();
  // Letterboxd already asks, for every poster, what you've done with that film
  // (watched, liked, watchlist, your rating). We listen in on those answers
  // instead of asking again: lid -> { rating, liked, watched, inWatchlist }.
  const meData = new Map();
  (function listenToLetterboxd() {
    const ME = /\/api\/v0\/production\/([A-Za-z0-9]+)\/me(?:[?#]|$)/;
    const realFetch = window.fetch;
    if (typeof realFetch !== "function") return;
    window.fetch = function (input, init) {
      const p = realFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input?.url;
        const m = url && ME.exec(url);
        if (m) {
          p.then((r) => (r.ok ? r.clone().json() : null))
            .then((d) => d && rememberMe(m[1], d))
            .catch(() => {});
        }
      } catch {}
      return p;
    };
  })();
  function rememberMe(lid, d) {
    const prev = meData.get(lid) || {};
    meData.set(lid, { ...prev, ...d });
    if (typeof d.inWatchlist === "boolean") watchlistState.set(lid, d.inWatchlist);
    fullPass = true;
    schedule();
  }

  const dropEarlyStyle = () => document.getElementById(`${NS}-early`)?.remove();

  // ================================================================ session
  const readUser = () =>
    window.person?.username ||
    document.querySelector(".nav-account .avatar img[alt]")?.getAttribute("alt") ||
    null;
  const csrf = () =>
    window.supermodelCSRF || document.querySelector("input[name='__csrf']")?.value || "";

  // ================================================================ network
  class SignedOutError extends Error {}
  const signedOutMessage = "Letterboxd has signed you out. Reload the page and try again.";

  async function api(method, path, body) {
    const res = await fetch(`${location.origin}/api/v0${path}`, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json; charset=UTF-8" } : {}),
        ...(method !== "GET" ? { "X-CSRF-TOKEN": csrf() } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw new SignedOutError(signedOutMessage);
    let data = null;
    try {
      data = await res.json();
    } catch {}
    const apiError = Array.isArray(data?.messages) && data.messages.some((m) => m.type === "Error");
    return { ok: res.ok && !apiError, status: res.status, data };
  }

  async function postForm(path, params, { asText = false } = {}) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, __csrf: csrf() })) {
      if (Array.isArray(v)) v.forEach((x) => body.append(k, x));
      else body.append(k, v);
    }
    const res = await fetch(`${location.origin}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-TOKEN": csrf() },
      body,
    });
    if (res.status === 401) throw new SignedOutError(signedOutMessage);
    if (asText) return { ok: res.ok, status: res.status, text: await res.text() };
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { ok: res.ok, status: res.status, data };
  }

  // ================================================================ the list
  // Your lists, and where (if anywhere) this film sits in each one.
  async function findList(filmLid) {
    const r = await postForm("/s/load-lists", { listableLid: filmLid });
    if (!r.ok || !r.data) throw new Error(`Couldn't load your lists (HTTP ${r.status}).`);
    const lists = [...(r.data.privateLists || []), ...(r.data.publicLists || [])];
    const list = lists.find((l) => (l.name || "").trim().toLowerCase() === LIST_NAME.toLowerCase());
    if (list) {
      cache.listLid = list.boxdItCode || list.lid || cache.listLid;
      cache.listId = list.id ?? cache.listId;
      const link = list.link || list.url;
      if (link) cache.slug = link.split("/list/")[1]?.replace(/\/.*$/, "") || cache.slug;
      saveCache();
    }
    return list || null;
  }

  async function addToList(film) {
    const list = await findList(film.lid);
    if (!list) {
      const created = await api("POST", "/lists", {
        name: LIST_NAME,
        published: false,
        sharePolicy: "You",
        ranked: false,
        description: "Films I'm not interested in. Managed by the Letternoxd extension.",
        entries: [{ film: film.lid }],
      });
      if (created.ok) {
        const l = created.data?.data || created.data;
        cache.listLid = l?.id || cache.listLid;
        saveCache();
        return;
      }
      throw new Error(
        `Couldn't create your private “${LIST_NAME}” list automatically. ` +
          `Create a private list with that exact name on Letterboxd, then try again.`
      );
    }
    if (list.position != null) return; // already there
    const r = await api("PATCH", `/list/${encodeURIComponent(cache.listLid)}`, {
      entries: [{ action: "ADD", film: film.lid }],
    });
    if (r.ok) return;
    // Fallback: the same form Letterboxd's "Add to lists" panel uses.
    const f = await postForm("/list/add-films/", {
      filmListId: String(cache.listId),
      importProductionId: [film.lid],
      shouldImportProduction: ["true"],
    });
    if (!f.ok) throw new Error(`Couldn't add to your “${LIST_NAME}” list (HTTP ${r.status}/${f.status}).`);
  }

  async function removeFromList(film) {
    const list = await findList(film.lid);
    if (!list || list.position == null) return; // not there anyway
    const r = await api("PATCH", `/list/${encodeURIComponent(cache.listLid)}`, {
      entries: [{ action: "DELETE", position: list.position }],
    });
    if (!r.ok) throw new Error(`Couldn't remove from your “${LIST_NAME}” list (HTTP ${r.status}).`);
  }

  // Read the whole list. Uses the feed Letterboxd's list editor uses, because
  // the public list page applies your saved filters ("Hide watched films",
  // "Hide films in watchlist") and would silently leave those films out.
  // Falls back to the list page if the feed isn't available.
  let syncing = null;
  function syncList({ force = false } = {}) {
    if (!USER) return Promise.resolve();
    if (!force && Date.now() - (cache.syncedAt || 0) < RESYNC_AFTER_MS) return Promise.resolve();
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        if (!cache.listLid) {
          const anyLid =
            [...document.querySelectorAll("[data-postered-identifier]")].map((el) => filmIdentity(el).lid).find(Boolean) ||
            document.querySelector(`.${NS}-panel-ni`)?.dataset.lid;
          if (anyLid) {
            try {
              await findList(anyLid);
            } catch {
              // No list yet, or offline: the page fallback below still works.
            }
          }
        }
        const result = (cache.listLid && (await readListFeed(cache.listLid))) || (await readListPages());
        if (!result) return;
        cache.lidSet = result.lids;
        cache.slugSet = result.slugs;
        cache.syncedAt = Date.now();
        saveCache();
        applyAll();
      } catch {
        // Network trouble: keep the cached list and try again later.
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  async function readListFeed(listLid) {
    try {
      const r = await postForm("/s/load-list-entries", { filmListLid: listLid }, { asText: true });
      if (!r.ok) return null;
      const lids = new Set();
      const slugs = new Set();
      for (const line of r.text.split("\n")) {
        if (!line.trim()) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        for (const entry of Array.isArray(o) ? o : [o]) {
          const lid = entry?.listable?.lid;
          if (!lid || (entry.listable.type && entry.listable.type !== "film")) continue;
          lids.add(lid);
          const slug = entry.posterLookup?.posteredBaseLink?.match(/\/film\/([^/]+)/)?.[1];
          if (slug) slugs.add(slug);
        }
      }
      return { lids, slugs };
    } catch {
      return null;
    }
  }

  async function readListPages() {
    const slug = cache.slug || LIST_SLUG_GUESS;
    const lids = new Set();
    const slugs = new Set();
    for (let page = 1; page < 200; page++) {
      const res = await fetch(`${location.origin}/${USER}/list/${slug}/${page > 1 ? `page/${page}/` : ""}`, {
        credentials: "include",
      });
      if (res.status === 404) {
        if (page === 1) return { lids, slugs };
        break;
      }
      if (!res.ok) return null;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const posters = doc.querySelectorAll("[data-postered-identifier], [data-item-slug], [data-film-slug]");
      if (!posters.length) break;
      posters.forEach((p) => {
        const f = filmIdentity(p);
        if (f.lid) lids.add(f.lid);
        if (f.slug) slugs.add(f.slug);
      });
      if (!doc.querySelector(".paginate-nextprev .next, a.next")) break;
    }
    return { lids, slugs };
  }

  // ================================================================ films
  function filmIdentity(el) {
    let lid = null;
    const raw = el.getAttribute("data-postered-identifier");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed.type || parsed.type === "film") lid = parsed.lid || null;
      } catch {}
    }
    const slug =
      el.getAttribute("data-item-slug") ||
      el.getAttribute("data-film-slug") ||
      el.getAttribute("data-item-link")?.match(/\/film\/([^/]+)/)?.[1] ||
      null;
    const name = el.getAttribute("data-item-name") || el.getAttribute("data-film-name") || slug;
    return { lid, slug, name };
  }

  const isNotInterested = ({ lid, slug }) =>
    (lid && cache.lidSet.has(lid)) || (slug && cache.slugSet.has(slug));

  const POSTER_SELECTOR = "[data-component-class='LazyPoster'], .film-poster[data-film-slug]";
  const GRID_ITEM_SELECTOR = "li.posteritem, li.griditem, li.poster-container, li.film-detail, li.listitem";

  // Grid cells only; overlapping poster stacks (list previews) are left alone.
  const gridItemOf = (poster) => {
    const item = poster.closest(GRID_ITEM_SELECTOR);
    return item && !item.closest(".-overlapped, .poster-list-overlapped, .poster-list-link") ? item : null;
  };
  // Corner buttons also go on the big poster at the top of a film page.
  const buttonHostOf = (poster) =>
    gridItemOf(poster) || (!poster.closest(".modal") && poster.closest("section.poster-list.-single")) || null;

  // Per-pass page facts (computed once per update instead of once per poster).
  const page = { filterMenu: false, ourList: false, watchedFade: false };
  function refreshPageFacts() {
    page.filterMenu = !!document.querySelector("li.js-film-filter");
    // Letterboxd's own "Fade watched films" (it adds this class when it applies).
    page.watchedFade = document.body.classList.contains("hide-films-seen");
    page.ourList = new RegExp(`^/[^/]+/list/${cache.slug || LIST_SLUG_GUESS}(/|$)`).test(location.pathname);
  }

  // ================================================================ status (seen / loved / watchlist)
  const watchlistState = new Map(); // lid -> true/false
  // Optimistic guesses from your clicks, trusted until Letterboxd confirms
  // (or for a few seconds): lid -> { watched?, liked?, inWatchlist?, until }
  const predictions = new Map();

  function predict(lid, changes) {
    if (!lid) return;
    predictions.set(lid, { ...(predictions.get(lid) || {}), ...changes, until: Date.now() + PREDICTION_MS });
    // If Letterboxd never confirms (say the click failed), fall back to
    // what the page really shows once the guess expires.
    setTimeout(() => {
      fullPass = true;
      schedule();
    }, PREDICTION_MS + 50);
  }

  function statusOf(poster, film) {
    const flags = poster.querySelector("[data-watched], [data-in-watchlist]");
    const me = (film.lid && meData.get(film.lid)) || {};
    const st = {
      watched:
        flags?.getAttribute("data-watched") === "true" || !!poster.querySelector(".icon-watched") || me.watched === true,
      liked: !!poster.querySelector(".like-link.icon-liked, .icon-liked") || me.liked === true,
      inWatchlist:
        flags?.getAttribute("data-in-watchlist") === "true" || (film.lid && watchlistState.get(film.lid) === true),
      rating: typeof me.rating === "number" && me.rating > 0 ? me.rating : 0,
    };
    return withPredictions(film.lid, st);
  }

  function withPredictions(lid, st) {
    const p = lid && predictions.get(lid);
    if (!p) return st;
    if (p.until < Date.now()) {
      predictions.delete(lid);
      return st;
    }
    const out = { ...st };
    let pending = false;
    for (const k of ["watched", "liked", "inWatchlist"]) {
      if (!(k in p)) continue;
      if (p[k] === st[k]) delete p[k]; // Letterboxd has caught up
      else {
        out[k] = p[k];
        pending = true;
      }
    }
    if (!pending) predictions.delete(lid);
    return out;
  }

  // Watching, loving or watchlisting a film takes it off "not interested",
  // and the ⃠ stays unclickable until none of those apply.
  const blockReason = new Map(); // lid -> reason text ("" when free)
  const undoing = new Set();

  function noteBlock(lid, st) {
    if (!lid) return "";
    const reason = st.inWatchlist
      ? "it's on your watchlist"
      : st.liked
      ? "you've loved it"
      : st.watched
      ? "you've watched it"
      : "";
    blockReason.set(lid, reason);
    return reason;
  }

  async function autoUndo(film) {
    if (!film.lid || undoing.has(film.lid)) return;
    undoing.add(film.lid);
    const reason = blockReason.get(film.lid);
    setMarked(film, false);
    try {
      await removeFromList(film);
      toast(`‘${film.name}’ removed from Not interested — ${reason}.`);
    } catch (err) {
      setMarked(film, true);
      toast(err.message || "Couldn't update your Not interested list.", true);
    } finally {
      undoing.delete(film.lid);
    }
  }

  function setMarked(film, on) {
    if (on) {
      cache.lidSet.add(film.lid);
      if (film.slug) cache.slugSet.add(film.slug);
    } else {
      cache.lidSet.delete(film.lid);
      if (film.slug) cache.slugSet.delete(film.slug);
    }
    saveCache();
    applyAll();
  }

  // ================================================================ icons
  const svg = (viewBox, body) => `<svg viewBox="${viewBox}" aria-hidden="true">${body}</svg>`;
  const ICON_NI = svg(
    "0 0 24 24",
    '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M6.6 6.6l10.8 10.8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'
  );
  // Film-page version, matching Letterboxd's sidebar glyphs (~23px, ~1.4px lines).
  const ICON_NI_PANEL = svg(
    "0 0 32 32",
    '<circle cx="16" cy="16" r="10.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8.4 8.4l15.2 15.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  );
  // Watchlist button: Letterboxd's clock with a +/− badge (heavier lines so it
  // reads at button size).
  const ICON_WL = svg(
    "5 3 40 36",
    '<circle cx="21" cy="20" r="13" fill="none" stroke="currentColor" stroke-width="3.2"/>' +
      '<path d="M15 18.5l6 1.5 6-6.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="34.5" cy="28.5" r="10" fill="currentColor" stroke="#14181c" stroke-width="3"/>' +
      `<path class="${NS}-plus" d="M34.5 23.5v10M29.5 28.5h10" stroke="#14181c" stroke-width="2.6"/>` +
      `<path class="${NS}-minus" d="M29.5 28.5h10" stroke="#14181c" stroke-width="2.6"/>`
  );
  const ICON_EYE = svg(
    "0 0 32 32",
    '<path d="M2.5 16C6 9.5 10.6 6.5 16 6.5S26 9.5 29.5 16C26 22.5 21.4 25.5 16 25.5S6 22.5 2.5 16z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><circle cx="16" cy="16" r="5.2" fill="currentColor"/>'
  );
  const ICON_HEART = svg(
    "0 0 32 32",
    '<path d="M16 28S3 20.4 3 11.6C3 7.4 6.1 4.5 9.9 4.5c2.6 0 4.9 1.4 6.1 3.6 1.2-2.2 3.5-3.6 6.1-3.6 3.8 0 6.9 2.9 6.9 7.1C29 20.4 16 28 16 28z" fill="currentColor"/>'
  );
  const ICON_CLOCK = svg(
    "0 0 32 32",
    '<circle cx="16" cy="16" r="11.5" fill="none" stroke="currentColor" stroke-width="2.8"/><path d="M10.5 14.6l5.5 1.4 5.4-5.8" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>'
  );
  const ICON_MORE = svg(
    "0 0 24 24",
    '<circle cx="5.5" cy="12" r="2.3" fill="currentColor"/><circle cx="12" cy="12" r="2.3" fill="currentColor"/><circle cx="18.5" cy="12" r="2.3" fill="currentColor"/>'
  );
  const ICON_STAR = svg(
    "0 0 24 24",
    '<path d="M12 3.2l2.6 5.6 6.1.7-4.5 4.2 1.2 6.1L12 16.8l-5.4 3 1.2-6.1-4.5-4.2 6.1-.7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
  );
  const BADGE_ICON = { loved: ICON_HEART, seen: ICON_EYE, watchlist: ICON_CLOCK, "watchlist-faded": ICON_CLOCK };
  const ICON_STAR_SOLID = svg(
    "0 0 24 24",
    '<path d="M12 2.6l2.8 6 6.6.8-4.9 4.5 1.3 6.5L12 17.2l-5.8 3.2 1.3-6.5-4.9-4.5 6.6-.8z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>'
  );
  // A rating as text, in the chosen look: 3.5 / 3½.
  const ratingLabel = (rating, look) => {
    if (!(rating > 0)) return "";
    if (look === "half") return rating % 1 ? `${Math.floor(rating) || ""}½` : String(rating);
    return String(rating % 1 ? rating.toFixed(1) : rating);
  };
  // One badge's markup. "num-seen" / "num-loved" show the rating number;
  // "star-seen" / "star-loved" an outlined star; the rest an icon.
  const badgeHTML = (rating) => (k) => {
    const [type, tone] = k.split("-");
    if (type === "num") {
      const look = prefs.ratingLook;
      const text = `<span class="${NS}-num">${ratingLabel(rating, look)}</span>`;
      const extra = look === "star" || look === "instar" ? ICON_STAR_SOLID : "";
      return `<span class="${NS}-badge ${NS}-badge-num ${NS}-look-${look} ${NS}-badge-${tone}">${extra}${text}</span>`;
    }
    if (type === "star") return `<span class="${NS}-badge ${NS}-badge-star ${NS}-badge-${tone}">${ICON_STAR}</span>`;
    return `<span class="${NS}-badge ${NS}-badge-${k}">${BADGE_ICON[k]}</span>`;
  };

  // ================================================================ applying state to a poster
  function applyTo(poster) {
    const item = gridItemOf(poster);
    const film = filmIdentity(poster);
    if (!item) {
      // Big film-page poster: just keep its ⃠ in step.
      return;
    }
    const st = statusOf(poster, film);
    if (noteBlock(film.lid, st) && isNotInterested(film)) autoUndo(film);

    const marked = isNotInterested(film);
    const filtering = page.filterMenu && !page.ourList;
    const active = marked && filtering; // a not-interested film being filtered
    const F = prefs.filters;
    const byStatus = (mode, has) => (mode === "hide" && has) || (mode === "only" && !has);
    item.classList.toggle(
      `${NS}-hidden`,
      filtering &&
        (byStatus(prefs.mode, marked) ||
          byStatus(F.watched, st.watched) ||
          byStatus(F.liked, st.liked) ||
          byStatus(F.watchlist, st.inWatchlist))
    );
    // Fade = exactly Letterboxd's "Fade watched films": 20% until hovered.
    item.classList.toggle(`${NS}-faded`, active && prefs.mode === "fade");

    const style = prefs.badgeStyle;
    const on = style !== "none";
    const niShown = active && (prefs.mode === "fade" || prefs.mode === "show");

    // Coloured fades (one layer, straight toward a dark tint): watched → green,
    // liked → orange, watchlist → blue. Watched follows Letterboxd's own
    // "Fade watched films"; liked and watchlist are ours.
    let tint = null;
    if (!active && filtering) {
      // Watched → Fade covers watched films you didn't love; loved films
      // follow the Liked row, so the two can be faded independently.
      if (st.liked && F.liked === "fade") tint = "loved";
      else if (st.watched && !st.liked && F.watched === "fade") tint = "seen";
      else if (st.inWatchlist && F.watchlist === "fade") tint = "watchlist";
    }
    item.classList.toggle(`${NS}-tinted`, !!tint);

    // Overlay layer: the tint above, or the not-interested wash.
    const kind = niShown && (on || prefs.mode === "fade") ? "ni" : tint;
    let ind = item.querySelector(`:scope > .${NS}-ind`);
    if (kind) {
      if (!ind) {
        ind = document.createElement("span");
        ind.className = `${NS}-ind`;
        ind.setAttribute("aria-hidden", "true");
        item.append(ind);
      }
      ind.dataset.kind = kind;
      ind.dataset.strength = kind === "ni" && prefs.mode === "fade" ? "strong" : "soft";
    } else ind?.remove();

    // Badges, top-left.
    //   current: heart (liked) or eye (seen), then the watchlist clock.
    //   ratings: your rating number, or an outlined star if seen but unrated,
    //            orange if liked, green if seen; then the watchlist clock.
    const wlFaded = tint === "watchlist";
    const badges = [];
    const seen = st.watched || st.liked || st.rating > 0;
    if (!active && on) {
      if (style === "ratings") {
        if (seen) badges.push(st.rating > 0 ? `num-${st.liked ? "loved" : "seen"}` : `star-${st.liked ? "loved" : "seen"}`);
      } else if (st.liked) badges.push("loved");
      else if (st.watched) badges.push("seen");
      if (st.inWatchlist) badges.push(wlFaded ? "watchlist-faded" : "watchlist");
    }
    const ratingText = st.rating > 0 ? String(st.rating % 1 ? st.rating.toFixed(1) : st.rating) : "";
    let wrap = item.querySelector(`:scope > .${NS}-badges`);
    if (badges.length) {
      if (!wrap) {
        wrap = document.createElement("span");
        wrap.className = `${NS}-badges`;
        wrap.setAttribute("aria-hidden", "true");
        item.append(wrap);
      }
      const key = badges.join(",") + "|" + ratingText + "|" + prefs.ratingLook;
      if (wrap.dataset.key !== key) {
        wrap.dataset.key = key;
        wrap.innerHTML = badges.map(badgeHTML(st.rating)).join("");
      }
    } else wrap?.remove();

    // Watchlist border (not while faded).
    const ringOn = on && st.inWatchlist && !active && !wlFaded;
    let ring = item.querySelector(`:scope > .${NS}-ring`);
    if (ringOn && !ring) {
      ring = document.createElement("span");
      ring.className = `${NS}-ring`;
      ring.setAttribute("aria-hidden", "true");
      item.append(ring);
    } else if (!ringOn) ring?.remove();

    // Rating pill. It replaces the "…" button (both open the same menu, which
    // is where you rate): "☆ 3.5" if rated, "☆ Rate" if seen but unrated, the
    // plain "…" otherwise. A rating also sits under the badges when not hovered.
    // (Not in the "ratings" style: the badge already shows the rating, and on
    // hover the corner is just the "…".)
    const rateText = ratingText || (st.watched ? "Rate" : "");
    const showRating = !active && !!rateText && style === "current";
    let rate = item.querySelector(`:scope > .${NS}-rate`);
    if (showRating) {
      if (!rate) {
        rate = document.createElement("button");
        rate.type = "button";
        rate.className = `${NS}-rate`;
        item.append(rate);
      }
      if (rate.dataset.value !== rateText) {
        rate.dataset.value = rateText;
        rate.innerHTML = `${ICON_STAR}<span>${rateText}</span>`;
        rate.title = st.rating > 0 ? "Your rating · click to change" : "Rate this film";
        rate.setAttribute("aria-label", rate.title);
      }
      rate.classList.toggle(`${NS}-rate-empty`, !(st.rating > 0));
      rate.classList.toggle(`${NS}-rate-resting`, on && st.rating > 0);
      rate.style.setProperty("--lbni-rate-slot", String(badges.length));
    } else rate?.remove();
    item.classList.toggle(`${NS}-has-rate`, showRating);

    if (kind || ringOn || badges.length || showRating) item.classList.add(`${NS}-host`);

    // Keep this poster's buttons in step.
    const ni = item.querySelector(`:scope > .${NS}-btn-ni`);
    if (ni) setNiButton(ni, marked);
    const wl = wlButtonOf(item);
    if (wl) setWlButton(wl, st.inWatchlist);
  }

  function applyAll() {
    refreshPageFacts();
    document.querySelectorAll(POSTER_SELECTOR).forEach((p) => {
      decorate(p);
      applyTo(p);
    });
    decoratePanel();
    updatePanelStatus();
    // Buttons outside grid cells (film-page poster, "Nah").
    document.querySelectorAll(`section.poster-list.-single > .${NS}-btn-ni, .${NS}-panel-ni`).forEach((b) => {
      setNiButton(b, isNotInterested(filmFromEl(b)));
    });
    updateHiddenNote();
    dropEarlyStyle();
  }

  // ================================================================ buttons
  function stampFilm(el, film) {
    if (film.lid) el.dataset.lid = film.lid;
    if (film.slug) el.dataset.slug = film.slug;
    if (film.name) el.dataset.name = film.name;
  }
  const filmFromEl = (el) => ({
    lid: el.dataset.lid || null,
    slug: el.dataset.slug || null,
    name: el.dataset.name || el.dataset.slug || "This film",
  });

  function makeButton(kind, film) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `${NS}-btn ${NS}-corner ${NS}-btn-${kind}`;
    b.innerHTML = kind === "ni" ? ICON_NI : ICON_WL;
    stampFilm(b, film);
    return b;
  }

  function setNiButton(b, on) {
    const reason = blockReason.get(b.dataset.lid) || "";
    b.classList.toggle(`${NS}-on`, on);
    b.classList.toggle(`${NS}-blocked`, !!reason);
    b.setAttribute("aria-disabled", String(!!reason));
    b.setAttribute("aria-pressed", String(on));
    const label = reason
      ? `Can't mark Not interested — ${reason}`
      : on
      ? "Not interested (click to undo)"
      : "Not interested";
    b.title = label;
    if (b.classList.contains(`${NS}-panel-ni`)) {
      // Beside Watch / Like / Watchlist it's one short word so it never wraps.
      b.querySelector(`.${NS}-panel-label`).textContent = b.classList.contains(`${NS}-inrow`)
        ? "Nah"
        : on
        ? "Not interested ✓"
        : "Not interested";
    } else b.setAttribute("aria-label", label);
  }

  function setWlButton(b, state) {
    b.classList.toggle(`${NS}-on`, state === true);
    const label = state ? "Remove from watchlist" : "Add to watchlist";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(!!state));
  }

  // On hover, each grid poster shows "…" top-left (opens Letterboxd's menu),
  // ⃠ top-right, and the watchlist button in Letterboxd's hover bar where its
  // "…" was. The big film-page poster has no hover bar, so its watchlist
  // button sits top-left.
  function decorate(poster) {
    const item = buttonHostOf(poster);
    if (!item || item.querySelector(`:scope > .${NS}-corner`)) return;
    const film = filmIdentity(poster);
    if (!film.lid) return;

    const flag = poster.querySelector("[data-in-watchlist]")?.getAttribute("data-in-watchlist");
    if ((flag === "true" || flag === "false") && !watchlistState.has(film.lid)) {
      watchlistState.set(film.lid, flag === "true");
    }

    const ni = makeButton("ni", film);
    const wl = makeButton("wl", film);
    setNiButton(ni, isNotInterested(film));
    setWlButton(wl, watchlistState.get(film.lid));

    // Poster size from Letterboxd's own data (no layout measuring).
    const width = Number(poster.getAttribute("data-image-width")) || item.getBoundingClientRect().width;
    item.classList.add(`${NS}-host`);
    if (width && width < 100) item.classList.add(`${NS}-small`);
    if (width >= 200) item.classList.add(`${NS}-large`);
    item.append(wl, ni);
    item._lbniWl = wl; // it may move into Letterboxd's hover bar (see swapIntoBar)

    if (gridItemOf(poster)) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = `${NS}-corner ${NS}-btn-more`;
      more.title = "More";
      more.setAttribute("aria-label", "More options");
      more.innerHTML = ICON_MORE;
      item.append(more);
    }

    // The big film-page poster doesn't carry data-in-watchlist; ask once.
    if (!watchlistState.has(film.lid)) {
      (async () => {
        await fetchWatchlistState(film.lid);
        setWlButton(wl, watchlistState.get(film.lid));
      })();
    }
  }

  // The watchlist button, wherever it currently is (in the item, or inside
  // Letterboxd's hover bar).
  const wlButtonOf = (item) => item._lbniWl || item.querySelector(`.${NS}-btn-wl`);

  // Put the watchlist button INSIDE Letterboxd's hover bar, exactly where its
  // "…" sits (that "…" is hidden; ours in the top-left opens it). Being part
  // of the bar means hovering it keeps the bar open, just like the eye and
  // heart: Letterboxd hides the bar as soon as the pointer leaves the poster.
  function swapIntoBar(item) {
    const bar = item.querySelector(".overlay-actions");
    const link = bar?.querySelector(".menu-link");
    const wl = wlButtonOf(item);
    if (!link || !wl) return false;
    if (wl.parentElement !== bar) bar.append(wl); // also re-adds it if Letterboxd redrew the bar
    if (!link.offsetWidth || !link.offsetHeight) return false; // bar still hidden; try again shortly
    wl.style.left = `${link.offsetLeft}px`;
    wl.style.top = `${link.offsetTop}px`;
    wl.style.width = `${link.offsetWidth}px`;
    wl.style.height = `${link.offsetHeight}px`;
    item.classList.add(`${NS}-swap`);
    return true;
  }

  async function fetchWatchlistState(lid) {
    try {
      const r = await api("GET", `/production/${encodeURIComponent(lid)}/me`);
      const v = r.data?.inWatchlist ?? r.data?.relationship?.inWatchlist;
      if (typeof v === "boolean") watchlistState.set(lid, v);
    } catch {}
  }

  // ================================================================ film page sidebar
  // "Nah" beside Watch / Like / Watchlist (that row becomes four columns).
  function decoratePanel() {
    const panel = document.querySelector("#userpanel ul.js-actions-panel");
    if (!panel || panel.querySelector(`.${NS}-panel-row`)) return;
    const idEl = panel.querySelector("[data-watchlistable-identifier], [data-likeable-identifier]");
    let lid = null;
    try {
      lid = JSON.parse(
        idEl?.getAttribute("data-watchlistable-identifier") || idEl?.getAttribute("data-likeable-identifier") || "{}"
      ).lid;
    } catch {}
    if (!lid) return;
    const film = {
      lid,
      slug: location.pathname.match(/^\/film\/([^/]+)/)?.[1] || null,
      name:
        panel.querySelector("[data-watchlistable-name]")?.getAttribute("data-watchlistable-name") ||
        document.querySelector("h1")?.textContent.trim() ||
        null,
    };

    const row1 = panel.querySelector("li.actions-row1");
    const a = document.createElement("a");
    a.href = "#";
    a.className = `${NS}-panel-ni`;
    a.innerHTML = `<span class="${NS}-panel-icon">${row1 ? ICON_NI_PANEL : ICON_NI}</span><span class="${NS}-panel-label">Not interested</span>`;
    stampFilm(a, film);
    if (row1) {
      const cell = document.createElement("span");
      cell.className = `action-large ${NS}-panel-row ${NS}-row-item`;
      a.classList.add(`${NS}-inrow`);
      cell.append(a);
      row1.append(cell);
      row1.classList.add(`${NS}-row4`);
    } else {
      const row = document.createElement("li");
      row.className = `${NS}-panel-row`;
      row.append(a);
      panel.prepend(row);
    }
  }

  // Watched / Liked / Watchlist, read from Letterboxd's sidebar.
  function updatePanelStatus() {
    const row = document.querySelector("#userpanel li.actions-row1");
    const link = document.querySelector(`.${NS}-panel-ni`);
    if (!row || !link) return;
    const film = filmFromEl(link);
    const st = withPredictions(film.lid, {
      watched: !!row.querySelector(".action.-watch.-on"),
      liked: !!row.querySelector(".action.-like.-on"),
      inWatchlist: !!row.querySelector(".action.-watchlist.-on, .remove-from-watchlist"),
    });
    if (noteBlock(film.lid, st) && isNotInterested(film)) autoUndo(film);
  }

  // ================================================================ actions
  // Show the fade right away, even though the pointer is still over the
  // poster (normally hovering un-fades it). Ends when the pointer leaves.
  function pinFade(item) {
    if (!item || item.classList.contains(`${NS}-pinned`)) return;
    item.classList.add(`${NS}-pinned`);
    item.addEventListener("mouseleave", () => item.classList.remove(`${NS}-pinned`), { once: true });
  }

  async function toggleNotInterested(film, button) {
    if (!film.lid) return toast("Couldn't identify this film.", true);
    const wasOn = isNotInterested(film);
    setMarked(film, !wasOn); // instant
    pinFade(button.parentElement);
    button.classList.add(`${NS}-busy`);
    try {
      if (!wasOn) await addToList(film);
      else await removeFromList(film);
      toast(wasOn ? `‘${film.name}’ removed from Not interested.` : `‘${film.name}’ marked Not interested.`);
    } catch (err) {
      setMarked(film, wasOn);
      toast(err.message || "Something went wrong.", true);
    } finally {
      button.classList.remove(`${NS}-busy`);
    }
  }

  function setWatchlistEverywhere(lid, state) {
    watchlistState.set(lid, state);
    document.querySelectorAll(`.${NS}-btn-wl[data-lid='${CSS.escape(lid)}']`).forEach((b) => {
      setWlButton(b, state);
      (b.closest(GRID_ITEM_SELECTOR) || b.parentElement)?.querySelector("[data-in-watchlist]")?.setAttribute("data-in-watchlist", String(state));
    });
  }

  async function toggleWatchlist(film, button) {
    if (!film.lid) return toast("Couldn't identify this film.", true);
    if (!watchlistState.has(film.lid)) await fetchWatchlistState(film.lid);
    const was = watchlistState.get(film.lid) === true;
    setWatchlistEverywhere(film.lid, !was); // instant
    applyAll();
    button.classList.add(`${NS}-busy`);
    try {
      const r = await api("PATCH", `/me/watchlist/${encodeURIComponent(film.lid)}`, { inWatchlist: !was });
      if (!r.ok) throw new Error(`Couldn't update your watchlist (HTTP ${r.status}).`);
      toast(was ? `‘${film.name}’ removed from your watchlist.` : `‘${film.name}’ added to your watchlist.`);
    } catch (err) {
      setWatchlistEverywhere(film.lid, was);
      applyAll();
      toast(err.message, true);
    } finally {
      button.classList.remove(`${NS}-busy`);
    }
  }

  // Letterboxd's own eye / heart / watchlist: update badges the moment you
  // click, without waiting for its server to answer.
  function predictFromNativeClick(target) {
    // Poster hover bar
    const poster = target.closest(POSTER_SELECTOR);
    if (poster && target.closest(".overlay-actions")) {
      const film = filmIdentity(poster);
      const st = statusOf(poster, film);
      let nowWatched = false;
      if (target.closest(".watch-link-target, .watch-link")) {
        nowWatched = !st.watched;
        predict(film.lid, { watched: nowWatched });
      } else if (target.closest(".like-link-target, .like-link")) {
        // Loving a film also marks it watched.
        nowWatched = !st.liked;
        predict(film.lid, st.liked ? { liked: false } : { liked: true, watched: true });
      } else return;
      if (nowWatched && st.inWatchlist) dropFromWatchlistAfterWatching(film);
      applyTo(poster);
      pinFade(gridItemOf(poster));
      return;
    }
    // Film-page sidebar
    const row = target.closest("#userpanel li.actions-row1");
    const link = document.querySelector(`.${NS}-panel-ni`);
    if (!row || !link) return;
    const lid = link.dataset.lid;
    const inWatchlist = !!row.querySelector(".action.-watchlist.-on, .remove-from-watchlist");
    let nowWatched = false;
    if (target.closest(".action.-watch")) {
      nowWatched = !row.querySelector(".action.-watch.-on");
      predict(lid, { watched: nowWatched });
    } else if (target.closest(".action.-like")) {
      const liked = !!row.querySelector(".action.-like.-on");
      nowWatched = !liked;
      predict(lid, liked ? { liked: false } : { liked: true, watched: true });
    } else if (target.closest(".action.-watchlist")) {
      predict(lid, { inWatchlist: !row.querySelector(".action.-watchlist.-on, .remove-from-watchlist") });
    } else return;
    if (nowWatched && inWatchlist) dropFromWatchlistAfterWatching(filmFromEl(link));
    applyAll();
  }

  // Seen it? Then it comes off your watchlist.
  async function dropFromWatchlistAfterWatching(film) {
    if (!film.lid) return;
    setWatchlistEverywhere(film.lid, false);
    predict(film.lid, { inWatchlist: false });
    try {
      const r = await api("PATCH", `/me/watchlist/${encodeURIComponent(film.lid)}`, { inWatchlist: false });
      if (!r.ok) throw new Error(`Couldn't take ‘${film.name}’ off your watchlist (HTTP ${r.status}).`);
      toast(`‘${film.name}’ removed from your watchlist — you've watched it.`);
    } catch (err) {
      setWatchlistEverywhere(film.lid, true);
      predict(film.lid, { inWatchlist: true });
      toast(err.message, true);
    }
    applyAll();
  }

  // ================================================================ filter menu
  // Letterboxd's eye menu lists every filter as a Show/Hide pair. We fold each
  // pair into one row (Show · Fade · Hide · Only) and add our own rows. The
  // native items stay in the page, hidden; our rows click them, so filtering
  // still happens exactly the way Letterboxd does it.
  const nativeItem = (cat, type) => document.querySelector(`li.js-film-filter[data-category='${cat}'][data-type='${type}']`);
  const nativeAvailable = (cat, type) => {
    const li = nativeItem(cat, type);
    return !!li && li.style.display !== "none";
  };
  const nativeState = (cat) =>
    document.querySelector(`li.js-film-filter.smenu-subselected[data-category='${cat}']`)?.dataset.type || null;

  // Turn a Letterboxd filter on ("show" = only these, "hide") or off (null).
  // Letterboxd saves it to your account and reloads the page.
  function setNative(cat, type) {
    const cur = nativeState(cat);
    if (cur === type) return false;
    const li = type ? nativeItem(cat, type) : nativeItem(cat, cur);
    li?.querySelector("a")?.click();
    return true;
  }

  const fadeToggle = () => document.querySelector("#hide-toggle-menu .js-fade-toggle input");
  const watchedFadeOn = () => fadeToggle()?.checked ?? /(?:^|;\s*)hideMyWatchedFilms=true/.test(document.cookie);
  function setWatchedFade(on) {
    // Same cookie Letterboxd's own switch uses (it ignores the switch while a
    // watched filter is on, so write it directly as well).
    document.cookie = on
      ? `hideMyWatchedFilms=true; path=/; max-age=${730 * 86400}`
      : "hideMyWatchedFilms=; path=/; max-age=0";
    const input = fadeToggle();
    if (input && window.jQuery && input.checked !== on) window.jQuery(input).prop("checked", on).trigger("change");
  }

  const LABELS = { show: "Show", fade: "Fade", hide: "Hide", only: "Only", on: "On", off: "Off" };

  // Each row: which choices it offers, how to read its state, how to set it.
  function nativeRow(label, cat, { fade } = {}) {
    if (!nativeAvailable(cat, "hide") && !nativeAvailable(cat, "show")) return null;
    const options = ["show"];
    if (fade) options.push("fade");
    if (nativeAvailable(cat, "hide")) options.push("hide");
    if (nativeAvailable(cat, "show")) options.push("only");
    const toType = { hide: "hide", only: "show" };
    return {
      label,
      options,
      get() {
        const n = nativeState(cat);
        if (n) return n === "show" ? "only" : "hide";
        return fade?.get() ? "fade" : "show";
      },
      set(v) {
        if (fade) fade.set(v === "fade");
        return setNative(cat, toType[v] || null);
      },
    };
  }

  // Watched / Liked / Watchlist: the extension already knows these for every
  // poster, so it filters them itself, instantly. The first time, it switches
  // off Letterboxd's own version of that filter so the two don't fight.
  function localRow(label, key, cat) {
    return {
      label,
      options: ["show", "fade", "hide", "only"],
      get() {
        const n = nativeState(cat); // Letterboxd's own version, if still on
        return n ? (n === "show" ? "only" : "hide") : prefs.filters[key];
      },
      set(v) {
        prefs.filters[key] = v;
        savePrefs();
        if (key === "watched" && watchedFadeOn()) setWatchedFade(false);
        return nativeState(cat) ? setNative(cat, null) : false;
      },
    };
  }

  function buildRows() {
    const account = [
      {
        label: "Status badges",
        options: ["on", "off"],
        get: () => (prefs.badgeStyle !== "none" ? "on" : "off"),
        set: (v) => {
          setBadgeStyle(v === "on" ? prefs.lastBadgeStyle || "current" : "none");
          renderToggles();
        },
      },
      "divider",
      localRow("Watched", "watched", "watched"),
      localRow("Liked", "liked", "liked"),
      localRow("Watchlist", "watchlist", "watchlisted"),
      {
        label: "Not interested",
        options: ["show", "fade", "hide", "only"],
        get: () => prefs.mode,
        set: (v) => {
          prefs.mode = v;
          savePrefs();
        },
      },
      "divider",
      nativeRow("Rated", "rated"),
      nativeRow("Logged", "logged"),
      nativeRow("Rewatched", "rewatched"),
      nativeRow("Reviewed", "reviewed"),
    ];
    const content = [
      nativeRow("Short films", "shorts"),
      nativeRow("TV shows", "tv"),
      nativeRow("Documentaries", "docs"),
      nativeRow("Unreleased", "unreleased"),
    ];
    return { account: account.filter(Boolean), content: content.filter(Boolean) };
  }

  function rowElement(row, divider) {
    const li = document.createElement("li");
    li.className = `${NS}-row${divider ? " divider-line -inset" : ""}`;
    const label = document.createElement("span");
    label.className = `${NS}-row-label`;
    label.textContent = row.label;
    const seg = document.createElement("span");
    seg.className = `${NS}-seg`;
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", row.label);
    for (const opt of row.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.value = opt;
      b.textContent = LABELS[opt];
      b.setAttribute("role", "radio");
      seg.append(b);
    }
    li.append(label, seg);
    li._row = row;
    li.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const b = e.target.closest("button[data-value]");
      if (!b || b.getAttribute("aria-checked") === "true") return;
      const reloading = row.set(b.dataset.value);
      renderMenu();
      if (!reloading) applyAll();
    });
    return li;
  }

  function injectMenu() {
    const menu = document.querySelector("#hide-toggle-menu");
    const accountList = document.querySelector("li.js-film-filter[data-category='watched']")?.parentElement;
    if (!menu || !accountList || menu.querySelector(`.${NS}-row`)) return;
    const contentList = document.querySelector("li.js-film-filter[data-category='tv'], li.js-film-filter[data-category='shorts']")?.parentElement;
    try {
      const rows = buildRows();
      const fill = (list, items) => {
        const frag = document.createDocumentFragment();
        let divider = false;
        for (const r of items) {
          if (r === "divider") divider = true;
          else {
            frag.append(rowElement(r, divider));
            divider = false;
          }
        }
        list.prepend(frag);
      };
      fill(accountList, rows.account);
      if (contentList && contentList !== accountList) fill(contentList, rows.content);
      else fill(accountList, rows.content);
      // Only now that our rows are in place, tuck the native ones away.
      menu.classList.add(`${NS}-compact`);
    } catch (err) {
      menu.querySelectorAll(`.${NS}-row`).forEach((r) => r.remove());
      menu.classList.remove(`${NS}-compact`);
      console.warn("[Letternoxd] couldn't build the compact filter menu", err);
    }
    renderMenu();
  }

  function renderMenu() {
    document.querySelectorAll(`.${NS}-row`).forEach((li) => {
      const value = li._row?.get();
      li.querySelectorAll("button[data-value]").forEach((b) => {
        b.setAttribute("aria-checked", String(b.dataset.value === value));
      });
    });
  }

  // ================================================================ temporary toggles menu
  // TEMPORARY: a plain floating panel (bottom right) for trying options out.
  // To be designed properly (or folded into the eye menu) later.
  const TOGGLES = [
    {
      label: "Badges",
      options: [["current", "Current"], ["ratings", "Ratings"], ["none", "None"]],
      get: () => prefs.badgeStyle,
      set: (v) => setBadgeStyle(v),
    },
    {
      label: "Rating look",
      options: [["plain", "3.5"], ["star", "★3.5"], ["half", "3½"], ["instar", "In star"]],
      get: () => prefs.ratingLook,
      set: (v) => {
        prefs.ratingLook = v;
        savePrefs();
      },
    },
  ];
  let togglesEl = null;
  function injectToggles() {
    if (togglesEl || !document.body) return;
    togglesEl = document.createElement("div");
    togglesEl.className = `${NS}-toggles`;
    togglesEl.innerHTML =
      `<button type="button" class="${NS}-toggles-open" aria-expanded="false">Letternoxd</button>` +
      `<div class="${NS}-toggles-panel" hidden>` +
      TOGGLES.map(
        (t, i) =>
          `<div class="${NS}-toggles-row"><span class="${NS}-row-label">${t.label}</span>` +
          `<span class="${NS}-seg" role="radiogroup" aria-label="${t.label}">` +
          t.options.map(([v, l]) => `<button type="button" role="radio" data-t="${i}" data-value="${v}">${l}</button>`).join("") +
          `</span></div>`
      ).join("") +
      `</div>`;
    const open = togglesEl.querySelector(`.${NS}-toggles-open`);
    const panel = togglesEl.querySelector(`.${NS}-toggles-panel`);
    togglesEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target.closest(`.${NS}-toggles-open`)) {
        panel.hidden = !panel.hidden;
        open.setAttribute("aria-expanded", String(!panel.hidden));
        return;
      }
      const b = e.target.closest("button[data-value]");
      if (!b) return;
      TOGGLES[b.dataset.t].set(b.dataset.value);
      renderToggles();
      renderMenu();
      applyAll();
    });
    document.addEventListener("click", (e) => {
      if (!panel.hidden && !togglesEl.contains(e.target)) {
        panel.hidden = true;
        open.setAttribute("aria-expanded", "false");
      }
    });
    document.body.append(togglesEl);
    renderToggles();
  }
  function renderToggles() {
    togglesEl?.querySelectorAll("button[data-value]").forEach((b) => {
      b.setAttribute("aria-checked", String(TOGGLES[b.dataset.t].get() === b.dataset.value));
    });
  }

  // ================================================================ "N hidden" note
  function updateHiddenNote() {
    const hidden = document.querySelectorAll(`.${NS}-hidden`);
    let note = document.querySelector(`.${NS}-note`);
    if (!hidden.length) return note?.remove();
    const grid = hidden[0].parentElement;
    if (!note) {
      note = document.createElement("p");
      note.className = `${NS}-note`;
    }
    if (note.previousElementSibling !== grid) grid.after(note);
    const n = hidden.length;
    note.textContent = `${n} film${n === 1 ? "" : "s"} on this page hidden by your filters`;
  }

  // ================================================================ toast
  function toast(message, isError = false) {
    if (!isError && window.bxd?.showMessages) {
      try {
        window.bxd.showMessages("success", message);
        return;
      } catch {}
    }
    const t = document.createElement("div");
    t.className = `${NS}-toast${isError ? ` ${NS}-toast-error` : ""}`;
    t.setAttribute("role", isError ? "alert" : "status");
    t.textContent = message;
    document.body.append(t);
    setTimeout(() => t.classList.add(`${NS}-toast-out`), isError ? 6000 : 2500);
    setTimeout(() => t.remove(), isError ? 6600 : 3100);
  }


  // ================================================================ updates
  // Batch DOM changes into one update per frame: new posters or menus → full
  // pass; a change inside one poster → just that poster.
  let scheduled = false;
  let fullPass = false;
  const dirtyPosters = new Set();
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (fullPass) {
        fullPass = false;
        dirtyPosters.clear();
        applyAll();
      } else {
        dirtyPosters.forEach((p) => p.isConnected && applyTo(p));
        dirtyPosters.clear();
      }
    });
  }
  const OWN = `.${NS}-ind, .${NS}-ring, .${NS}-corner, .${NS}-badges, .${NS}-rate, .${NS}-panel-ni, .${NS}-note, .${NS}-toggles`;

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      const t = m.target;
      if (m.type === "attributes") {
        if (t.closest?.(OWN)) continue;
        if (t.closest?.("#userpanel li.actions-row1")) {
          fullPass = true;
          schedule();
          continue;
        }
        const poster = t.closest?.(POSTER_SELECTOR);
        if (poster) {
          dirtyPosters.add(poster);
          schedule();
        }
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || n.closest?.(OWN) || n.matches?.(OWN)) continue;
        if (n.matches?.("li.js-film-filter") || n.querySelector?.("li.js-film-filter")) injectMenu();
        if (n.matches?.(POSTER_SELECTOR) || n.querySelector?.(POSTER_SELECTOR) || n.querySelector?.("ul.js-actions-panel")) {
          fullPass = true;
          schedule();
        } else {
          const poster = n.closest?.(POSTER_SELECTOR);
          if (poster) {
            dirtyPosters.add(poster);
            schedule();
          }
        }
      }
    }
  });

  // ================================================================ events
  document.addEventListener(
    "click",
    (e) => {
      const more = e.target.closest(`.${NS}-btn-more, .${NS}-rate`);
      if (more) {
        e.preventDefault();
        e.stopPropagation();
        more.parentElement?.querySelector(".overlay-actions .menu-link")?.click();
        return;
      }
      const btn = e.target.closest(`.${NS}-btn, .${NS}-panel-ni`);
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        if (btn.classList.contains(`${NS}-busy`) || btn.classList.contains(`${NS}-blocked`)) return;
        const film = filmFromEl(btn);
        if (btn.classList.contains(`${NS}-btn-wl`)) toggleWatchlist(film, btn);
        else toggleNotInterested(film, btn);
        return;
      }
      // Not ours: maybe Letterboxd's eye / heart / watchlist. Let it through,
      // but update our badges straight away.
      if (USER) predictFromNativeClick(e.target);
    },
    true
  );

  document.addEventListener(
    "mouseover",
    (e) => {
      const item = e.target.closest?.(`.${NS}-host`);
      if (!item) return;
      const attempt = (n) => {
        if (!swapIntoBar(item) && n > 0) setTimeout(() => attempt(n - 1), 60);
      };
      attempt(5);
    },
    { passive: true }
  );

  // Coming back to the tab after a while: pick up changes made elsewhere
  // (another tab, the phone app).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !USER) return;
    if (Date.now() - (cache.syncedAt || 0) > RESYNC_ON_RETURN_MS) syncList({ force: true });
  });

  // Another Letterboxd tab changed the list or your menu choices.
  window.addEventListener("storage", (e) => {
    if (!USER) return;
    if (e.key === cacheKey(USER)) {
      loadCache(USER);
      applyAll();
    } else if (e.key === PREFS_KEY) {
      Object.assign(prefs, readJSON(PREFS_KEY, {}));
      renderMenu();
      renderToggles();
      applyAll();
    }
  });

  // ================================================================ start
  function start() {

    USER = !document.body.classList.contains("logged-out") ? readUser() : null;
    if (!USER) return dropEarlyStyle();
    writeJSON(LAST_USER_KEY, USER);
    loadCache(USER);

    // Our Watched row replaces Letterboxd's "Fade watched films" switch.
    if (watchedFadeOn()) setWatchedFade(false);
    injectMenu();
    injectToggles();
    applyAll();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-watched", "data-in-watchlist"],
    });
    syncList();
  }

  // Troubleshooting from the browser console.
  window.lbNotInterested = {
    resync: () => syncList({ force: true }),
    state: () => ({ prefs, user: USER, ...cache, lidSet: undefined, slugSet: undefined }),
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
