/*
 * Letternoxd Video Store (prototype: the Horror wing, Main collection).
 *
 * Opens over any Letterboxd page at #store, laid out like a real store:
 *   WING    Horror. One long wall you walk along.
 *   AISLE   '80s Horror, Zombies... Side by side, A-Z, "Everything Else" last.
 *           A wooden sign along the top, repeating as you walk.
 *   SHELF   One subcategory per shelf row (Classic Zombies, Zombie Comedies...),
 *           filed A-Z by title, labelled with taped laminated tags on the shelf
 *           edge, repeating. When a subcategory runs out, the next one starts
 *           to its right on that same shelf.
 *
 * A film sits in exactly one aisle (the most specific it fits, in
 * AISLE_PRIORITY order) and exactly one shelf in it (the first SHELF_RULES
 * rule it matches). Only the end cap ("Popular This Week") may repeat.
 *
 * Main collection = Horror's top 9,360 by Letterboxd popularity (about 1,000+
 * watches). Everything comes from Letterboxd's browse pages, read once a week
 * and kept in localStorage. Posters load as you walk up to them.
 */
(() => {
  "use strict";
  if (window.__lbniStore) return;
  window.__lbniStore = true;

  const NS = "lbni";
  const CACHE_KEY = `${NS}:store:horror:v2`;
  const OLD_KEYS = [`${NS}:store:horror:v1`];
  const POSTER_KEY = `${NS}:store:posters`;
  const CACHE_MS = 7 * 864e5;
  const PER_PAGE = 72;
  const MAIN_PAGES = 130; // ranks 1-9,360
  const COLLECTIONS = [
    { id: "main", name: "Main", count: 9360, open: true },
    { id: "obscure", name: "Obscure", count: 15480, open: false },
    { id: "ultra", name: "Ultra-obscure", count: 53002, open: false },
  ];

  /* ---------------- the floor plan ---------------- */

  // Aisles. `q` is the Letterboxd browse path; one/many name the shelves.
  const AISLES = [
    { id: "slashers", name: "Slashers", q: "genre/horror/mini-theme/killing-slasher-gruesome-gory-bloody", one: "Slasher", many: "Slashers" },
    { id: "haunted", name: "Haunted & Supernatural", q: "genre/horror/mini-theme/supernatural-chilling-eerie-terrifying-dread", one: "Ghost Story", many: "Ghost Stories" },
    { id: "creepy", name: "Creepy & Chilling", q: "genre/horror/mini-theme/chilling-eerie-terrifying-terror-frighten", one: "Chiller", many: "Chillers" },
    { id: "gothic", name: "Gothic", q: "genre/horror/mini-theme/eerie-blood-gothic-mysterious-bizarre", one: "Gothic", many: "Gothic Horror" },
    { id: "vampires", name: "Vampires", q: "genre/horror/mini-theme/vampires-blood-undead-cool-bloody", one: "Vampire", many: "Vampires" },
    { id: "zombies", name: "Zombies & Survival", q: "genre/horror/mini-theme/zombies-undead-flesh-blood-infected", one: "Zombie", many: "Zombies" },
    { id: "creature", name: "Creature Features", q: "genre/horror/mini-theme/creature-monster-scary-horror-suspense", one: "Creature", many: "Creature Features" },
    { id: "madsci", name: "Mad Science & Classic Monsters", q: "genre/horror/mini-theme/scientist-monster-doctor-experiment-creature", one: "Mad Science", many: "Mad Science" },
    { id: "extreme", name: "Extreme", q: "genre/horror/mini-theme/cannibals-gruesome-graphic-shock-gory", one: "Extreme", many: "Extreme Horror" },
    { id: "giallo", name: "Giallo", q: "genre/horror/country/italy/decade/1970s", one: "Giallo", many: "Gialli", decade: 1970, noWorld: true },
    { id: "eighties", name: "’80s Horror", q: "genre/horror/decade/1980s", one: "’80s Horror", many: "’80s Horror", decade: 1980 },
    { id: "jhorror", name: "J-Horror", q: "genre/horror/country/japan", one: "J-Horror", many: "J-Horror", noWorld: true },
    { id: "comedy", name: "Horror-Comedy", q: "genre/horror+comedy", one: "Horror-Comedy", many: "Horror-Comedies", noComedy: true },
  ];
  // Which aisle wins when a film fits several: the most specific first.
  const AISLE_PRIORITY = ["giallo", "jhorror", "vampires", "zombies", "madsci", "extreme", "creature", "slashers", "gothic", "haunted", "creepy", "eighties", "comedy"];
  const EVERYTHING = { id: "rest", name: "Everything Else", q: "genre/horror", one: "Horror", many: "Horror" };

  // Tags read for every film, used to split aisles into shelves.
  const WORLD = ["japan", "south-korea", "france", "italy", "spain", "germany", "mexico", "india", "thailand", "hong-kong", "china", "taiwan", "indonesia", "philippines", "brazil", "argentina", "sweden", "norway", "denmark", "finland", "poland", "russia", "turkey", "iran", "belgium", "netherlands"];
  const TAGS = [
    ...["comedy", "science-fiction", "action", "thriller", "drama", "fantasy", "mystery", "romance", "animation", "crime"].map((g) => ({ id: g, q: `genre/horror+${g}` })),
    ...WORLD.map((c) => ({ id: "world", q: `genre/horror/country/${c}` })),
  ];

  // Shelves inside each aisle. A film goes on the FIRST rule it matches
  // (genre blends first, then era); shelves show in `order` from the top.
  // A rule matching fewer than MIN_SHELF films is dropped and its films fall
  // through to the next rule.
  const MIN_SHELF = 4;
  const era = (y, a, b) => y >= a && y < b;
  const SHELF_RULES = [
    { id: "anim", order: 12, name: (a) => `Animated ${a.many}`, test: (f) => f.tags.has("animation") },
    { id: "comedy", order: 5, name: (a) => `${a.one} Comedies`, test: (f, a) => !a.noComedy && f.tags.has("comedy") },
    { id: "romance", order: 10, name: (a) => `${a.one} Romance`, test: (f) => f.tags.has("romance") },
    { id: "scifi", order: 6, name: (a) => `Sci-Fi ${a.many}`, test: (f) => f.tags.has("science-fiction") },
    { id: "action", order: 7, name: (a) => `${a.one} Action`, test: (f) => f.tags.has("action") },
    { id: "fantasy", order: 11, name: (a) => `Dark Fantasy ${a.many}`, test: (f) => f.tags.has("fantasy") },
    { id: "world", order: 9, name: (a) => `World ${a.many}`, test: (f, a) => !a.noWorld && f.tags.has("world") },
    // Era: decades, or thirds of the decade for a one-decade aisle.
    { id: "e1", order: 1, name: (a) => (a.decade ? `${a.decade}–${a.decade + 3}` : `Classic ${a.many}`), test: (f, a) => (a.decade ? era(f.year, a.decade, a.decade + 4) : f.year > 0 && f.year < 1970) },
    { id: "e2", order: 2, name: (a) => (a.decade ? `${a.decade + 4}–${a.decade + 6}` : `’70s & ’80s ${a.many}`), test: (f, a) => (a.decade ? era(f.year, a.decade + 4, a.decade + 7) : era(f.year, 1970, 1990)) },
    { id: "thrill", order: 8, name: (a) => `${a.one} Thrillers`, test: (f) => f.tags.has("thriller") || f.tags.has("mystery") || f.tags.has("crime") },
    { id: "drama", order: 13, name: (a) => `${a.one} Dramas`, test: (f) => f.tags.has("drama") },
    { id: "e3", order: 3, name: (a) => (a.decade ? `${a.decade + 7}–${a.decade + 9}` : `’90s & 2000s ${a.many}`), test: (f, a) => (a.decade ? era(f.year, a.decade + 7, a.decade + 10) : era(f.year, 1990, 2010)) },
    { id: "e4", order: 4, name: (a) => (a.decade ? `More ${a.many}` : `Modern ${a.many}`), test: () => true },
  ];

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
  const pageLimit = limiter(8);
  const posterLimit = limiter(6);

  /* ---------------- reading Letterboxd ---------------- */

  // One page of a browse query, in popularity order: [{ slug, name }]
  async function readPage(path, page, sort = "by/popular") {
    const url = `/csi/films/films-browser-list/${path}/${sort ? sort + "/" : ""}${page > 1 ? `page/${page}/` : ""}?esiAllowFilters=false`;
    let res;
    for (let tries = 0; tries < 3; tries++) {
      res = await pageLimit(() => fetch(url, { credentials: "include" }));
      if (res.ok || res.status === 404) break;
      await new Promise((r) => setTimeout(r, 800 * (tries + 1)));
    }
    if (!res.ok) throw new Error(`Letterboxd answered ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    return [...doc.querySelectorAll("[data-item-slug]")].map((el) => ({
      slug: el.dataset.itemSlug,
      name: el.dataset.itemName || el.dataset.itemFullDisplayName || el.dataset.itemSlug,
    }));
  }

  // Every Main-collection film in a query. Same popularity order as the Main
  // list, so Main films always come first: stop at the first page with none.
  async function readMembers(q, index, tick) {
    const got = [];
    for (let p = 1; p <= 80; p++) {
      const list = await readPage(q, p);
      const hits = list.map((f) => index.get(f.slug)).filter((i) => i != null);
      got.push(...hits);
      tick(p);
      if (!hits.length || list.length < PER_PAGE) break;
    }
    return got;
  }

  /* ---------------- building the stock list ---------------- */

  let stock = null; // { v, at, films: [[slug, name]], aisles: { id: [i] }, tags: { id: [i] }, front: [[slug, name]] }
  let building = null;

  function loadStock() {
    OLD_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch {} });
    const s = readJSON(CACHE_KEY, null);
    if (s && s.v === 2 && Date.now() - s.at < CACHE_MS && Array.isArray(s.films)) return s;
    return null;
  }

  function buildStock(onProgress) {
    if (building) return building;
    building = (async () => {
      let done = 0;
      let total = MAIN_PAGES + AISLES.length * 3 + TAGS.length * 4; // a guess, refined as we go
      const tick = (p) => {
        done++;
        if (p > 3) total++;
        onProgress && onProgress(Math.min(done / total, 0.99));
      };

      // 1. The Main collection: Horror's top 130 pages by popularity.
      const pages = await Promise.all(Array.from({ length: MAIN_PAGES }, (_, i) => readPage("genre/horror", i + 1).then((l) => { tick(0); return l; })));
      const films = [];
      const index = new Map();
      for (const film of pages.flat()) {
        if (index.has(film.slug)) continue;
        index.set(film.slug, films.length);
        films.push([film.slug, film.name]);
      }

      // 2. Aisles and tags, all at once.
      const [aisleLists, tagLists, front] = await Promise.all([
        Promise.all(AISLES.map((a) => readMembers(a.q, index, tick))),
        Promise.all(TAGS.map((t) => readMembers(t.q, index, tick))),
        readPage("popular/this/week/genre/horror", 1, "").catch(() => []),
      ]);

      // 3. One aisle per film: the most specific wins.
      const members = Object.fromEntries(AISLES.map((a, n) => [a.id, aisleLists[n]]));
      const placed = new Set();
      const aisles = {};
      for (const id of AISLE_PRIORITY) {
        aisles[id] = (members[id] || []).filter((i) => !placed.has(i));
        aisles[id].forEach((i) => placed.add(i));
      }
      aisles.rest = films.map((_, i) => i).filter((i) => !placed.has(i));

      const tags = {};
      TAGS.forEach((t, n) => { (tags[t.id] = tags[t.id] || []).push(...tagLists[n]); });

      const s = { v: 2, at: Date.now(), films, aisles, tags, front: front.slice(0, 15).map((f) => [f.slug, f.name]) };
      writeJSON(CACHE_KEY, s);
      onProgress && onProgress(1);
      return s;
    })().finally(() => { building = null; });
    return building;
  }

  /* ---------------- filing ---------------- */

  const yearOf = (name) => +((String(name).match(/\((\d{4})\)\s*$/) || [])[1] || 0);
  const titleOf = (name) => String(name).replace(/\s*\(\d{4}\)\s*$/, "");
  // "The Shining" files under S. Accents ignored, numbers before A.
  const fileKey = (name) =>
    titleOf(name)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/^(the|a|an)\s+/i, "")
      .replace(/^[^a-z0-9]+/i, "")
      .toLowerCase();
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const byTitle = (a, b) => collator.compare(fileKey(a[1]), fileKey(b[1])) || yearOf(a[1]) - yearOf(b[1]);

  // Split one aisle's films into shelves.
  function shelvesFor(aisle, idxs, tagSets) {
    const films = idxs.map((i) => {
      const [slug, name] = stock.films[i];
      const tags = new Set();
      for (const [t, set] of tagSets) if (set.has(i)) tags.add(t);
      return { i, slug, name, year: yearOf(name), tags };
    });
    let rules = SHELF_RULES.slice();
    for (;;) {
      const groups = new Map(rules.map((r) => [r, []]));
      for (const f of films) {
        const r = rules.find((r) => r.test(f, aisle));
        groups.get(r).push(f);
      }
      const tiny = rules.find((r) => r.id !== "e4" && groups.get(r).length > 0 && groups.get(r).length < MIN_SHELF);
      if (tiny) { rules = rules.filter((r) => r !== tiny); continue; }
      return [...groups]
        .filter(([, list]) => list.length)
        .sort(([a], [b]) => a.order - b.order)
        .map(([r, list]) => ({ id: r.id, name: r.name(aisle), items: list.map((f) => [f.slug, f.name]).sort(byTitle) }));
    }
  }

  /* ---------------- posters ---------------- */

  const posterCache = new Map(Object.entries(readJSON(POSTER_KEY, {})));
  let posterSaveTimer = 0;
  function rememberPoster(slug, urls) {
    posterCache.set(slug, urls);
    clearTimeout(posterSaveTimer);
    posterSaveTimer = setTimeout(() => {
      // Keep the most recent 4,000 so localStorage stays small.
      writeJSON(POSTER_KEY, Object.fromEntries([...posterCache.entries()].slice(-4000)));
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

  const EMPTY = "https://s.ltrbxd.com/static/img/empty-poster-150-DtnLDE3k.png";
  let io = null; // watches posters coming into view as you walk

  function watchFrom(track) {
    if (io) io.disconnect();
    io = "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io.unobserve(e.target);
            fillPoster(e.target);
          }
        }, { root: track, rootMargin: "0px 1400px" })
      : null;
  }

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

  function posterHTML([slug, name], tag) {
    const cached = posterCache.get(slug);
    const src = cached ? `src="${esc(cached[0])}" srcset="${esc(cached[0])} 1x, ${esc(cached[1])} 2x"` : `src="${EMPTY}"`;
    return (
      `<li class="lbs-item${cached ? " lbs-loaded" : ""}" data-slug="${esc(slug)}">` +
      `<div class="poster film-poster lbs-poster">` +
      `<img class="image" ${src} width="150" height="225" alt="${esc(name)}" decoding="async">` +
      `<a class="frame" href="/film/${esc(slug)}/" title="${esc(name)}"><span class="frame-title">${esc(name)}</span><span class="overlay"></span></a>` +
      `</div>` +
      (tag ? `<span class="lbs-tag"><i></i>${esc(tag)}</span>` : "") +
      `</li>`
    );
  }

  /* ---------------- the store ---------------- */

  let root = null;
  let collection = "main";
  let walkway = null; // { track, aisles: [el], all: [...] }

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
    if (root.hidden || !root.firstChild) {
      root.hidden = false;
      render();
    }
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
    const total = stock ? stock.films.length : COLLECTIONS[0].count;
    root.innerHTML =
      `<header class="lbs-top">` +
      `<div class="lbs-brand">letternøxd <span>video store</span></div>` +
      `<div class="lbs-wing-sign"><b>Horror</b><span>wing</span></div>` +
      `<nav class="lbs-collections" aria-label="Collections">` +
      COLLECTIONS.map((c) =>
        `<button type="button" class="lbs-coll${c.id === collection ? " -on" : ""}${c.open ? "" : " -soon"}" data-coll="${c.id}"${c.open ? "" : ' aria-disabled="true"'}>` +
        `${c.name} <span>${fmt(c.id === "main" ? total : c.count)}</span>${c.open ? "" : "<em>soon</em>"}</button>`
      ).join("") +
      `</nav>` +
      `<button type="button" class="lbs-close" data-act="close" aria-label="Leave the store">${ICON_CLOSE}</button>` +
      `</header>` +
      `<div class="lbs-hall"></div>`;

    const hall = $(".lbs-hall", root);
    if (stock) return buildWing(hall);

    const box = h("div", "lbs-loading", `<div class="lbs-meter"><i></i></div><p>Stocking the shelves: reading Horror's top ${fmt(COLLECTIONS[0].count)} films from Letterboxd and sorting them into aisles and shelves. This happens once a week and takes about a minute.</p>`);
    hall.append(box);
    buildStock((f) => {
      const i = $(".lbs-meter i", root);
      if (i) i.style.width = `${Math.round(f * 100)}%`;
    })
      .then((s) => { stock = s; if (root && !root.hidden) render(); })
      .catch((err) => {
        box.innerHTML = `<p>Couldn't stock the shelves (${esc(err.message)}). <button type="button" class="lbs-retry" data-act="retry">Try again</button></p>`;
      });
  }

  // Sizes that make the shelving fill the height of the window.
  const HEAD = 64; // the aisle's wooden sign
  const LIP = 26; // shelf edge, where the laminated tags are taped
  const HEADROOM = 10; // gap between a poster's top and the shelf above
  const GAP = 8; // between posters
  const DIVIDER = 30; // between two shelves' worth of films on one row
  const PAD = 34; // inside the uprights
  const WOOD_EVERY = 1150; // px between repeats of the aisle sign
  const TAG_EVERY = 900; // px between repeats of a shelf tag

  function geometry(height) {
    const avail = Math.max(260, height - HEAD - 6);
    const rows = Math.max(3, Math.min(7, Math.floor(avail / 165)));
    const rowH = Math.floor(avail / rows);
    const ph = Math.max(78, Math.min(170, rowH - LIP - HEADROOM));
    return { rows, rowH, ph, pw: Math.round((ph * 2) / 3) };
  }

  // Lay shelves into rows: the first `rows` shelves take one row each, top
  // down; each later one starts to the right of whichever row ends first.
  function packRows(shelves, rows, g) {
    const lines = Array.from({ length: rows }, () => ({ width: 0, runs: [] }));
    const len = (n) => n * g.pw + (n - 1) * GAP;
    shelves.forEach((s, n) => {
      const line = n < rows ? lines[n] : lines.reduce((a, b) => (b.width < a.width ? b : a));
      if (line.runs.length) line.width += DIVIDER;
      line.runs.push(s);
      line.width += len(s.items.length);
    });
    return lines;
  }

  function aisleHTML(a, g, n) {
    const lines = a.lines;
    const inner = Math.max(...lines.map((l) => l.width), g.pw * 3);
    const width = inner + PAD * 2;
    const tagEvery = Math.max(5, Math.round(TAG_EVERY / (g.pw + GAP)));
    const woods = [];
    for (let x = PAD + 10; x < width - 200 || !woods.length; x += WOOD_EVERY) woods.push(x);
    return (
      `<section class="lbs-aisle${a.endcap ? " -endcap" : ""}" data-aisle="${a.id}" style="width:${width}px">` +
      `<div class="lbs-head">` +
      woods
        .map((x, k) => `<div class="lbs-wood" style="left:${x}px;--tilt:${[-0.6, 0.5, -0.3, 0.7][(n + k) % 4]}deg"><i></i><b>${esc(a.name)}</b><i></i></div>`)
        .join("") +
      `</div>` +
      lines
        .map(
          (line) =>
            `<div class="lbs-shelf">` +
            line.runs
              .map(
                (run) =>
                  `<ul class="lbs-run" data-shelf="${esc(run.id)}">` +
                  run.items
                    .map((film, k) => posterHTML(film, k === 0 || (k % tagEvery === 0 && run.items.length - k >= 3) ? run.name : ""))
                    .join("") +
                  `</ul>`
              )
              .join("") +
            `</div>`
        )
        .join("") +
      `</section>`
    );
  }

  function buildWing(hall) {
    hall.innerHTML =
      `<div class="lbs-walk">` +
      `<button type="button" class="lbs-step -back" data-act="back" aria-label="Walk back">${ICON_LEFT}</button>` +
      `<div class="lbs-track" tabindex="0" aria-label="Horror wing. Scroll or use the arrow keys to walk."><div class="lbs-wall"></div></div>` +
      `<button type="button" class="lbs-step -on" data-act="on" aria-label="Walk on">${ICON_RIGHT}</button>` +
      `</div>` +
      `<footer class="lbs-floor"><div class="lbs-map"></div><div class="lbs-you"></div></footer>`;

    const track = $(".lbs-track", hall);
    const wall = $(".lbs-wall", hall);
    watchFrom(track);
    const g = geometry(track.clientHeight || window.innerHeight - 100);
    root.style.setProperty("--ph", `${g.ph}px`);
    root.style.setProperty("--pw", `${g.pw}px`);
    root.style.setProperty("--row", `${g.rowH}px`);
    root.style.setProperty("--head", `${HEAD}px`);
    root.style.setProperty("--lip", `${LIP}px`);
    root.style.setProperty("--gap", `${GAP}px`);
    root.style.setProperty("--divider", `${DIVIDER}px`);
    root.style.setProperty("--pad", `${PAD}px`);

    const tagSets = Object.entries(stock.tags || {}).map(([t, list]) => [t, new Set(list)]);
    const aisles = [...AISLES]
      .sort((a, b) => collator.compare(fileKey(a.name), fileKey(b.name)))
      .concat(EVERYTHING)
      .map((a) => ({ ...a, shelves: shelvesFor(a, stock.aisles[a.id] || [], tagSets) }))
      .filter((a) => a.shelves.length);
    aisles.forEach((a) => (a.lines = packRows(a.shelves, g.rows, g)));

    // The end cap at the head of the wing: this week's popular, face-out.
    if (stock.front && stock.front.length) {
      const per = Math.ceil(stock.front.length / g.rows);
      const lines = Array.from({ length: g.rows }, (_, r) => {
        const items = stock.front.slice(r * per, r * per + per);
        return { width: items.length ? items.length * g.pw + (items.length - 1) * GAP : 0, runs: items.length ? [{ id: "front", name: "This Week", items }] : [] };
      });
      aisles.unshift({ id: "front", name: "Popular This Week", endcap: true, lines });
    }

    wall.innerHTML = aisles.map((a, n) => aisleHTML(a, g, n)).join("");
    wall.querySelectorAll(".lbs-item:not(.lbs-loaded)").forEach((li) => (io ? io.observe(li) : fillPoster(li)));

    // Floor guide: every aisle, to scale. Click to walk there.
    const els = [...wall.children];
    $(".lbs-map", hall).innerHTML = els
      .map((el, n) => `<button type="button" data-act="goto" data-n="${n}" style="flex-grow:${el.offsetWidth}" title="${esc(aisles[n].name)}"><span>${esc(aisles[n].name)}</span></button>`)
      .join("");
    walkway = { track, els, aisles };
    track.addEventListener("scroll", onWalk, { passive: true });
    track.addEventListener("wheel", onWheel, { passive: false });
    track.addEventListener("keydown", onKey);
    onWalk();
    track.focus({ preventScroll: true });
  }

  // Scrolling is walking: a vertical wheel moves you along the wing.
  function onWheel(e) {
    if (!walkway) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    walkway.track.scrollLeft += d * (e.deltaMode === 1 ? 40 : 1);
  }

  function walk(dir) {
    const t = walkway.track;
    t.scrollBy({ left: dir * Math.max(t.clientWidth * 0.8, 300), behavior: "smooth" });
  }

  function onKey(e) {
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); walk(1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); walk(-1); }
    else if (e.key === "Home") { e.preventDefault(); walkway.track.scrollTo({ left: 0, behavior: "smooth" }); }
    else if (e.key === "End") { e.preventDefault(); walkway.track.scrollTo({ left: walkway.track.scrollWidth, behavior: "smooth" }); }
  }

  let walkFrame = 0;
  function onWalk() {
    if (walkFrame) return;
    walkFrame = requestAnimationFrame(() => {
      walkFrame = 0;
      if (!walkway) return;
      const t = walkway.track;
      const w = t.scrollWidth || 1;
      const you = $(".lbs-you", root);
      if (you) {
        you.style.left = `${(t.scrollLeft / w) * 100}%`;
        you.style.width = `${(t.clientWidth / w) * 100}%`;
      }
      $(".lbs-step.-back", root).hidden = t.scrollLeft < 4;
      $(".lbs-step.-on", root).hidden = t.scrollLeft + t.clientWidth >= t.scrollWidth - 4;
      const mid = t.scrollLeft + t.clientWidth / 2;
      const btns = root.querySelectorAll(".lbs-map button");
      walkway.els.forEach((el, n) => btns[n] && btns[n].classList.toggle("-here", el.offsetLeft <= mid && mid < el.offsetLeft + el.offsetWidth));
    });
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    if (!root || root.hidden || !walkway) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const at = walkway.track.scrollLeft / (walkway.track.scrollWidth || 1);
      buildWing($(".lbs-hall", root));
      walkway.track.scrollLeft = at * walkway.track.scrollWidth;
    }, 200);
  });

  function onClick(e) {
    const btn = e.target.closest("[data-act], [data-coll]");
    if (!btn || !root.contains(btn)) return;
    const act = btn.dataset.act;
    if (btn.dataset.coll) {
      if (btn.getAttribute("aria-disabled") === "true") return;
      collection = btn.dataset.coll;
      return render();
    }
    if (act === "close") return leaveStore();
    if (act === "retry") return render();
    if (!walkway) return;
    if (act === "back") walk(-1);
    else if (act === "on") walk(1);
    else if (act === "goto") {
      const el = walkway.els[+btn.dataset.n];
      if (el) walkway.track.scrollTo({ left: Math.max(0, el.offsetLeft - 12), behavior: "smooth" });
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

  // On the home page: a strip that walks you in.
  function addHomeStrip() {
    if (location.pathname !== "/" || document.querySelector(".lbs-home")) return;
    const host = document.querySelector("#content .content-wrap") || document.querySelector("#content");
    if (!host) return;
    const strip = h("section", "lbs-home");
    strip.innerHTML =
      `<a class="lbs-home-door" href="#store">` +
      `<span class="lbs-home-kicker">letternøxd video store</span>` +
      `<span class="lbs-home-title">The Horror wing is open</span>` +
      `<span class="lbs-home-sub">${AISLES.length + 1} aisles, every film on one shelf, A to Z. Walk in →</span>` +
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
