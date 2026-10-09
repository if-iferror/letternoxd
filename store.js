/*
 * Letternoxd Video Store (prototype: the Horror aisle, Main wing).
 *
 * Opens over any Letterboxd page at #store. Every shelf is a Letterboxd
 * browse query sorted by popularity. A film sits on exactly one shelf: the
 * most specific shelf it fits, in SHELF_PRIORITY order; whatever is left goes
 * to "Everything else". Only the Main wing is stocked here: films ranked in
 * the top 9,360 of Horror by popularity (about 1,000+ watches).
 *
 * The stock list is built once (about 230 small page reads) and kept for a
 * week in localStorage. Posters load as their shelf scrolls into view.
 */
(() => {
  "use strict";
  if (window.__lbniStore) return;
  window.__lbniStore = true;

  const NS = "lbni";
  const CACHE_KEY = `${NS}:store:horror:v1`;
  const POSTER_KEY = `${NS}:store:posters`;
  const CACHE_MS = 7 * 864e5;
  const PER_PAGE = 72;
  const MAIN_PAGES = 130; // ranks 1-9,360
  const WINGS = [
    { id: "main", name: "Main", count: 9360, open: true },
    { id: "obscure", name: "Obscure", count: 15480, open: false },
    { id: "ultra", name: "Ultra-obscure", count: 53002, open: false },
  ];

  // Display order. `q` is the Letterboxd browse path.
  const SHELVES = [
    { id: "slashers", name: "Slashers", q: "genre/horror/mini-theme/killing-slasher-gruesome-gory-bloody" },
    { id: "haunted", name: "Haunted & Supernatural", q: "genre/horror/mini-theme/supernatural-chilling-eerie-terrifying-dread" },
    { id: "creepy", name: "Creepy & Chilling", q: "genre/horror/mini-theme/chilling-eerie-terrifying-terror-frighten" },
    { id: "gothic", name: "Gothic", q: "genre/horror/mini-theme/eerie-blood-gothic-mysterious-bizarre" },
    { id: "vampires", name: "Vampires", q: "genre/horror/mini-theme/vampires-blood-undead-cool-bloody" },
    { id: "zombies", name: "Zombies & Survival", q: "genre/horror/mini-theme/zombies-undead-flesh-blood-infected" },
    { id: "creature", name: "Creature Features", q: "genre/horror/mini-theme/creature-monster-scary-horror-suspense" },
    { id: "madsci", name: "Mad Science & Classic Monsters", q: "genre/horror/mini-theme/scientist-monster-doctor-experiment-creature" },
    { id: "extreme", name: "Extreme", q: "genre/horror/mini-theme/cannibals-gruesome-graphic-shock-gory" },
    { id: "giallo", name: "Giallo", q: "genre/horror/country/italy/decade/1970s" },
    { id: "eighties", name: "’80s Horror", q: "genre/horror/decade/1980s" },
    { id: "jhorror", name: "J-Horror", q: "genre/horror/country/japan" },
    { id: "comedy", name: "Horror-Comedy", q: "genre/horror+comedy" },
  ];
  // Which shelf wins when a film fits several: the most specific first.
  const SHELF_PRIORITY = ["giallo", "jhorror", "vampires", "zombies", "madsci", "extreme", "creature", "slashers", "gothic", "haunted", "creepy", "eighties", "comedy"];
  const EVERYTHING = { id: "rest", name: "Everything Else", q: "genre/horror" };

  const ROW_LIMIT = 60; // posters in a closed shelf
  const GRID_STEP = 120; // posters added per "Show more" in an open shelf

  /* ---------------- small helpers ---------------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const h = (tag, cls, html) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = (n) => n.toLocaleString("en-US");
  const readJSON = (k, d) => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; }
  };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

  // Run async jobs with at most `n` in flight.
  function limiter(n) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= n || !queue.length) return;
      active++;
      const { fn, ok, fail } = queue.shift();
      fn().then(ok, fail).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((ok, fail) => { queue.push({ fn, ok, fail }); next(); });
  }
  const pageLimit = limiter(6);
  const posterLimit = limiter(6);

  /* ---------------- reading Letterboxd ---------------- */

  // One page of a browse query, in popularity order: [{ slug, name }]
  async function readPage(path, page, sort = "by/popular") {
    const url = `/csi/films/films-browser-list/${path}/${sort ? sort + "/" : ""}${page > 1 ? `page/${page}/` : ""}?esiAllowFilters=false`;
    const res = await pageLimit(() => fetch(url, { credentials: "include" }));
    if (!res.ok) throw new Error(`Letterboxd answered ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    return [...doc.querySelectorAll("[data-item-slug]")].map((el) => ({
      slug: el.dataset.itemSlug,
      name: el.dataset.itemName || el.dataset.itemFullDisplayName || el.dataset.itemSlug,
    }));
  }

  /* ---------------- building the stock list ---------------- */

  let stock = null; // { at, films: [[slug, name]], shelves: { id: [index] }, front: [index|{slug,name}] }
  let building = null;

  function loadStock() {
    const s = readJSON(CACHE_KEY, null);
    if (s && s.v === 1 && Date.now() - s.at < CACHE_MS && Array.isArray(s.films)) return s;
    return null;
  }

  function buildStock(onProgress) {
    if (building) return building;
    building = (async () => {
      let done = 0;
      let total = MAIN_PAGES + SHELVES.length * 3; // a guess, refined as shelves finish
      const tick = () => onProgress && onProgress(Math.min(done / total, 0.99));

      // 1. The Main wing: Horror's top 130 pages by popularity.
      const pages = await Promise.all(
        Array.from({ length: MAIN_PAGES }, (_, i) =>
          readPage("genre/horror", i + 1).then((films) => { done++; tick(); return films; })
        )
      );
      const films = [];
      const index = new Map();
      for (const film of pages.flat()) {
        if (index.has(film.slug)) continue;
        index.set(film.slug, films.length);
        films.push([film.slug, film.name]);
      }

      // 2. Each shelf: read pages until one has no Main-wing films left.
      //    (Same popularity order, so Main films always come first.)
      const members = {};
      await Promise.all(
        SHELVES.map(async (shelf) => {
          const got = [];
          for (let p = 1; p <= 60; p++) {
            const list = await readPage(shelf.q, p);
            done++;
            const hits = list.map((f) => index.get(f.slug)).filter((i) => i != null);
            got.push(...hits);
            if (p > 3) total++;
            tick();
            if (!hits.length || list.length < PER_PAGE) break;
          }
          members[shelf.id] = got;
        })
      );

      // 3. One place per film: the most specific shelf wins.
      const placed = new Set();
      const shelves = {};
      for (const id of SHELF_PRIORITY) {
        shelves[id] = (members[id] || []).filter((i) => !placed.has(i));
        shelves[id].forEach((i) => placed.add(i));
      }
      shelves.rest = films.map((_, i) => i).filter((i) => !placed.has(i));

      // 4. Front display: what's popular in Horror this week (may repeat shelves).
      let front = [];
      try {
        front = (await readPage("popular/this/week/genre/horror", 1, "")).slice(0, 14).map((f) => [f.slug, f.name]);
      } catch {}

      const s = { v: 1, at: Date.now(), films, shelves, front };
      writeJSON(CACHE_KEY, s);
      onProgress && onProgress(1);
      return s;
    })().finally(() => { building = null; });
    return building;
  }

  /* ---------------- posters ---------------- */

  const posterCache = new Map(Object.entries(readJSON(POSTER_KEY, {})));
  let posterSaveTimer = 0;
  function rememberPoster(slug, urls) {
    posterCache.set(slug, urls);
    clearTimeout(posterSaveTimer);
    posterSaveTimer = setTimeout(() => {
      // Keep the most recent 4,000 so localStorage stays small.
      const entries = [...posterCache.entries()].slice(-4000);
      writeJSON(POSTER_KEY, Object.fromEntries(entries));
    }, 1500);
  }

  async function posterFor(slug) {
    const hit = posterCache.get(slug);
    if (hit) return hit;
    const res = await posterLimit(() => fetch(`/film/${slug}/poster/std/150/`, { credentials: "include" }));
    if (!res.ok) throw new Error("no poster");
    const j = await res.json();
    const urls = [j.url, j.url2x || j.url];
    rememberPoster(slug, urls);
    return urls;
  }

  const io = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          fillPoster(e.target);
        }
      }, { rootMargin: "300px 600px" })
    : null;

  function fillPoster(el) {
    const img = el.querySelector("img");
    posterFor(el.dataset.slug)
      .then(([one, two]) => {
        img.src = one;
        img.srcset = `${one} 1x, ${two} 2x`;
        el.classList.add("lbs-loaded");
      })
      .catch(() => el.classList.add("lbs-noposter"));
  }

  const EMPTY = "https://s.ltrbxd.com/static/img/empty-poster-150-DtnLDE3k.png";

  function posterEl([slug, name]) {
    const li = h("li", "lbs-item");
    li.dataset.slug = slug;
    li.innerHTML =
      `<div class="poster film-poster lbs-poster">` +
      `<img class="image" src="${EMPTY}" width="150" height="225" alt="${esc(name)}" loading="lazy" decoding="async">` +
      `<a class="frame" href="/film/${esc(slug)}/" title="${esc(name)}"><span class="frame-title">${esc(name)}</span><span class="overlay"></span></a>` +
      `</div>`;
    const cached = posterCache.get(slug);
    if (cached) {
      const img = li.querySelector("img");
      img.src = cached[0];
      img.srcset = `${cached[0]} 1x, ${cached[1]} 2x`;
      li.classList.add("lbs-loaded");
    } else if (io) io.observe(li);
    else fillPoster(li);
    return li;
  }

  /* ---------------- the store overlay ---------------- */

  let root = null;
  let wing = "main";

  const ICON_CLOSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  const ICON_LEFT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ICON_RIGHT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function openStore() {
    if (!document.body) return;
    if (!root) {
      root = h("div", "lbs-root");
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "Letternøxd Video Store");
      document.body.append(root);
      root.addEventListener("click", onClick);
    }
    document.documentElement.classList.add("lbs-open");
    root.hidden = false;
    render();
  }

  function closeStore() {
    if (!root) return;
    root.hidden = true;
    document.documentElement.classList.remove("lbs-open");
  }

  function leaveStore() {
    if (history.state && history.state.lbsStore) history.back();
    else {
      history.replaceState(history.state, "", location.pathname + location.search);
      closeStore();
    }
  }

  function render() {
    stock = stock || loadStock();
    const total = stock ? stock.films.length : WINGS[0].count;
    root.innerHTML =
      `<header class="lbs-top">` +
      `<div class="lbs-top-inner">` +
      `<div class="lbs-brand">letternøxd <span>video store</span></div>` +
      `<nav class="lbs-wings" aria-label="Wings">` +
      WINGS.map((w) =>
        `<button type="button" class="lbs-wing${w.id === wing ? " -on" : ""}${w.open ? "" : " -soon"}" data-wing="${w.id}"${w.open ? "" : ' aria-disabled="true"'}>` +
        `${w.name} <span>${fmt(w.id === "main" ? total : w.count)}</span>${w.open ? "" : '<em>soon</em>'}</button>`
      ).join("") +
      `</nav>` +
      `<button type="button" class="lbs-close" data-act="close" aria-label="Leave the store">${ICON_CLOSE}</button>` +
      `</div></header>` +
      `<main class="lbs-aisle">` +
      `<div class="lbs-sign"><h1>Horror</h1><p>${stock ? `${fmt(total)} films in the Main wing, ${SHELVES.length + 1} shelves. Each film sits on one shelf.` : "Stocking the shelves…"}</p></div>` +
      `<div class="lbs-body"></div>` +
      `</main>`;

    const body = $(".lbs-body", root);
    if (stock) return fillAisle(body);

    const bar = h("div", "lbs-loading", `<div class="lbs-meter"><i></i></div><p>Reading Horror's top ${fmt(WINGS[0].count)} films from Letterboxd. This happens once a week and takes about a minute.</p>`);
    body.append(bar);
    buildStock((f) => {
      const i = $(".lbs-meter i", root);
      if (i) i.style.width = `${Math.round(f * 100)}%`;
    })
      .then((s) => { stock = s; if (root && !root.hidden) render(); })
      .catch((err) => {
        bar.innerHTML = `<p>Couldn't stock the shelves (${esc(err.message)}). <button type="button" class="lbs-retry" data-act="retry">Try again</button></p>`;
      });
  }

  function fillAisle(body) {
    const film = (i) => stock.films[i];
    if (stock.front && stock.front.length) {
      body.append(shelfEl({ id: "front", name: "Front Display", note: "popular this week" }, stock.front, { front: true }));
    }
    for (const shelf of [...SHELVES, EVERYTHING]) {
      const items = (stock.shelves[shelf.id] || []).map(film);
      if (items.length) body.append(shelfEl(shelf, items));
    }
    const foot = h("p", "lbs-foot");
    foot.innerHTML = `Stock list from ${new Date(stock.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}. <button type="button" data-act="restock">Restock now</button>`;
    body.append(foot);
  }

  function shelfEl(shelf, items, { front = false } = {}) {
    const sec = h("section", `lbs-shelf${front ? " -front" : ""}`);
    sec.dataset.shelf = shelf.id;
    sec._items = items;
    sec._shown = 0;
    const more = !front && items.length > 8;
    sec.innerHTML =
      `<div class="lbs-label">` +
      `<h2>${esc(shelf.name)}</h2>` +
      `<span class="lbs-count">${shelf.note ? esc(shelf.note) : `${fmt(items.length)} film${items.length === 1 ? "" : "s"}`}</span>` +
      (more ? `<button type="button" class="lbs-all" data-act="expand">See all</button>` : "") +
      `</div>` +
      `<div class="lbs-rack">` +
      `<button type="button" class="lbs-nudge -left" data-act="left" aria-label="Scroll left" hidden>${ICON_LEFT}</button>` +
      `<ul class="lbs-row"></ul>` +
      `<button type="button" class="lbs-nudge -right" data-act="right" aria-label="Scroll right">${ICON_RIGHT}</button>` +
      `</div>` +
      `<div class="lbs-ledge"></div>`;
    const row = $(".lbs-row", sec);
    addPosters(sec, Math.min(items.length, ROW_LIMIT));
    row.addEventListener("scroll", () => nudges(sec), { passive: true });
    requestAnimationFrame(() => nudges(sec));
    return sec;
  }

  function addPosters(sec, upTo) {
    const row = $(".lbs-row", sec);
    const frag = document.createDocumentFragment();
    for (let i = sec._shown; i < upTo; i++) frag.append(posterEl(sec._items[i]));
    sec._shown = Math.max(sec._shown, upTo);
    row.append(frag);
    let tail = $(".lbs-more", sec);
    if (sec.classList.contains("-grid") && sec._shown < sec._items.length) {
      if (!tail) {
        tail = h("div", "lbs-more");
        sec.append(tail);
      }
      tail.innerHTML = `<button type="button" data-act="more">Show more <span>${fmt(sec._items.length - sec._shown)} left</span></button>`;
    } else if (tail) tail.remove();
  }

  function nudges(sec) {
    const row = $(".lbs-row", sec);
    const grid = sec.classList.contains("-grid");
    const l = $(".lbs-nudge.-left", sec);
    const r = $(".lbs-nudge.-right", sec);
    if (!l || !r) return;
    l.hidden = grid || row.scrollLeft < 4;
    r.hidden = grid || row.scrollLeft + row.clientWidth >= row.scrollWidth - 4;
  }

  function onClick(e) {
    const btn = e.target.closest("[data-act], [data-wing]");
    if (!btn || !root.contains(btn)) return;
    const sec = btn.closest(".lbs-shelf");
    const act = btn.dataset.act;
    if (btn.dataset.wing) {
      if (btn.getAttribute("aria-disabled") === "true") return;
      wing = btn.dataset.wing;
      return render();
    }
    if (act === "close") return leaveStore();
    if (act === "retry") return render();
    if (act === "restock") {
      try { localStorage.removeItem(CACHE_KEY); } catch {}
      stock = null;
      return render();
    }
    if (!sec) return;
    const row = $(".lbs-row", sec);
    if (act === "left" || act === "right") {
      row.scrollBy({ left: (act === "left" ? -1 : 1) * Math.max(row.clientWidth - 160, 300), behavior: "smooth" });
    } else if (act === "expand") {
      const open = !sec.classList.contains("-grid");
      sec.classList.toggle("-grid", open);
      btn.textContent = open ? "Show less" : "See all";
      if (open) addPosters(sec, Math.min(sec._items.length, Math.max(sec._shown, GRID_STEP)));
      else {
        [...row.children].slice(ROW_LIMIT).forEach((n) => n.remove());
        sec._shown = Math.min(sec._shown, ROW_LIMIT);
        $(".lbs-more", sec)?.remove();
        row.scrollLeft = 0;
        sec.scrollIntoView({ block: "nearest" });
      }
      nudges(sec);
    } else if (act === "more") {
      addPosters(sec, Math.min(sec._items.length, sec._shown + GRID_STEP));
    }
  }

  /* ---------------- ways in ---------------- */

  function syncToHash() {
    if (/^#store\b/.test(location.hash)) openStore();
    else closeStore();
  }

  function enterStore(e) {
    if (e) e.preventDefault();
    if (/^#store\b/.test(location.hash)) return openStore();
    history.pushState({ ...(history.state || {}), lbsStore: true }, "", "#store");
    openStore();
  }

  // A "Store" item in Letterboxd's main navigation, right after Films.
  function addNavItem() {
    if (document.querySelector(".lbs-nav")) return;
    const films = [...document.querySelectorAll("header a[href='/films/'], .main-nav a[href='/films/']")].find((a) => a.closest("li"));
    if (!films) return;
    const li = films.closest("li");
    const item = li.cloneNode(false);
    item.classList.add("lbs-nav");
    item.classList.remove("-active", "active", "-selected");
    const a = films.cloneNode(false);
    a.removeAttribute("aria-current");
    a.href = "#store";
    a.textContent = "Store";
    a.addEventListener("click", enterStore);
    item.append(a);
    li.after(item);
  }

  // On the home page: a strip that shows the front display and walks you in.
  function addHomeStrip() {
    if (location.pathname !== "/" || document.querySelector(".lbs-home")) return;
    const host = document.querySelector("#content .content-wrap") || document.querySelector("#content");
    if (!host) return;
    const strip = h("section", "lbs-home");
    strip.innerHTML =
      `<a class="lbs-home-door" href="#store">` +
      `<span class="lbs-home-kicker">letternøxd video store</span>` +
      `<span class="lbs-home-title">The Horror aisle is open</span>` +
      `<span class="lbs-home-sub">${SHELVES.length + 1} shelves, every film in one place. Walk in →</span>` +
      `</a>`;
    strip.querySelector("a").addEventListener("click", enterStore);
    // Just under "Welcome back…", above your friends' activity.
    const hero = host.querySelector(":scope > .title-hero");
    if (hero) hero.after(strip);
    else host.prepend(strip);
  }

  function boot() {
    addNavItem();
    addHomeStrip();
    syncToHash();
  }

  window.addEventListener("hashchange", syncToHash);
  window.addEventListener("popstate", syncToHash);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && root && !root.hidden) leaveStore();
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  // Letterboxd sometimes redraws its header after load.
  setTimeout(addNavItem, 1500);
})();
