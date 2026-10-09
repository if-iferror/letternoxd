/*
 * Letternoxd Video Store (prototype: the Horror aisle, Main wing).
 *
 * Opens over any Letterboxd page at #store, laid out as one physical aisle:
 * sections stand side by side (A-Z by name, "Everything Else" last), each with
 * a laminated sign and several shelves of films filed A-Z by title. Scrolling
 * walks the aisle, so every shelf moves together.
 *
 * Every section is a Letterboxd browse query. A film sits in exactly one
 * section: the most specific one it fits, in SHELF_PRIORITY order; whatever is
 * left goes to "Everything Else". The end cap (popular this week) may repeat. Only the Main wing is stocked here: films ranked in
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

  /* ---------------- filing: A–Z the way a video store does it ---------------- */

  const yearOf = (name) => (String(name).match(/\((\d{4})\)\s*$/) || [])[1] || "";
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
  const byTitle = (a, b) => collator.compare(fileKey(a[1]), fileKey(b[1])) || collator.compare(yearOf(a[1]), yearOf(b[1]));
  const letterOf = (name) => {
    const c = fileKey(name).charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : "#";
  };

  /* ---------------- posters ---------------- */

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

  function posterHTML([slug, name]) {
    const cached = posterCache.get(slug);
    const src = cached ? `src="${esc(cached[0])}" srcset="${esc(cached[0])} 1x, ${esc(cached[1])} 2x"` : `src="${EMPTY}"`;
    return (
      `<li class="lbs-item${cached ? " lbs-loaded" : ""}" data-slug="${esc(slug)}">` +
      `<div class="poster film-poster lbs-poster">` +
      `<img class="image" ${src} width="150" height="225" alt="${esc(name)}" decoding="async">` +
      `<a class="frame" href="/film/${esc(slug)}/" title="${esc(name)}"><span class="frame-title">${esc(name)}</span><span class="overlay"></span></a>` +
      `</div></li>`
    );
  }

  /* ---------------- the store ---------------- */

  let root = null;
  let wing = "main";
  let aisle = null; // { track, sections: [...], floor }

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
    const total = stock ? stock.films.length : WINGS[0].count;
    root.innerHTML =
      `<header class="lbs-top">` +
      `<div class="lbs-brand">letternøxd <span>video store</span></div>` +
      `<div class="lbs-aisle-sign"><b>Horror</b><span>${stock ? `${fmt(total)} films · Main wing` : "Stocking…"}</span></div>` +
      `<nav class="lbs-wings" aria-label="Wings">` +
      WINGS.map((w) =>
        `<button type="button" class="lbs-wing${w.id === wing ? " -on" : ""}${w.open ? "" : " -soon"}" data-wing="${w.id}"${w.open ? "" : ' aria-disabled="true"'}>` +
        `${w.name} <span>${fmt(w.id === "main" ? total : w.count)}</span>${w.open ? "" : "<em>soon</em>"}</button>`
      ).join("") +
      `</nav>` +
      `<button type="button" class="lbs-close" data-act="close" aria-label="Leave the store">${ICON_CLOSE}</button>` +
      `</header>` +
      `<div class="lbs-hall"></div>`;

    const hall = $(".lbs-hall", root);
    if (stock) return buildAisle(hall);

    const box = h("div", "lbs-loading", `<div class="lbs-meter"><i></i></div><p>Stocking the shelves: reading Horror's top ${fmt(WINGS[0].count)} films from Letterboxd. This happens once a week and takes about half a minute.</p>`);
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
  const SIGN_H = 64; // the laminated sign above each section
  const LEDGE = 12; // shelf board
  const HEADROOM = 10; // gap between a poster's top and the shelf above
  function geometry(height) {
    const avail = Math.max(240, height - SIGN_H - 16);
    let rows = Math.max(3, Math.min(8, Math.floor(avail / 150)));
    let ph = Math.floor(avail / rows) - LEDGE - HEADROOM;
    ph = Math.max(84, Math.min(165, ph));
    return { rows, ph, pw: Math.round((ph * 2) / 3), rowH: ph + LEDGE + HEADROOM };
  }

  function buildAisle(hall) {
    const film = (i) => stock.films[i];
    const sections = [...SHELVES]
      .sort((a, b) => collator.compare(fileKey(a.name), fileKey(b.name)))
      .concat(EVERYTHING)
      .map((s) => ({ ...s, items: (stock.shelves[s.id] || []).map(film).sort(byTitle) }))
      .filter((s) => s.items.length);
    const endcap = stock.front && stock.front.length ? { id: "front", name: "Popular This Week", endcap: true, items: stock.front.slice(0, 12) } : null;

    hall.innerHTML =
      `<div class="lbs-walk">` +
      `<button type="button" class="lbs-step -back" data-act="back" aria-label="Walk back">${ICON_LEFT}</button>` +
      `<div class="lbs-track" tabindex="0" aria-label="Horror aisle. Scroll or use the arrow keys to walk."><div class="lbs-wall"></div></div>` +
      `<button type="button" class="lbs-step -on" data-act="on" aria-label="Walk on">${ICON_RIGHT}</button>` +
      `</div>` +
      `<footer class="lbs-floor"><div class="lbs-map"></div><div class="lbs-you"></div></footer>`;

    const track = $(".lbs-track", hall);
    const wall = $(".lbs-wall", hall);
    watchFrom(track);
    const g = geometry(track.clientHeight || window.innerHeight - 160);
    root.style.setProperty("--ph", `${g.ph}px`);
    root.style.setProperty("--pw", `${g.pw}px`);
    root.style.setProperty("--row", `${g.rowH}px`);
    root.style.setProperty("--rows", g.rows);
    root.style.setProperty("--sign", `${SIGN_H}px`);
    root.style.setProperty("--ledge", `${LEDGE}px`);

    const all = endcap ? [endcap, ...sections] : sections;
    wall.innerHTML = all
      .map((s, n) => {
        const tilt = [-1.2, 0.8, -0.5, 1.1, -0.9, 0.4][n % 6];
        const range = s.endcap ? "face-out, may repeat" : `${letterOf(s.items[0][1])}–${letterOf(s.items.at(-1)[1])}`;
        return (
          `<section class="lbs-bay${s.endcap ? " -endcap" : ""}" data-shelf="${s.id}">` +
          `<div class="lbs-signpost"><div class="lbs-sign" style="--tilt:${tilt}deg">` +
          `<i class="lbs-tape -l"></i><i class="lbs-tape -r"></i>` +
          `<b>${esc(s.name)}</b><small>${s.endcap ? range : `${fmt(s.items.length)} films · ${range}`}</small>` +
          `</div></div>` +
          `<ul class="lbs-shelves">${s.items.map(posterHTML).join("")}</ul>` +
          `</section>`
        );
      })
      .join("");

    wall.querySelectorAll(".lbs-item:not(.lbs-loaded)").forEach((li) => (io ? io.observe(li) : fillPoster(li)));

    // Floor guide: every section along the aisle, to scale. Click to walk there.
    const bays = [...wall.children];
    const width = wall.scrollWidth;
    $(".lbs-map", hall).innerHTML = bays
      .map((b, n) => `<button type="button" data-act="goto" data-n="${n}" style="flex-grow:${b.offsetWidth}" title="${esc(all[n].name)}"><span>${esc(all[n].name)}</span></button>`)
      .join("");
    aisle = { track, wall, bays, width, all };
    track.addEventListener("scroll", onWalk, { passive: true });
    track.addEventListener("wheel", onWheel, { passive: false });
    track.addEventListener("keydown", onKey);
    onWalk();
    track.focus({ preventScroll: true });
  }

  // Scrolling is walking: a vertical wheel moves you along the aisle.
  function onWheel(e) {
    if (!aisle) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    aisle.track.scrollLeft += d * (e.deltaMode === 1 ? 40 : 1);
  }

  function walk(dir) {
    const t = aisle.track;
    t.scrollBy({ left: dir * Math.max(t.clientWidth * 0.8, 300), behavior: "smooth" });
  }

  function onKey(e) {
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); walk(1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); walk(-1); }
    else if (e.key === "Home") { e.preventDefault(); aisle.track.scrollTo({ left: 0, behavior: "smooth" }); }
    else if (e.key === "End") { e.preventDefault(); aisle.track.scrollTo({ left: aisle.track.scrollWidth, behavior: "smooth" }); }
  }

  let walkFrame = 0;
  function onWalk() {
    if (walkFrame) return;
    walkFrame = requestAnimationFrame(() => {
      walkFrame = 0;
      if (!aisle) return;
      const t = aisle.track;
      const w = t.scrollWidth || 1;
      const you = $(".lbs-you", root);
      if (you) {
        you.style.left = `${(t.scrollLeft / w) * 100}%`;
        you.style.width = `${(t.clientWidth / w) * 100}%`;
      }
      $(".lbs-step.-back", root).hidden = t.scrollLeft < 4;
      $(".lbs-step.-on", root).hidden = t.scrollLeft + t.clientWidth >= t.scrollWidth - 4;
      // Light up the section(s) you're standing in.
      const mid = t.scrollLeft + t.clientWidth / 2;
      const btns = root.querySelectorAll(".lbs-map button");
      aisle.bays.forEach((b, n) => btns[n] && btns[n].classList.toggle("-here", b.offsetLeft <= mid && mid < b.offsetLeft + b.offsetWidth));
    });
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    if (!root || root.hidden || !aisle) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const at = aisle.track.scrollLeft / (aisle.track.scrollWidth || 1);
      buildAisle($(".lbs-hall", root));
      aisle.track.scrollLeft = at * aisle.track.scrollWidth;
    }, 200);
  });

  function onClick(e) {
    const btn = e.target.closest("[data-act], [data-wing]");
    if (!btn || !root.contains(btn)) return;
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
    if (!aisle) return;
    if (act === "back") walk(-1);
    else if (act === "on") walk(1);
    else if (act === "goto") {
      const bay = aisle.bays[+btn.dataset.n];
      if (bay) aisle.track.scrollTo({ left: Math.max(0, bay.offsetLeft - 24), behavior: "smooth" });
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
      `<span class="lbs-home-title">The Horror aisle is open</span>` +
      `<span class="lbs-home-sub">${SHELVES.length + 1} sections, every film in one place, A to Z. Walk in →</span>` +
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
