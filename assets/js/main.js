const THEME_KEY = "theme";
const TAG_META_KEY = "tagMetaV1";

function loadTagMeta() {
  try {
    const raw = localStorage.getItem(TAG_META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveTagMeta(meta) {
  try {
    localStorage.setItem(TAG_META_KEY, JSON.stringify(meta || {}));
  } catch {}
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

  const label = document.querySelector("[data-theme-label]");
  if (label) label.textContent = root.dataset.theme ? root.dataset.theme : "system";
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
  const btn = document.querySelector("[data-sidebar-toggle]");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const open = document.body.dataset.sidebarOpen === "true";
    document.body.dataset.sidebarOpen = open ? "false" : "true";
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.body.dataset.sidebarOpen = "false";
  });

  document.addEventListener("click", (e) => {
    if (document.body.dataset.sidebarOpen !== "true") return;
    const sidebar = document.querySelector(".sidebar");
    const isClickInside = sidebar && sidebar.contains(e.target);
    const isMenuButton = btn.contains(e.target);
    if (!isClickInside && !isMenuButton) document.body.dataset.sidebarOpen = "false";
  });
}

async function loadPosts() {
  const res = await fetch("/posts/posts.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load posts.json");
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data;
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
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

  const firstTag = getVisiblePostTags(post)[0];
  if (firstTag) {
    const tag = document.createElement("span");
    tag.className = "pill";
    tag.textContent = `#${firstTag}`;
    meta.appendChild(tag);
  }

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

async function initLatestPosts() {
  const host = document.querySelector("[data-latest-posts]");
  if (!host) return;

  try {
    const posts = await loadPosts();
    posts
      .slice()
      .sort((a, b) => (String(b.date || "")).localeCompare(String(a.date || "")))
      .slice(0, 4)
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
    const filtered = tagFilter ? posts.filter((p) => getVisiblePostTags(p).includes(tagFilter)) : posts;
    render(filtered);
  } catch {
    host.innerHTML = `<div class="muted">Could not load posts.</div>`;
    return;
  }

  const tagHost = document.querySelector("[data-tags-menu]");
  if (tagHost) {
    const tagCounts = countTags(posts);
    const all = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    tagHost.innerHTML = "";
    const cloud = document.createElement("div");
    cloud.className = "tag-cloud";
    all.forEach(([tag, count]) => {
      const chip = renderTagChip(tag, count, { active: tag === tagFilter });
      if (chip) cloud.appendChild(chip);
    });
    tagHost.appendChild(cloud);
  }

  if (!q) return;
  q.addEventListener("input", () => {
    const term = q.value.trim().toLowerCase();
    const base = tagFilter
      ? posts.filter((p) => getVisiblePostTags(p).includes(tagFilter))
      : posts;

    if (!term) return render(base);
    const filtered = base.filter((p) => {
      const hay = `${p.title || ""} ${getVisiblePostTags(p).join(" ")} ${p.description || ""}`.toLowerCase();
      return hay.includes(term);
    });
    render(filtered);
  });
}

async function initTagsManager() {
  const root = document.querySelector("[data-tags-manager]");
  const list = document.querySelector("[data-tags-list]");
  if (!root || !list) return;

  const addBtn = root.querySelector("[data-add-tag]");
  const newNameEl = root.querySelector("[data-new-tag-name]");
  const newColorEl = root.querySelector("[data-new-tag-color]");

  const meta = loadTagMeta();
  let posts = [];
  try {
    posts = await loadPosts();
  } catch {
    // ok
  }
  const counts = countTags(posts);
  Object.keys(meta).forEach((name) => {
    if (!counts.has(name)) counts.set(name, 0);
  });
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));

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

  function render() {
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

      const colorInput = document.createElement("input");
      colorInput.className = "input input--sm";
      colorInput.type = "color";
      colorInput.value = String(info.color || getTagColor(name, info).color);

      const delBtn = document.createElement("button");
      delBtn.className = `button button--ghost ${info.deleted ? "" : "button--danger"}`.trim();
      delBtn.type = "button";
      delBtn.textContent = info.deleted ? "Restore" : "Delete";

      renameInput.addEventListener("change", () => {
        const v = normalizeTagName(renameInput.value || "");
        meta[name] = { ...(meta[name] || {}) };
        if (!v) delete meta[name].renameTo;
        else if (!isValidTagName(v)) return;
        else if (v === name) delete meta[name].renameTo;
        else meta[name].renameTo = v;
        saveTagMeta(meta);
        location.reload();
      });

      colorInput.addEventListener("change", () => {
        const v = String(colorInput.value || "").trim();
        meta[name] = { ...(meta[name] || {}) };
        if (v) meta[name].color = v;
        else delete meta[name].color;
        saveTagMeta(meta);
        location.reload();
      });

      delBtn.addEventListener("click", () => {
        meta[name] = { ...(meta[name] || {}), deleted: !info.deleted };
        saveTagMeta(meta);
        location.reload();
      });

      row.appendChild(left);
      row.appendChild(renameInput);
      row.appendChild(colorInput);
      row.appendChild(delBtn);
      list.appendChild(row);
    });
  }

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      const name = normalizeTagName(newNameEl && newNameEl.value);
      if (!name || !isValidTagName(name)) return;
      const color = String((newColorEl && newColorEl.value) || "").trim();
      meta[name] = { ...(meta[name] || {}) };
      if (color) meta[name].color = color;
      if (meta[name].deleted) meta[name].deleted = false;
      saveTagMeta(meta);
      location.reload();
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

function renderTagChip(tag, count, { active = false } = {}) {
  const meta = loadTagMeta();
  const info = meta[tag] || {};
  if (info.deleted) return null;

  const a = document.createElement("a");
  a.className = `tag${active ? " tag--active" : ""}`;
  a.href = `/posts/?tag=${encodeURIComponent(tag)}`;
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

  const items = headings.map((h) => {
    const level = Number(h.tagName.slice(1));
    const a = document.createElement("a");
    a.href = `#${h.id}`;
    a.textContent = h.textContent || "";
    const div = document.createElement("div");
    div.className = `toc__item toc__indent-${Math.min(4, level)}`;
    div.appendChild(a);
    host.appendChild(div);
    return { h, div };
  });

  const io = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      items.forEach(({ div }) => div.classList.remove("toc__item--active"));
      const hit = items.find((x) => x.h === visible.target);
      if (hit) hit.div.classList.add("toc__item--active");
    },
    { rootMargin: "-20% 0px -70% 0px", threshold: [0.1, 0.2, 0.4, 0.6] }
  );

  headings.forEach((h) => io.observe(h));
}

initTheme();
wireThemeButtons();
initSidebarToggle();
initLatestPosts();
initPostsIndex();
initTrendingTags();
initRecentlyUpdated();
initToc();
initTagsManager();
initYear();

