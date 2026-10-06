const DATA_URL = "data.json";

// Drivers don't reliably think to hit the manual refresh button, so pull a
// fresh copy of data.json on a timer too. Re-uses loadData's existing
// forceNetwork path (bypasses cache, re-renders the results list) rather
// than reloading the whole page, so it can't interrupt a video that's
// playing or wipe out whatever's typed in the search box.
const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// Per-deployment switch for the State > City browsing tree (collapsible
// cities + favorite cities). true  = browsing shows the grouped tree.
// false = browsing shows one plain flat list of every stop, no grouping.
// Set this before uploading for each customer. Drivers never see a toggle.
// Account-number search behaves the same either way.
const ENABLE_GROUPING = false;

const resultsEl = document.getElementById("results");
const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");
const statusLine = document.getElementById("statusLine");
const stopCountText = document.getElementById("stopCountText");
const refreshCountdown = document.getElementById("refreshCountdown");
const emptyState = document.getElementById("emptyState");
const emptyTitle = document.getElementById("emptyTitle");
const emptySub = document.getElementById("emptySub");
const updatedLine = document.getElementById("updatedLine");
const offlineTag = document.getElementById("offlineTag");
const refreshBtn = document.getElementById("refreshBtn");
const videoModal = document.getElementById("videoModal");
const videoPlayer = document.getElementById("videoPlayer");
const videoModalTitle = document.getElementById("videoModalTitle");
const videoModalClose = document.getElementById("videoModalClose");
const imageModal = document.getElementById("imageModal");
const imageModalGrid = document.getElementById("imageModalGrid");
const imageModalImg = document.getElementById("imageModalImg");
const imageModalTitle = document.getElementById("imageModalTitle");
const imageModalClose = document.getElementById("imageModalClose");

let allLocations = [];

// ── Favorites (long-press to toggle) ────────────────────────────────────────
const FAVORITES_KEY = "napa-route-directory-favorites";

function loadFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveFavorites(set) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage unavailable (private browsing, storage full) — favorites
    // just won't persist across reloads this session, non-fatal.
  }
}
let favorites = loadFavorites();

// ── State → City browsing tree (per-phone, local only) ──────────────────────
// Browsing (empty search box) is always grouped by State, then City, both
// alphabetical. Every city header is independently collapsible; which ones
// are collapsed persists per phone so a driver's view stays the way they
// left it. States themselves are always fully listed — only cities collapse.
const COLLAPSED_CITIES_KEY = "napa-route-directory-collapsed-cities";

function cityKey(state, city) {
  return `${(state || "").trim()}||${(city || "").trim()}`;
}

function loadCollapsedCities() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_CITIES_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveCollapsedCities(set) {
  try {
    localStorage.setItem(COLLAPSED_CITIES_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage unavailable — collapsed state just won't persist.
  }
}
let collapsedCities = loadCollapsedCities();

// ── Favorite cities (per-phone, local only) ──────────────────────────────────
// Long-press a city header — either in its normal State > City spot or in
// the pinned Favorites section — to toggle it. A favorited city gets pinned
// in a "Favorite Cities" section at the very top of the browsing tree,
// always fully expanded, in addition to staying in its normal alphabetical
// spot further down.
const FAVORITE_CITIES_KEY = "napa-route-directory-favorite-cities";

function loadFavoriteCities() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAVORITE_CITIES_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveFavoriteCities(set) {
  try {
    localStorage.setItem(FAVORITE_CITIES_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage unavailable — favorite cities just won't persist.
  }
}
let favoriteCities = loadFavoriteCities();

function toggleFavoriteCity(key) {
  if (favoriteCities.has(key)) favoriteCities.delete(key);
  else favoriteCities.add(key);
  saveFavoriteCities(favoriteCities);
  applySearch();
}

// Wires long-press-to-toggle-favorite onto a city header element. Flags
// el.dataset.longPressFired so the header's own click handler (collapse in
// the normal tree, none in the pinned section) can tell a long-press
// happened and skip its own action — mirrors the ticket long-press pattern.
function wireCityLongPress(el, key) {
  const LONG_PRESS_MS = 550;
  const MOVE_CANCEL_PX = 10;
  let pressTimer = null;
  let startX = 0;
  let startY = 0;

  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  el.addEventListener("pointerdown", e => {
    el.dataset.longPressFired = "";
    startX = e.clientX;
    startY = e.clientY;
    pressTimer = setTimeout(() => {
      el.dataset.longPressFired = "1";
      toggleFavoriteCity(key);
    }, LONG_PRESS_MS);
  });
  el.addEventListener("pointermove", e => {
    if (Math.abs(e.clientX - startX) > MOVE_CANCEL_PX || Math.abs(e.clientY - startY) > MOVE_CANCEL_PX) {
      cancelPress();
    }
  });
  el.addEventListener("pointerup", cancelPress);
  el.addEventListener("pointercancel", cancelPress);
  el.addEventListener("pointerleave", cancelPress);
}

function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  saveFavorites(favorites);
  applySearch();
}

// Rewrites a Dropbox share link into a direct, embeddable stream URL so the
// video plays inline in the page instead of handing off to the Dropbox app
// or downloading the file.
function getPlayableUrl(url) {
  if (!url) return "";
  if (!url.includes("dropbox.com")) return url;
  if (/[?&]raw=1/.test(url)) return url;
  if (/[?&]dl=[01]/.test(url)) return url.replace(/([?&])dl=[01]/, "$1raw=1");
  return url + (url.includes("?") ? "&" : "?") + "raw=1";
}

// "/home/..." Dropbox paths are the private browser-view path, not a real
// shareable link — they won't play for a driver who isn't logged into the
// right Dropbox account. Treat those as absent rather than show a dead button.
function isPlayableVideoUrl(url) {
  return !!url && !url.includes("/home/");
}

function getMapUrl(loc) {
  const parts = [loc.address, loc.city, loc.state].filter(Boolean);
  if (parts.length === 0) return "";
  return "https://maps.google.com/?q=" + encodeURIComponent(parts.join(", "));
}

// Fixed 3-letter city codes for the NWA cities in the directory, so the
// same city always abbreviates the same way regardless of capitalization
// in the data. Any city not in this list falls back to its own first
// 3 letters, title-cased (e.g. "Elkins" -> "Elk" is already covered above,
// but a brand-new city like "Huntsville" would fall back to "Hun").
const CITY_CODES = {
  "bentonville": "Ben",
  "rogers": "Rog",
  "springdale": "Spr",
  "fayetteville": "Fay",
  "lowell": "Low",
  "cave springs": "Cav",
  "centerton": "Cen",
  "elkins": "Elk"
};

function getCityCode(city) {
  const trimmed = String(city || "").trim();
  if (!trimmed) return "";
  const known = CITY_CODES[trimmed.toLowerCase()];
  if (known) return known;
  const letters = trimmed.slice(0, 3);
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

function openVideo(loc) {
  videoModalTitle.textContent = loc.name;
  videoPlayer.src = getPlayableUrl(loc.videoUrl);
  videoModal.hidden = false;
  document.body.style.overflow = "hidden";
  videoPlayer.play().catch(() => {});
}

function closeVideo() {
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  videoModal.hidden = true;
  document.body.style.overflow = "";
}

videoModalClose.addEventListener("click", closeVideo);
videoModal.addEventListener("click", e => {
  if (e.target === videoModal) closeVideo();
});

// Combines the legacy single loc.imageUrl with the newer loc.imageUrls array
// (Generate-Links-discovered photos) into one ordered, de-duplicated list.
function collectImages(loc) {
  const urls = [];
  if (loc.imageUrl) urls.push(loc.imageUrl);
  if (Array.isArray(loc.imageUrls)) {
    for (const u of loc.imageUrls) {
      if (u && !urls.includes(u)) urls.push(u);
    }
  }
  return urls;
}

function showImageGrid(loc, images) {
  imageModalGrid.innerHTML = "";
  imageModalGrid.hidden = false;
  imageModalImg.hidden = true;
  imageModalImg.removeAttribute("src");

  images.forEach((url, i) => {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "image-modal-thumb";
    thumb.setAttribute("aria-label", `View photo ${i + 1} of ${images.length} for ${loc.name}`);
    thumb.innerHTML = `<img src="${escapeAttr(url)}" alt="Site photo ${i + 1} for ${escapeHtml(loc.name)}">`;
    thumb.addEventListener("click", () => zoomImage(loc, images, i));
    imageModalGrid.appendChild(thumb);
  });
}

function zoomImage(loc, images, index) {
  imageModalGrid.hidden = true;
  imageModalImg.src = images[index];
  imageModalImg.alt = "Site photo for " + loc.name;
  imageModalImg.hidden = false;
  // Tapping the zoomed photo goes back to the grid. Single-photo sites have
  // nothing to go "back" to, so just close the modal instead.
  imageModalImg.onclick = () => {
    if (images.length > 1) showImageGrid(loc, images);
    else closeImage();
  };
}

function openImage(loc) {
  const images = collectImages(loc);
  if (images.length === 0) return;
  imageModalTitle.textContent = loc.name;
  imageModal.hidden = false;
  document.body.style.overflow = "hidden";
  // Single photo: skip straight to the zoomed view — no point showing a
  // one-tile grid first. Multiple photos: show the grid to pick from.
  if (images.length === 1) zoomImage(loc, images, 0);
  else showImageGrid(loc, images);
}

function closeImage() {
  imageModal.hidden = true;
  imageModalGrid.hidden = true;
  imageModalGrid.innerHTML = "";
  imageModalImg.hidden = true;
  imageModalImg.removeAttribute("src");
  imageModalImg.onclick = null;
  document.body.style.overflow = "";
}

imageModalClose.addEventListener("click", closeImage);
imageModal.addEventListener("click", e => {
  if (e.target === imageModal) closeImage();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (!videoModal.hidden) closeVideo();
    if (!imageModal.hidden) closeImage();
  }
});

// Builds one <li class="ticket"> with all its interactivity (tap-to-open
// photo, Watch button, long-press-to-favorite). Shared by the flat search
// results list and the grouped state/city browsing tree so the two never
// drift out of sync.
function buildTicketLi(loc) {
  const li = document.createElement("li");

  const mapUrl = getMapUrl(loc);
  const hasImage = !!loc.imageUrl || (Array.isArray(loc.imageUrls) && loc.imageUrls.length > 0);
  const hasVideo = isPlayableVideoUrl(loc.videoUrl);
  const cityCode = getCityCode(loc.city);

  const isFavorite = favorites.has(loc.id);
  li.className = "ticket" + (hasImage ? " ticket--has-image" : "") + (isFavorite ? " ticket--favorite" : "");

  li.innerHTML = `
    ${loc.accountNumber ? `<span class="ticket-account${hasImage ? " ticket-account--has-image" : ""}">#${escapeHtml(loc.accountNumber)}</span>` : `<span class="ticket-account ticket-account-empty"></span>`}
    ${cityCode ? `<span class="ticket-city">${escapeHtml(cityCode)}</span>` : ""}
    <span class="ticket-name">${isFavorite ? `<span class="ticket-fav-star" aria-label="Favorited">&#9733;</span>` : ""}${escapeHtml(loc.name)}</span>
    <span class="ticket-btns">
      ${mapUrl ? `<a class="ticket-btn ticket-btn-map" href="${escapeAttr(mapUrl)}" target="_blank" rel="noopener" aria-label="Open map for ${escapeHtml(loc.name)}">Map</a>` : ""}
      ${hasVideo ? `<button type="button" class="ticket-btn ticket-btn-watch" aria-label="Watch video for ${escapeHtml(loc.name)}">&#9654; Watch</button>` : ""}
    </span>
  `;

  // Tapping the card itself (not the Map/Watch buttons) opens the site
  // photo, if there is one. The account-number badge gets a green ring
  // (via .ticket-account--has-image in CSS) as the visual cue that a
  // photo is available — replaces the old standalone Photo button.
  if (hasImage) {
    li.addEventListener("click", e => {
      if (longPressFired) { longPressFired = false; return; }
      if (e.target.closest("a, button")) return;
      openImage(loc);
    });
  }
  if (hasVideo) {
    li.querySelector(".ticket-btn-watch").addEventListener("click", () => openVideo(loc));
  }

  // ── Long-press to favorite / unfavorite ─────────────────────────────
  // Hold ~550ms without moving to toggle. Suppresses the trailing click
  // (longPressFired) so a favorite-toggle never also opens the photo.
  const LONG_PRESS_MS = 550;
  const MOVE_CANCEL_PX = 10;
  let pressTimer = null;
  let longPressFired = false;
  let startX = 0;
  let startY = 0;

  const cancelPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  li.addEventListener("pointerdown", e => {
    if (e.target.closest("a, button")) return;
    longPressFired = false;
    startX = e.clientX;
    startY = e.clientY;
    pressTimer = setTimeout(() => {
      longPressFired = true;
      toggleFavorite(loc.id);
    }, LONG_PRESS_MS);
  });
  li.addEventListener("pointermove", e => {
    if (Math.abs(e.clientX - startX) > MOVE_CANCEL_PX || Math.abs(e.clientY - startY) > MOVE_CANCEL_PX) {
      cancelPress();
    }
  });
  li.addEventListener("pointerup", cancelPress);
  li.addEventListener("pointercancel", cancelPress);
  li.addEventListener("pointerleave", cancelPress);

  return li;
}

// Flat results list — used for search matches. Assumes list is non-empty;
// callers handle the empty state themselves.
function renderFlatList(list) {
  resultsEl.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "ticket-list";
  list.forEach(loc => ul.appendChild(buildTicketLi(loc)));
  resultsEl.appendChild(ul);
}

// Grouped browsing view: State (always fully listed, alphabetical) → City
// Builds one collapsible city header + location list. Shared by the pinned
// Favorites section and the normal State > City tree so both read/write the
// exact same collapsedCities entry for a given city — collapsing a city in
// either spot collapses it everywhere that city appears.
function buildCityBlock(state, city, locs, { includeState = false } = {}) {
  const key = cityKey(state, city);
  const collapsed = collapsedCities.has(key);
  const isFavoriteCity = favoriteCities.has(key);
  const sortedLocs = applyFavoritesFirst(sortLocations(locs, sortSelect.value));

  const citySection = document.createElement("div");
  citySection.className = "city-group";

  const cityHeader = document.createElement("button");
  cityHeader.type = "button";
  cityHeader.className = "city-group-header" + (collapsed ? " city-group-header--collapsed" : "");
  cityHeader.setAttribute("aria-expanded", String(!collapsed));
  const label = includeState ? `${escapeHtml(city)}, ${escapeHtml(state)}` : escapeHtml(city);
  cityHeader.innerHTML = `
    <span class="city-group-chevron">${collapsed ? "&#9656;" : "&#9662;"}</span>
    ${isFavoriteCity ? `<span class="city-group-star" aria-label="Favorited">&#9733;</span>` : ""}
    <span class="city-group-name">${label}</span>
    <span class="city-group-count">${sortedLocs.length}</span>
  `;

  const cityList = document.createElement("ul");
  cityList.className = "ticket-list city-group-list";
  cityList.hidden = collapsed;
  sortedLocs.forEach(loc => cityList.appendChild(buildTicketLi(loc)));

  wireCityLongPress(cityHeader, key);
  cityHeader.addEventListener("click", () => {
    // A long-press just toggled this city's favorite status — don't also
    // collapse/expand it off the back of that same press.
    if (cityHeader.dataset.longPressFired === "1") {
      cityHeader.dataset.longPressFired = "";
      return;
    }
    const nowCollapsed = !cityList.hidden;
    cityList.hidden = nowCollapsed;
    cityHeader.classList.toggle("city-group-header--collapsed", nowCollapsed);
    cityHeader.setAttribute("aria-expanded", String(!nowCollapsed));
    cityHeader.querySelector(".city-group-chevron").innerHTML = nowCollapsed ? "&#9656;" : "&#9662;";
    if (nowCollapsed) collapsedCities.add(key);
    else collapsedCities.delete(key);
    saveCollapsedCities(collapsedCities);
  });

  citySection.appendChild(cityHeader);
  citySection.appendChild(cityList);
  return citySection;
}

// Grouped browsing view: State (always fully listed, alphabetical) → City
// (alphabetical, independently collapsible) → that city's locations.
// Assumes locations is non-empty; callers handle the empty state themselves.
function renderGrouped(locations) {
  resultsEl.innerHTML = "";

  const byState = new Map();
  for (const loc of locations) {
    const state = (loc.state || "").trim() || "Unknown";
    const city = (loc.city || "").trim() || "Unknown";
    if (!byState.has(state)) byState.set(state, new Map());
    const cities = byState.get(state);
    if (!cities.has(city)) cities.set(city, []);
    cities.get(city).push(loc);
  }

  const states = [...byState.keys()].sort((a, b) => a.localeCompare(b));
  const frag = document.createDocumentFragment();

  // ── Pinned Favorites section ───────────────────────────────────────────
  // Favorited cities, alphabetical by city name (state as tiebreaker).
  // These also stay in their normal State > City spot further down — this
  // is a pinned shortcut, not a move — and share the same collapse state
  // as that normal spot (buildCityBlock keys off the same cityKey), so
  // collapsing one collapses the other.
  const pinned = [];
  for (const state of states) {
    for (const city of byState.get(state).keys()) {
      const key = cityKey(state, city);
      if (favoriteCities.has(key)) pinned.push({ state, city, locs: byState.get(state).get(city) });
    }
  }
  pinned.sort((a, b) => compareText(a.city, b.city) || compareText(a.state, b.state));

  if (pinned.length > 0) {
    const favSection = document.createElement("div");
    favSection.className = "favorites-group";

    const favHeader = document.createElement("div");
    favHeader.className = "favorites-group-header";
    favHeader.innerHTML = `<span class="city-group-star">&#9733;</span> Favorite Cities`;
    favSection.appendChild(favHeader);

    for (const entry of pinned) {
      favSection.appendChild(buildCityBlock(entry.state, entry.city, entry.locs, { includeState: true }));
    }

    frag.appendChild(favSection);
  }

  for (const state of states) {
    const stateSection = document.createElement("div");
    stateSection.className = "state-group";

    const stateHeader = document.createElement("div");
    stateHeader.className = "state-group-header";
    stateHeader.textContent = state;
    stateSection.appendChild(stateHeader);

    const citiesMap = byState.get(state);
    const cities = [...citiesMap.keys()].sort((a, b) => a.localeCompare(b));

    for (const city of cities) {
      stateSection.appendChild(buildCityBlock(state, city, citiesMap.get(city)));
    }

    frag.appendChild(stateSection);
  }

  resultsEl.appendChild(frag);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[s]));
}
function escapeAttr(str) { return escapeHtml(str); }

// Account-number-only search. Name/address/city/state/zip are intentionally
// excluded — drivers were matching on the wrong stop by typing a street name
// or business name that happened to match a different account. Account
// number is the one field that isn't ambiguous. Always searches every stop,
// regardless of which state/city groups are collapsed while browsing.
function filterLocations(query) {
  const q = query.trim().toLowerCase();
  if (!q) return allLocations;
  return allLocations.filter(loc => {
    const accountNumber = String(loc.accountNumber || "").toLowerCase();
    return accountNumber.includes(q);
  });
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function compareAccountNumber(a, b) {
  const aNum = parseInt(a, 10);
  const bNum = parseInt(b, 10);
  const aValid = !isNaN(aNum);
  const bValid = !isNaN(bNum);
  if (aValid && bValid) return aNum - bNum;
  if (aValid) return -1;
  if (bValid) return 1;
  return compareText(a, b);
}

// State/city ordering is now structural (the browsing tree is always
// State → City, alphabetical) rather than a sort choice, so this only ever
// needs to order locations within a single flat list or a single city group.
function sortLocations(list, sortBy) {
  const sorted = list.slice();
  switch (sortBy) {
    case "account":
      sorted.sort((a, b) => compareAccountNumber(a.accountNumber, b.accountNumber));
      break;
    case "name":
    default:
      sorted.sort((a, b) => compareText(a.name, b.name));
      break;
  }
  return sorted;
}

// Floats favorited stops to the top, preserving the relative order the
// current sort (name/account/city/etc.) already produced within each group.
// Relies on Array.prototype.sort's stability, which is spec-guaranteed
// (ES2019+) in every browser this PWA targets.
function applyFavoritesFirst(list) {
  const sorted = list.slice();
  sorted.sort((a, b) => (favorites.has(b.id) ? 1 : 0) - (favorites.has(a.id) ? 1 : 0));
  return sorted;
}

function applySearch() {
  const query = searchInput.value.trim();

  if (allLocations.length === 0) {
    resultsEl.innerHTML = "";
    emptyTitle.textContent = "No current locations listed.";
    emptySub.textContent = "The directory is being updated, check back soon.";
    emptyState.hidden = false;
    statusLine.textContent = "";
    return;
  }

  if (query) {
    // Searching always flattens to a plain match list, by account number
    // only, regardless of which state/city groups are collapsed.
    const filtered = filterLocations(searchInput.value);
    const sorted = applyFavoritesFirst(sortLocations(filtered, sortSelect.value));
    if (sorted.length === 0) {
      resultsEl.innerHTML = "";
      emptyTitle.textContent = "No match on the board.";
      emptySub.textContent = "Search is by account number only.";
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
      renderFlatList(sorted);
    }
    statusLine.textContent = filtered.length === allLocations.length
      ? `Showing all ${allLocations.length} stops`
      : `${filtered.length} of ${allLocations.length} stops match`;
  } else {
    // Browsing: the State → City tree when ENABLE_GROUPING is on, otherwise
    // one plain flat list of every stop.
    emptyState.hidden = true;
    if (ENABLE_GROUPING) {
      renderGrouped(allLocations);
    } else {
      renderFlatList(applyFavoritesFirst(sortLocations(allLocations, sortSelect.value)));
    }
    statusLine.textContent = `Showing all ${allLocations.length} stops`;
  }
}

async function loadData({ forceNetwork = false } = {}) {
  stopCountText.textContent = "loading stops\u2026";
  try {
    const url = forceNetwork ? `${DATA_URL}?t=${Date.now()}` : DATA_URL;
    const res = await fetch(url, { cache: forceNetwork ? "no-store" : "default" });
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    allLocations = data.locations || [];
    stopCountText.textContent = `${allLocations.length} stops on file`;
    updatedLine.textContent = data.updated ? `Data updated ${data.updated}` : "";
    applySearch();
  } catch (err) {
    stopCountText.textContent = "couldn't load stops";
    statusLine.textContent = "Check your connection and try refresh.";
  } finally {
    // Every completed load (success or failure) reschedules the next
    // auto-refresh AUTO_REFRESH_MS from now \u2014 this covers the initial load,
    // the timer firing, and a manual refresh-button press all the same way,
    // so pressing refresh also resets the countdown instead of leaving a
    // stale one running alongside a fresh timer.
    scheduleNextRefresh();
  }
}

// \u2500\u2500 Auto-refresh countdown \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let nextRefreshAt = 0;
let refreshTimer = null;

function scheduleNextRefresh() {
  nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  refreshCountdown.hidden = false;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadData({ forceNetwork: true }), AUTO_REFRESH_MS);
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function tickCountdown() {
  if (!nextRefreshAt) return;
  refreshCountdown.textContent = `\u00b7 next refresh in ${formatCountdown(nextRefreshAt - Date.now())}`;
}
setInterval(tickCountdown, 1000);

searchInput.addEventListener("input", applySearch);
sortSelect.addEventListener("change", applySearch);
refreshBtn.addEventListener("click", () => loadData({ forceNetwork: true }));

function updateOfflineTag() {
  offlineTag.hidden = navigator.onLine;
}
window.addEventListener("online", updateOfflineTag);
window.addEventListener("offline", updateOfflineTag);
updateOfflineTag();

loadData();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {
      // registration failure is non-fatal; app still works online
    });
  });
}
