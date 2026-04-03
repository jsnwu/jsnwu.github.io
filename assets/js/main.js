/** Must stay in sync with the inline <script> in each page <head> (early theme, avoids flash). */
const THEME_KEY = "theme";
const SIDEBAR_COLLAPSED_KEY = "siteSidebarCollapsed";
const TAG_META_URL = "/assets/data/tag-meta.json";
const LEGACY_TAG_META_KEY = "tagMetaV1";
const TAG_META_IDB = "site-tag-meta";
const TAG_META_IDB_STORE = "kv";
const TAG_META_IDB_KEY = "tagMetaFileHandle";

let tagMetaCache = {};
let tagMetaFileHandle = null;

function tagMetaOpenIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TAG_META_IDB, 1);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(TAG_META_IDB_STORE)) {
        req.result.createObjectStore(TAG_META_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function tagMetaSaveHandleToIdb(handle) {
  if (!handle) return;
  try {
    const db = await tagMetaOpenIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TAG_META_IDB_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(TAG_META_IDB_STORE).put(handle, TAG_META_IDB_KEY);
    });
    db.close();
  } catch {
    //
  }
}

async function tagMetaLoadHandleFromIdb() {
  try {
    const db = await tagMetaOpenIdb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(TAG_META_IDB_STORE, "readonly");
      const r = tx.objectStore(TAG_META_IDB_STORE).get(TAG_META_IDB_KEY);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

async function tagMetaClearHandleIdb() {
  try {
    const db = await tagMetaOpenIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TAG_META_IDB_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(TAG_META_IDB_STORE).delete(TAG_META_IDB_KEY);
    });
    db.close();
  } catch {
    //
  }
}

async function tagMetaEnsureWritePermission(handle) {
  if (!handle || typeof handle.queryPermission !== "function") return false;
  const opts = { mode: "readwrite" };
  try {
    let state = await handle.queryPermission(opts);
    if (state === "granted") return true;
    if (state === "denied") return false;
    if (typeof handle.requestPermission === "function") {
      state = await handle.requestPermission(opts);
      return state === "granted";
    }
  } catch {
    return false;
  }
  return false;
}

/** Restore saved handle if permission already granted (no user gesture). */
async function tagMetaWarmFileHandleFromIdb() {
  try {
    const h = await tagMetaLoadHandleFromIdb();
    if (!h) return;
    const state = await h.queryPermission({ mode: "readwrite" });
    if (state === "granted") tagMetaFileHandle = h;
  } catch {
    //
  }
}

async function tagMetaResolveWritableHandle() {
  let h = tagMetaFileHandle;
  if (!h) {
    h = await tagMetaLoadHandleFromIdb();
  }
  if (!h) return null;
  if (await tagMetaEnsureWritePermission(h)) {
    tagMetaFileHandle = h;
    return h;
  }
  return null;
}

async function initTagMeta() {
  tagMetaCache = {};
  try {
    const res = await fetch(resolveSiteAbsolutePath(TAG_META_URL), { cache: "no-store" });
    if (res.ok) {
      const parsed = await res.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) tagMetaCache = parsed;
    }
  } catch {
    // e.g. file:// without a server
  }
  if (Object.keys(tagMetaCache).length === 0) {
    try {
      const raw = localStorage.getItem(LEGACY_TAG_META_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) tagMetaCache = parsed;
      }
    } catch {
      //
    }
  }
  await tagMetaWarmFileHandleFromIdb();
}

function loadTagMeta() {
  return tagMetaCache;
}

/** Tags page: edit vs read-only. Query overrides host (e.g. ?readonly=true on localhost, ?readonly=false to force edit on the live site). */
function isTagsManagerEditMode() {
  try {
    const p = new URLSearchParams(location.search);
    if (p.has("readonly")) {
      const v = (p.get("readonly") || "").trim().toLowerCase();
      if (v === "false" || v === "0" || v === "no") return true;
      return false;
    }
  } catch {
    //
  }
  if (location.protocol === "file:") return true;
  const h = (location.hostname || "").toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  return false;
}

async function persistTagMeta() {
  const str = JSON.stringify(tagMetaCache, null, 2) + "\n";

  async function writeThroughHandle(handle) {
    const writable = await handle.createWritable();
    await writable.write(str);
    await writable.close();
  }

  const resolved = await tagMetaResolveWritableHandle();
  if (resolved) {
    try {
      await writeThroughHandle(resolved);
      return { ok: true, mode: "file" };
    } catch {
      tagMetaFileHandle = null;
      await tagMetaClearHandleIdb();
    }
  }

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: "tag-meta.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      tagMetaFileHandle = handle;
      await writeThroughHandle(handle);
      await tagMetaSaveHandleToIdb(handle);
      return { ok: true, mode: "file" };
    } catch (e) {
      if (e && e.name === "AbortError") return { ok: false, aborted: true };
    }
  }

  const blob = new Blob([str], { type: "application/json" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = "tag-meta.json";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { ok: true, mode: "download" };
}

function isValidTagName(name) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(name || "").trim());
}

function normalizeTagName(name) {
  return String(name || "").trim().toLowerCase();
}

function resolveTagName(rawTag, meta, depth = 0) {
  const tag = normalizeTagName(rawTag);
  if (!tag) return "";
  if (depth > 5) return tag;
  const info = (meta && meta[tag]) || {};
  const next = normalizeTagName(info.renameTo || "");
  if (!next || next === tag) return tag;
  return resolveTagName(next, meta, depth + 1);
}

function getTagColor(tag, info) {
  const hue = hashHue(tag);
  const color = info && info.color ? String(info.color) : `hsl(${hue} 92% 60%)`;
  return { color, hue };
}

function normalizeHexColor(input) {
  const v = String(input || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toUpperCase();
  return "";
}

function buildColorGridPicker(host, { value = "", autoColor = "", onChange, ariaLabel = "Color" } = {}) {
  if (!host) return null;

  const PALETTE = [
    "#EF4444", "#F97316", "#F59E0B", "#EAB308", "#84CC16",
    "#22C55E", "#10B981", "#06B6D4", "#0EA5E9", "#3B82F6",
    "#6366F1", "#8B5CF6", "#A855F7", "#D946EF", "#EC4899",
    "#F43F5E", "#94A3B8", "#64748B", "#334155", "#111827",
  ];

  const state = {
    value: normalizeHexColor(value) || "",
    open: false,
  };

  host.innerHTML = "";
  host.classList.add("colorpick");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "colorpick__btn";
  btn.setAttribute("aria-label", ariaLabel);
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");

  const dot = document.createElement("span");
  dot.className = "colorpick__dot";
  btn.appendChild(dot);

  const pop = document.createElement("div");
  pop.className = "colorpick__popover";
  pop.hidden = true;

  const grid = document.createElement("div");
  grid.className = "colorpick__grid";
  pop.appendChild(grid);

  const actions = document.createElement("div");
  actions.className = "colorpick__actions";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "colorpick__textbtn";
  resetBtn.textContent = "Auto";

  const customBtn = document.createElement("button");
  customBtn.type = "button";
  customBtn.className = "colorpick__textbtn";
  customBtn.textContent = "Custom…";

  actions.appendChild(resetBtn);
  actions.appendChild(customBtn);
  pop.appendChild(actions);

  const native = document.createElement("input");
  native.type = "color";
  native.setAttribute("aria-label", `${ariaLabel} (custom)`);
  native.style.position = "absolute";
  native.style.left = "-9999px";
  native.style.width = "1px";
  native.style.height = "1px";
  native.tabIndex = -1;

  host.appendChild(btn);
  host.appendChild(pop);
  host.appendChild(native);

  function render() {
    const sw = state.value || String(autoColor || "").trim() || "transparent";
    dot.style.setProperty("--swatch", sw);
    dot.style.background = sw;
    btn.setAttribute("aria-expanded", state.open ? "true" : "false");

    [...grid.children].forEach((el) => {
      const c = el && el.dataset && el.dataset.color;
      if (!c) return;
      el.setAttribute("aria-checked", c === state.value ? "true" : "false");
    });
  }

  function setOpen(next) {
    state.open = !!next;
    pop.hidden = !state.open;
    render();
  }

  function setValue(next) {
    const v = normalizeHexColor(next);
    state.value = v;
    render();
    if (typeof onChange === "function") onChange(v);
  }

  PALETTE.forEach((hex) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "colorpick__swatch";
    swatch.dataset.color = hex;
    swatch.style.setProperty("--swatch", hex);
    swatch.setAttribute("role", "radio");
    swatch.setAttribute("aria-checked", "false");
    swatch.setAttribute("aria-label", hex);
    swatch.addEventListener("click", () => {
      setValue(hex);
      setOpen(false);
    });
    grid.appendChild(swatch);
  });

  btn.addEventListener("click", () => setOpen(!state.open));

  resetBtn.addEventListener("click", () => {
    setValue("");
    setOpen(false);
  });

  customBtn.addEventListener("click", () => {
    native.value = state.value || "#3B82F6";
    native.click();
  });

  native.addEventListener("change", () => {
    setValue(native.value);
    setOpen(false);
  });

  document.addEventListener("click", (e) => {
    if (!state.open) return;
    if (host.contains(e.target)) return;
    setOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (!state.open) return;
    if (e.key === "Escape") setOpen(false);
  });

  render();

  return {
    get value() {
      return state.value;
    },
    setValue,
    close() {
      setOpen(false);
    },
  };
}

function getVisiblePostTags(post) {
  const meta = loadTagMeta();
  const tags = (post && post.tags) || [];
  const out = [];
  tags.forEach((t) => {
    const resolved = resolveTagName(String(t || ""), meta);
    if (!resolved) return;
    const info = meta[resolved] || {};
    if (info.deleted) return;
    if (!out.includes(resolved)) out.push(resolved);
  });
  return out;
}

function setTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme) localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {}

  const t = root.dataset.theme ? root.dataset.theme : "system";
  document.querySelectorAll("[data-theme-label]").forEach((label) => {
    label.textContent = t;
  });
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {}
  if (saved) setTheme(saved);
  else setTheme(null);
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  if (current === "dark") setTheme("light");
  else if (current === "light") setTheme(null);
  else setTheme("dark");
}

function initSidebarToggle() {
  const menuBtns = document.querySelectorAll("[data-sidebar-toggle]");
  if (!menuBtns.length) return;

  let backdrop = document.querySelector(".sidebar-backdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "sidebar-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.hidden = true;
    document.body.appendChild(backdrop);
  }

  const mobileNavMq = window.matchMedia("(max-width: 820px)");
  let scrollLockY = 0;

  const applyScrollLock = (open) => {
    if (!mobileNavMq.matches) {
      document.documentElement.classList.remove("sidebar-scroll-lock");
      document.body.style.removeProperty("position");
      document.body.style.removeProperty("top");
      document.body.style.removeProperty("width");
      document.body.style.removeProperty("overflow");
      return;
    }
    if (open) {
      scrollLockY = window.scrollY;
      document.documentElement.classList.add("sidebar-scroll-lock");
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollLockY}px`;
      document.body.style.width = "100%";
      document.body.style.overflow = "hidden";
    } else {
      document.documentElement.classList.remove("sidebar-scroll-lock");
      document.body.style.removeProperty("position");
      document.body.style.removeProperty("top");
      document.body.style.removeProperty("width");
      document.body.style.removeProperty("overflow");
      window.scrollTo(0, scrollLockY);
    }
  };

  const setOpen = (open) => {
    document.body.dataset.sidebarOpen = open ? "true" : "false";
    backdrop.toggleAttribute("hidden", !open);
    menuBtns.forEach((b) => b.setAttribute("aria-expanded", open ? "true" : "false"));
    applyScrollLock(open);
  };

  backdrop.addEventListener("click", () => setOpen(false));

  menuBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const open = document.body.dataset.sidebarOpen === "true";
      setOpen(!open);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  document.addEventListener("click", (e) => {
    if (document.body.dataset.sidebarOpen !== "true") return;
    const sidebar = document.querySelector(".sidebar");
    const isClickInside = sidebar && sidebar.contains(e.target);
    const isMenuButton = [...menuBtns].some((b) => b.contains(e.target));
    if (!isClickInside && !isMenuButton) setOpen(false);
  });

  const closeOverlayIfDesktop = () => {
    if (!mobileNavMq.matches) setOpen(false);
  };
  if (typeof mobileNavMq.addEventListener === "function") {
    mobileNavMq.addEventListener("change", closeOverlayIfDesktop);
  } else {
    mobileNavMq.addListener(closeOverlayIfDesktop);
  }
  closeOverlayIfDesktop();
}

function initSidebarCollapse() {
  const btn = document.querySelector("[data-sidebar-collapse]");
  if (!btn) return;

  const icon = btn.querySelector("[data-sidebar-collapse-icon]");

  const root = document.documentElement;
  const apply = (collapsed) => {
    if (collapsed) root.dataset.sidebarCollapsed = "true";
    else delete root.dataset.sidebarCollapsed;
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    btn.setAttribute("title", collapsed ? "Expand sidebar" : "Collapse sidebar");
    if (icon) icon.textContent = collapsed ? "»" : "«";
    try {
      if (collapsed) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
      else localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    } catch {}
  };

  try {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") apply(true);
  } catch {}

  btn.addEventListener("click", () => {
    const next = root.dataset.sidebarCollapsed !== "true";
    apply(next);
  });
}

async function loadPosts() {
  const res = await fetch(resolveSiteAbsolutePath("/posts/posts.json"), { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load posts.json");
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data;
}

function fmtDate(iso) {
  try {
    const s = String(iso || "").trim();
    // Date-only strings like "2026-03-30" are parsed as UTC by JS Date, which can display as the prior day in local timezones.
    // Treat YYYY-MM-DD as a local calendar date.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(d);
  } catch {
    return iso;
  }
}

function renderPostCard(post) {
  const a = document.createElement("a");
  a.className = "card";
  a.href = post.url;

  const title = document.createElement("h3");
  title.className = "card__title";
  title.textContent = post.title || "Untitled";

  const desc = document.createElement("p");
  desc.className = "card__desc";
  desc.textContent = post.description || "";

  const meta = document.createElement("div");
  meta.className = "card__meta";

  if (post.date) {
    const date = document.createElement("span");
    date.className = "pill";
    date.textContent = fmtDate(post.date);
    meta.appendChild(date);
  }

  // Show up to 2 tags on cards (keeps layout compact, still informative).
  const tags = getVisiblePostTags(post).slice(0, 2);
  tags.forEach((t) => {
    const tag = document.createElement("span");
    tag.className = "pill";
    tag.textContent = `#${t}`;
    meta.appendChild(tag);
  });

  if (post.readingTime) {
    const rt = document.createElement("span");
    rt.className = "pill";
    rt.textContent = post.readingTime;
    meta.appendChild(rt);
  }

  a.appendChild(title);
  a.appendChild(meta);
  if (desc.textContent) a.appendChild(desc);
  return a;
}

function postMatchesSearchQuery(post, termLower) {
  const hay = `${post.title || ""} ${getVisiblePostTags(post).join(" ")} ${post.description || ""}`.toLowerCase();
  return hay.includes(termLower);
}

/** True on /posts/ index only (not single post pages). */
function isPostsIndexPage() {
  let p = location.pathname.replace(/\/index\.html$/i, "");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (!p) p = "/";
  if (p === "/posts") return true;
  const idx = p.lastIndexOf("/");
  return idx >= 0 && p.slice(idx) === "/posts";
}

function navigateToPostsWithQuery(term) {
  const base = resolveSiteAbsolutePath("/posts/");
  let url;
  try {
    url = base.startsWith("http") ? new URL(base) : new URL(base, location.origin);
  } catch {
    url = new URL("/posts/", location.origin);
  }
  if (term) url.searchParams.set("q", term);
  else url.searchParams.delete("q");
  location.assign(url.href);
}

/** Home, about, post detail, etc.: typing in the topbar search goes to Posts with ?q=… (term kept in URL and restored in the input). */
function initPostsSearchNavigateFromOtherPages() {
  if (isPostsIndexPage()) return;
  const input = document.querySelector("[data-posts-search]");
  if (!input) return;
  let debounceTimer = null;
  input.addEventListener("input", () => {
    const term = input.value.trim();
    if (!term) {
      clearTimeout(debounceTimer);
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => navigateToPostsWithQuery(term), 400);
  });
}

async function initLatestPosts() {
  const host = document.querySelector("[data-latest-posts]");
  if (!host) return;

  try {
    const posts = await loadPosts();
    posts
      .slice()
      .sort((a, b) => (String(b.date || "")).localeCompare(String(a.date || "")))
      .slice(0, 5)
      .forEach((p) => host.appendChild(renderPostCard(p)));

    if (!host.childElementCount) {
      host.innerHTML = `<div class="muted">No posts yet.</div>`;
    }
  } catch {
    host.innerHTML = `<div class="muted">Could not load posts.</div>`;
  }
}

async function initPostsIndex() {
  const host = document.querySelector("[data-posts-index]");
  if (!host) return;

  const q = document.querySelector("[data-posts-search]");
  let posts = [];
  const params = new URLSearchParams(window.location.search);
  const tagFilter = params.get("tag");

  function applyFilters() {
    const term = q ? q.value.trim().toLowerCase() : "";
    const base = tagFilter
      ? posts.filter((p) => getVisiblePostTags(p).includes(tagFilter))
      : posts;
    if (!term) return base;
    return base.filter((p) => postMatchesSearchQuery(p, term));
  }

  function render(list) {
    host.innerHTML = "";
    if (!list.length) {
      host.innerHTML = `<div class="muted">No matching posts.</div>`;
      return;
    }
    list.forEach((p) => host.appendChild(renderPostCard(p)));
  }

  try {
    posts = await loadPosts();
    posts.sort((a, b) => (String(b.date || "")).localeCompare(String(a.date || "")));
  } catch {
    host.innerHTML = `<div class="muted">Could not load posts.</div>`;
    return;
  }

  if (q && params.has("q")) {
    q.value = params.get("q") || "";
  }

  render(applyFilters());

  const keepSearchForTags = q ? q.value.trim() : "";

  const tagHost = document.querySelector("[data-tags-menu]");
  if (tagHost) {
    const tagCounts = countTags(posts);
    const all = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    tagHost.innerHTML = "";
    const cloud = document.createElement("div");
    cloud.className = "tag-cloud";
    all.forEach(([tag, count]) => {
      const chip = renderTagChip(tag, count, { active: tag === tagFilter, keepSearch: keepSearchForTags });
      if (chip) cloud.appendChild(chip);
    });
    tagHost.appendChild(cloud);
  }

  if (!q) return;

  let urlDebounce = null;
  function syncSearchParamToUrl() {
    clearTimeout(urlDebounce);
    urlDebounce = setTimeout(() => {
      const p = new URLSearchParams(location.search);
      const term = q.value.trim();
      if (term) p.set("q", term);
      else p.delete("q");
      const qs = p.toString();
      const next = location.pathname + (qs ? `?${qs}` : "") + location.hash;
      const cur = location.pathname + location.search + location.hash;
      if (next !== cur) history.replaceState(null, "", next);
    }, 280);
  }

  q.addEventListener("input", () => {
    render(applyFilters());
    syncSearchParamToUrl();
  });
}

async function initTagsManager() {
  const root = document.querySelector("[data-tags-manager]");
  const list = document.querySelector("[data-tags-list]");
  if (!root || !list) return;

  const editMode = isTagsManagerEditMode();
  root.dataset.tagsMode = editMode ? "edit" : "readonly";

  root.querySelectorAll("[data-tags-edit-only]").forEach((el) => {
    el.hidden = !editMode;
  });

  const addBtn = root.querySelector("[data-add-tag]");
  const newNameEl = root.querySelector("[data-new-tag-name]");
  const newColorEl = root.querySelector("[data-new-tag-color]");
  const statusEl = root.querySelector("[data-tag-meta-status]");
  let newColorPicker = null;

  let posts = [];
  try {
    posts = await loadPosts();
  } catch {
    // ok
  }

  function buildRows() {
    const meta = loadTagMeta();
    const counts = countTags(posts);
    Object.keys(meta).forEach((name) => {
      if (!counts.has(name)) counts.set(name, 0);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  }

  async function setStatusAfterSave(result) {
    if (!statusEl) return;
    if (!result || result.aborted) return;
    if (result.mode === "file") {
      statusEl.textContent = "Saved to tag-meta.json — commit and push when you are ready.";
    } else if (result.mode === "download") {
      statusEl.textContent =
        "Downloaded tag-meta.json — replace assets/data/tag-meta.json in your repo, then commit and push.";
    }
  }

  async function persistAndRefresh() {
    const r = await persistTagMeta();
    if (r.aborted) {
      await initTagMeta();
      render();
      return r;
    }
    await setStatusAfterSave(r);
    render();
    return r;
  }

  function renderDisabledChip(tagName, count, info) {
    const a = document.createElement("span");
    a.className = "tag";
    a.style.opacity = "0.5";
    a.style.pointerEvents = "none";
    const { color, hue } = getTagColor(tagName, info);
    a.style.setProperty("--tag-h", String(hue));
    a.style.setProperty("--tag-color", color);
    const nameEl = document.createElement("span");
    nameEl.textContent = String(info.renameTo || tagName);
    const c = document.createElement("span");
    c.className = "tag__count";
    c.textContent = String(count);
    a.appendChild(nameEl);
    a.appendChild(c);
    return a;
  }

  function renderReadonlyList() {
    const meta = loadTagMeta();
    const rows = buildRows();
    list.innerHTML = "";
    rows.forEach(([name, count]) => {
      const info = meta[name] || {};
      if (info.deleted) return;

      const row = document.createElement("div");
      row.className = "tag-row tag-row--readonly";

      const left = document.createElement("div");
      left.className = "tag-row__left";

      const chip = renderTagChip(name, count) || renderDisabledChip(name, count, info);
      left.appendChild(chip);

      const metaText = document.createElement("div");
      metaText.className = "tag-row__meta";
      metaText.textContent = `${count} post${count === 1 ? "" : "s"}${info.renameTo ? ` · renamed → ${info.renameTo}` : ""}${info.deleted ? " · hidden" : ""}`;
      left.appendChild(metaText);

      const { color } = getTagColor(name, info);
      const swatch = document.createElement("span");
      swatch.className = "tag-row__swatch";
      swatch.title = "Tag color";
      swatch.style.background = color;

      row.appendChild(left);
      row.appendChild(swatch);
      list.appendChild(row);
    });
  }

  function render() {
    if (!editMode) {
      renderReadonlyList();
      return;
    }

    const meta = loadTagMeta();
    const rows = buildRows();
    list.innerHTML = "";
    rows.forEach(([name, count]) => {
      const info = meta[name] || {};

      const row = document.createElement("div");
      row.className = "tag-row";

      const left = document.createElement("div");
      left.className = "tag-row__left";

      const chip = renderTagChip(name, count) || renderDisabledChip(name, count, info);
      left.appendChild(chip);

      const metaText = document.createElement("div");
      metaText.className = "tag-row__meta";
      metaText.textContent = `${count} post${count === 1 ? "" : "s"}${info.renameTo ? ` · renamed → ${info.renameTo}` : ""}${info.deleted ? " · hidden" : ""}`;
      left.appendChild(metaText);

      const renameInput = document.createElement("input");
      renameInput.className = "input input--sm";
      renameInput.type = "text";
      renameInput.placeholder = "Rename to (optional)";
      renameInput.value = String(info.renameTo || "");

      const colorHost = document.createElement("div");
      colorHost.className = "colorpick";

      const delBtn = document.createElement("button");
      delBtn.className = `button button--ghost ${info.deleted ? "" : "button--danger"}`.trim();
      delBtn.type = "button";
      delBtn.textContent = info.deleted ? "Restore" : "Delete";

      renameInput.addEventListener("change", async () => {
        const v = normalizeTagName(renameInput.value || "");
        meta[name] = { ...(meta[name] || {}) };
        if (!v) delete meta[name].renameTo;
        else if (!isValidTagName(v)) return;
        else if (v === name) delete meta[name].renameTo;
        else meta[name].renameTo = v;
        await persistAndRefresh();
      });

      const initial = normalizeHexColor(info.color) || "";
      const derived = getTagColor(name, info).color;
      buildColorGridPicker(colorHost, {
        value: initial,
        autoColor: derived,
        ariaLabel: `Color for ${name}`,
        onChange: async (hex) => {
          meta[name] = { ...(meta[name] || {}) };
          if (hex) meta[name].color = hex;
          else delete meta[name].color;
          await persistAndRefresh();
        },
      });

      delBtn.addEventListener("click", async () => {
        const m = loadTagMeta();
        const cur = m[name] || {};
        m[name] = { ...cur, deleted: !cur.deleted };
        await persistAndRefresh();
      });

      row.appendChild(left);
      row.appendChild(renameInput);
      row.appendChild(colorHost);
      row.appendChild(delBtn);
      list.appendChild(row);
    });
  }

  if (editMode && newColorEl) {
    newColorPicker = buildColorGridPicker(newColorEl, {
      value: "",
      ariaLabel: "New tag color",
      onChange: () => {},
    });
  }

  if (editMode && addBtn) {
    addBtn.addEventListener("click", async () => {
      const meta = loadTagMeta();
      const name = normalizeTagName(newNameEl && newNameEl.value);
      if (!name || !isValidTagName(name)) return;
      const color = newColorPicker ? String(newColorPicker.value || "").trim() : "";
      meta[name] = { ...(meta[name] || {}) };
      if (color) meta[name].color = color;
      if (meta[name].deleted) meta[name].deleted = false;
      const r = await persistTagMeta();
      if (r.aborted) {
        await initTagMeta();
        render();
        return;
      }
      await setStatusAfterSave(r);
      if (newNameEl) newNameEl.value = "";
      if (newColorPicker && newColorPicker.setValue) newColorPicker.setValue("");
      render();
    });
  }

  render();
}

function initYear() {
  const el = document.getElementById("year");
  if (el) el.textContent = String(new Date().getFullYear());
}

function wireThemeButtons() {
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", toggleTheme);
  });
}

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function countTags(posts) {
  const map = new Map();
  const meta = loadTagMeta();
  posts.forEach((p) => {
    (p.tags || []).forEach((t) => {
      const raw = String(t || "").trim();
      if (!raw) return;
      const key = resolveTagName(raw, meta);
      if (!key) return;
      map.set(key, (map.get(key) || 0) + 1);
    });
  });
  return map;
}

function hashHue(input) {
  const s = String(input || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function renderTagChip(tag, count, { active = false, keepSearch = "" } = {}) {
  const meta = loadTagMeta();
  const info = meta[tag] || {};
  if (info.deleted) return null;

  const a = document.createElement("a");
  a.className = `tag${active ? " tag--active" : ""}`;
  const qp = new URLSearchParams();
  qp.set("tag", tag);
  const qv = String(keepSearch || "").trim();
  if (qv) qp.set("q", qv);
  a.href = `/posts/?${qp.toString()}`;
  const { color, hue } = getTagColor(tag, info);
  a.style.setProperty("--tag-h", String(hue));
  a.style.setProperty("--tag-color", color);

  const name = document.createElement("span");
  name.textContent = tag;

  const c = document.createElement("span");
  c.className = "tag__count";
  c.textContent = String(count);

  a.appendChild(name);
  a.appendChild(c);
  return a;
}

function initTrendingTags() {
  const host = document.querySelector("[data-trending-tags]");
  if (!host) return;

  loadPosts()
    .then((posts) => {
      const tagCounts = countTags(posts);
      const top = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      host.innerHTML = "";
      if (!top.length) {
        host.innerHTML = `<div class="muted">No tags yet.</div>`;
        return;
      }
      const cloud = document.createElement("div");
      cloud.className = "tag-cloud";
      top.forEach(([tag, count]) => {
        const chip = renderTagChip(tag, count);
        if (chip) cloud.appendChild(chip);
      });
      host.appendChild(cloud);
    })
    .catch(() => {
      host.innerHTML = `<div class="muted">Could not load tags.</div>`;
    });
}

function initRecentlyUpdated() {
  const host = document.querySelector("[data-recently-updated]");
  if (!host) return;

  loadPosts()
    .then((posts) => {
      const list = posts
        .slice()
        .sort((a, b) => (String(b.date || "")).localeCompare(String(a.date || "")))
        .slice(0, 5);

      host.innerHTML = "";
      if (!list.length) {
        host.innerHTML = `<div class="muted">No posts yet.</div>`;
        return;
      }

      list.forEach((p) => {
        const row = document.createElement("div");
        row.className = "widget__item";
        const a = document.createElement("a");
        a.href = p.url;
        a.textContent = p.title || "Untitled";
        const d = document.createElement("span");
        d.className = "widget__count";
        d.textContent = p.date ? fmtDate(p.date) : "";
        row.appendChild(a);
        row.appendChild(d);
        host.appendChild(row);
      });
    })
    .catch(() => {
      host.innerHTML = `<div class="muted">Could not load posts.</div>`;
    });
}

function ensureHeadingIds(article) {
  const headings = [...article.querySelectorAll("h2, h3, h4")];
  headings.forEach((h) => {
    if (h.id) return;
    const base = slugify(h.textContent);
    if (!base) return;
    let id = base;
    let i = 2;
    while (document.getElementById(id)) {
      id = `${base}-${i++}`;
    }
    h.id = id;
  });
  return headings;
}

function initToc() {
  const host = document.querySelector("[data-toc]");
  const article = document.querySelector("[data-article]");
  if (!host || !article) return;

  const headings = ensureHeadingIds(article).filter((h) => h.tagName !== "H1");
  host.innerHTML = "";
  if (!headings.length) {
    host.innerHTML = `<div class="muted small">No sections.</div>`;
    return;
  }

  const setActiveHeading = (heading) => {
    if (!heading) return;
    items.forEach(({ div }) => div.classList.remove("toc__item--active"));
    const hit = items.find((x) => x.h === heading);
    if (hit) hit.div.classList.add("toc__item--active");
  };

  /** After a TOC/hash jump, scrollspy used to run before layout settled and overwrote the clicked row. */
  let tocUserPick = null;
  let tocUserPickExpire = 0;
  const TOC_USER_PICK_MS = 500;
  const lockTocToHeading = (heading) => {
    tocUserPick = heading;
    tocUserPickExpire = performance.now() + TOC_USER_PICK_MS;
  };

  const items = headings.map((h) => {
    const level = Number(h.tagName.slice(1));
    const a = document.createElement("a");
    a.href = `#${h.id}`;
    a.textContent = h.textContent || "";
    const div = document.createElement("div");
    div.className = `toc__item toc__indent-${Math.min(4, level)}`;
    div.appendChild(a);
    host.appendChild(div);
    a.addEventListener("click", () => {
      lockTocToHeading(h);
      setActiveHeading(h);
    });
    return { h, div };
  });

  const syncTocHighlight = () => {
    if (!headings.length) return;
    if (tocUserPick && performance.now() < tocUserPickExpire) {
      setActiveHeading(tocUserPick);
      return;
    }
    tocUserPick = null;

    const threshold = Math.max(72, window.innerHeight * 0.2);
    const scrollY = window.scrollY;
    const vh = window.innerHeight;
    const scrollBottom = scrollY + vh;
    const docHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0
    );

    const last = headings[headings.length - 1];
    const lastIdx = headings.length - 1;

    if (scrollBottom >= docHeight - 16) {
      setActiveHeading(last);
      return;
    }

    // End of article: last N sections are often short and stacked; threshold-based spy skips rows.
    // Map scroll progress from the start of the tail block to max scroll → one TOC step per band.
    const TOC_TAIL_STEP_COUNT = 3;
    const useTailSteps = headings.length >= TOC_TAIL_STEP_COUNT + 2;
    if (useTailSteps) {
      const tailFirstIndex = headings.length - TOC_TAIL_STEP_COUNT;
      const tailFirst = headings[tailFirstIndex];
      const tailDocTop = tailFirst.getBoundingClientRect().top + scrollY;
      const scrollMax = Math.max(0, docHeight - vh);
      if (scrollY >= tailDocTop - 1) {
        const span = Math.max(1, scrollMax - tailDocTop);
        let t = (scrollY - tailDocTop) / span;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        const step = Math.min(
          TOC_TAIL_STEP_COUNT - 1,
          Math.floor(t * TOC_TAIL_STEP_COUNT + 1e-9)
        );
        setActiveHeading(headings[tailFirstIndex + step]);
        return;
      }
    }

    let active = headings[0];
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= threshold) active = h;
    }

    setActiveHeading(active);
  };

  let tocScrollTicking = false;
  const scheduleTocSync = () => {
    if (tocScrollTicking) return;
    tocScrollTicking = true;
    requestAnimationFrame(() => {
      tocScrollTicking = false;
      syncTocHighlight();
    });
  };

  window.addEventListener("scroll", scheduleTocSync, { passive: true });
  window.addEventListener("resize", scheduleTocSync);

  window.addEventListener("hashchange", () => {
    const id = decodeURIComponent((location.hash || "").slice(1));
    if (id) {
      const h = headings.find((el) => el.id === id);
      if (h) {
        lockTocToHeading(h);
        setActiveHeading(h);
      }
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(syncTocHighlight);
    });
  });

  if (location.hash) {
    const id = decodeURIComponent(location.hash.slice(1));
    const h = id && headings.find((el) => el.id === id);
    if (h) {
      lockTocToHeading(h);
      setActiveHeading(h);
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(syncTocHighlight);
    });
  } else {
    syncTocHighlight();
  }
}

/** Map /assets/... and /posts/... to the correct origin when the site is under a subpath (e.g. GitHub Project Pages). */
function resolveSiteAbsolutePath(path) {
  if (!path || typeof path !== "string" || !path.startsWith("/")) return path;
  const script = [...document.scripts].find((s) => /assets\/js\/main\.js(?:\?|$)/i.test(s.src));
  if (!script || !script.src) return path;
  const base = script.src.replace(/assets\/js\/main\.js(?:\?.*)?$/i, "");
  if (base === script.src) return path;
  try {
    return new URL(path.replace(/^\//, ""), base).href;
  } catch {
    return path;
  }
}

/** VS Code Live Server injects reload scripts into any served .html, including inside <svg> in fragments — that breaks the DOM and truncates fetches. Strip before parse. */
function scrubDevServerInjection(html) {
  let s = String(html || "");
  s = s.replace(/<!--\s*Code injected by live-server\s*-->[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?live-server[\s\S]*?<\/script>/gi, "");
  return s;
}

function injectHtmlFragment(el, html) {
  const raw = scrubDevServerInjection(String(html || "").replace(/^\uFEFF/, "")).trim();
  if (!raw) {
    el.replaceChildren();
    return;
  }
  try {
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${raw}</body></html>`,
      "text/html"
    );
    if (doc.querySelector("parsererror")) {
      el.innerHTML = raw;
    } else {
      el.replaceChildren(...doc.body.childNodes);
    }
  } catch {
    el.innerHTML = raw;
  }
}

async function loadHtmlPartials() {
  const nodes = document.querySelectorAll("[data-include]");
  await Promise.all(
    [...nodes].map(async (el) => {
      const url = el.getAttribute("data-include");
      if (!url) return;
      const fetchUrl = url.startsWith("/") ? resolveSiteAbsolutePath(url) : url;
      try {
        const res = await fetch(fetchUrl, { cache: "no-store" });
        if (!res.ok) return;
        injectHtmlFragment(el, await res.text());
        el.removeAttribute("data-include");
      } catch {
        //
      }
    })
  );
}

/**
 * Fill topbar breadcrumbs from JSON on the include wrapper:
 * data-breadcrumb='[{"text":"Home","href":"/"},{"text":"About"}]'
 * Segments with href become links; the last segment (or any without href) is the current page.
 */
function initTopbarBreadcrumbs() {
  document.querySelectorAll("[data-breadcrumb]").forEach((host) => {
    const raw = host.getAttribute("data-breadcrumb");
    if (raw == null || raw === "") return;
    let items;
    try {
      items = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(items) || items.length === 0) return;
    const nav = host.querySelector("nav.topbar__crumb");
    if (!nav) return;
    nav.replaceChildren();
    items.forEach((item, i) => {
      const text = item.text != null ? String(item.text) : "";
      if (!text) return;
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "topbar__crumb-sep";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = ">";
        nav.appendChild(sep);
      }
      const href = item.href != null && String(item.href) !== "" ? String(item.href) : null;
      if (href) {
        const a = document.createElement("a");
        a.className = "topbar__crumb-link";
        a.href = href;
        a.textContent = text;
        nav.appendChild(a);
      } else {
        const span = document.createElement("span");
        span.className = "topbar__crumb-current";
        span.textContent = text;
        nav.appendChild(span);
      }
    });
    host.removeAttribute("data-breadcrumb");
  });
}

/** Remove the longest common leading whitespace from every non-empty line (preserves relative indent, e.g. YAML). */
function dedentCommonLeadingWhitespace(s) {
  const t = String(s).replace(/\r\n/g, "\n");
  const lines = t.split("\n");
  const nonempty = lines.filter((line) => line.trim().length > 0);
  if (nonempty.length === 0) return t.trim();

  let minIndent = Infinity;
  for (const line of nonempty) {
    const leadLen = /^[ \t]*/.exec(line)[0].length;
    minIndent = Math.min(minIndent, leadLen);
  }
  if (minIndent === 0 || minIndent === Infinity) return t.trim();

  const dedented = lines.map((line) => {
    if (line.trim() === "") return "";
    const leadLen = /^[ \t]*/.exec(line)[0].length;
    if (leadLen >= minIndent) return line.slice(minIndent);
    return line.trimStart();
  });
  return dedented.join("\n").trim();
}

function initArticlePreDedents() {
  document.querySelectorAll(".content[data-article] pre.pre--dedent").forEach((pre) => {
    const code = pre.querySelector(":scope > code");
    if (!code) return;
    const raw = String(code.textContent || "");
    const next = dedentCommonLeadingWhitespace(raw);
    if (next !== raw) code.textContent = next;
    // Drop whitespace-only text nodes between <pre> and <code> (they render as extra lines in <pre>).
    pre.replaceChildren(code);
  });
}

function initSidebarNavActive() {
  let p = location.pathname.replace(/\/index\.html$/i, "");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (!p) p = "/";
  document.querySelectorAll(".sidebar .nav__item").forEach((a) => a.classList.remove("nav__item--active"));
  let activeHref = null;
  if (p === "/about.html") activeHref = "/about.html";
  else if (p === "/tags" || p.startsWith("/tags/")) activeHref = "/tags/";
  else if (p === "/projects" || p.startsWith("/projects/")) activeHref = "/projects/";
  else if (p === "/posts" || p.startsWith("/posts/")) activeHref = "/posts/";
  else if (p === "/") activeHref = "/";
  if (!activeHref) return;
  document.querySelectorAll(".sidebar a.nav__item").forEach((a) => {
    if (a.getAttribute("href") === activeHref) a.classList.add("nav__item--active");
  });
}

(async function startApp() {
  await loadHtmlPartials();
  initArticlePreDedents();
  initTopbarBreadcrumbs();
  initSidebarNavActive();
  await initTagMeta();
  initTheme();
  wireThemeButtons();
  initSidebarToggle();
  initSidebarCollapse();
  initPostsSearchNavigateFromOtherPages();
  initLatestPosts();
  initPostsIndex();
  initTrendingTags();
  initRecentlyUpdated();
  initToc();
  await initTagsManager();
  initYear();
})();

