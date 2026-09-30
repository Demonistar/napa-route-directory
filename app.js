const DATA_URL = "data.json";

// Drivers don't reliably think to hit the manual refresh button, so pull a
// fresh copy of data.json on a timer too. Re-uses loadData's existing
// forceNetwork path (bypasses cache, re-renders the results list) rather
// than reloading the whole page, so it can't interrupt a video that's
// playing or wipe out whatever's typed in the search box.
const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

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
const settingsBtn = document.getElementById("settingsBtn");
const settingsModal = document.getElementById("settingsModal");
const settingsModalClose = document.getElementById("settingsModalClose");
const modeAllRadio = document.getElementById("modeAll");
const modeCustomRadio = document.getElementById("modeCustom");
const settingsHelpBtn = document.getElementById("settingsHelpBtn");
const settingsHelpPanel = document.getElementById("settingsHelpPanel");
const cityChecklist = document.getElementById("cityChecklist");
const saveFilterBtn = document.getElementById("saveFilterBtn");
const resetFilterBtn = document.getElementById("resetFilterBtn");

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

// ── Custom city filter (per-phone, local only) ──────────────────────────────
// Two independent pieces of saved state:
//  - viewMode: "all" or "custom" — which mode is currently active.
//  - customCities: the set of "State||City" keys the driver saved as their
//    custom list. Applies to the BROWSING list only (empty search box).
//    Search always searches every stop by account number regardless of mode
//    or saved cities — see filterLocations().
const VIEW_MODE_KEY = "napa-route-directory-view-mode";
const CUSTOM_CITIES_KEY = "napa-route-directory-custom-cities";

function cityKey(state, city) {
  return `${(state || "").trim()}||${(city || "").trim()}`;
}

function loadViewMode() {
  try {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    return stored === "custom" ? "custom" : "all";
  } catch {
    return "all";
  }
}
function saveViewMode(mode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // localStorage unavailable — mode just won't persist across reloads.
  }
}
let viewMode = loadViewMode();

function loadCustomCities() {
  try {
    return new Set(JSON.parse(localStorage.getItem(CUSTOM_CITIES_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveCustomCities(set) {
  try {
    localStorage.setItem(CUSTOM_CITIES_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage unavailable — custom filter just won't persist.
  }
}
// The saved, applied filter. Only this (never pendingCities) affects what's
// shown on the main list.
let savedCities = loadCustomCities();
// Working copy while the settings panel is open — checkbox taps only touch
// this, so closing the panel without hitting Save discards the edits.
let pendingCities = new Set(savedCities);

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

// ── Custom city filter settings panel ───────────────────────────────────────

// Builds the state/city checklist from whatever's actually in the currently
// loaded data (not hardcoded), so it stays correct as stops are added, moved,
// or removed. Reflects pendingCities (the panel's working copy), not
// savedCities, so re-opening the panel shows whatever was last confirmed.
function renderCityChecklist() {
  const byState = new Map();
  for (const loc of allLocations) {
    const state = (loc.state || "").trim();
    const city = (loc.city || "").trim();
    if (!state || !city) continue;
    if (!byState.has(state)) byState.set(state, new Set());
    byState.get(state).add(city);
  }

  if (byState.size === 0) {
    cityChecklist.innerHTML = `<p class="city-checklist-empty">No stops loaded yet.</p>`;
    return;
  }

  const states = [...byState.keys()].sort((a, b) => a.localeCompare(b));
  cityChecklist.innerHTML = states.map(state => {
    const cities = [...byState.get(state)].sort((a, b) => a.localeCompare(b));
    const items = cities.map(city => {
      const key = cityKey(state, city);
      const checked = pendingCities.has(key) ? "checked" : "";
      return `
        <label class="city-checklist-item">
          <input type="checkbox" data-city-key="${escapeAttr(key)}" ${checked}>
          ${escapeHtml(city)}
        </label>`;
    }).join("");
    return `
      <div class="city-checklist-group">
        <div class="city-checklist-state">${escapeHtml(state)}</div>
        ${items}
      </div>`;
  }).join("");
}

function openSettingsModal() {
  // Reset the working copy to whatever's actually saved, so unsaved edits
  // from a previous open (closed without hitting Save) don't carry over.
  pendingCities = new Set(savedCities);
  modeAllRadio.checked = viewMode === "all";
  modeCustomRadio.checked = viewMode === "custom";
  settingsHelpPanel.hidden = true;
  renderCityChecklist();
  settingsModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSettingsModal() {
  settingsModal.hidden = true;
  document.body.style.overflow = "";
}

settingsBtn.addEventListener("click", openSettingsModal);
settingsModalClose.addEventListener("click", closeSettingsModal);
settingsModal.addEventListener("click", e => {
  if (e.target === settingsModal) closeSettingsModal();
});

settingsHelpBtn.addEventListener("click", () => {
  settingsHelpPanel.hidden = !settingsHelpPanel.hidden;
});

// Mode switch takes effect immediately, live, on the main list — it's just
// a toggle, not something that needs an explicit Save like the city picks.
function applyViewMode(mode) {
  viewMode = mode;
  saveViewMode(viewMode);
  applySearch();
}
modeAllRadio.addEventListener("change", () => { if (modeAllRadio.checked) applyViewMode("all"); });
modeCustomRadio.addEventListener("change", () => { if (modeCustomRadio.checked) applyViewMode("custom"); });

// Checkbox taps only touch the working copy (pendingCities) — nothing is
// applied to the main list until Save Custom Filter is pressed.
cityChecklist.addEventListener("change", e => {
  const checkbox = e.target.closest("input[type=checkbox][data-city-key]");
  if (!checkbox) return;
  const key = checkbox.dataset.cityKey;
  if (checkbox.checked) pendingCities.add(key);
  else pendingCities.delete(key);
});

saveFilterBtn.addEventListener("click", () => {
  savedCities = new Set(pendingCities);
  saveCustomCities(savedCities);
  applySearch();
});

resetFilterBtn.addEventListener("click", () => {
  savedCities = new Set();
  pendingCities = new Set();
  saveCustomCities(savedCities);
  renderCityChecklist();
  applySearch();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (!videoModal.hidden) closeVideo();
    if (!imageModal.hidden) closeImage();
    if (!settingsModal.hidden) closeSettingsModal();
  }
});

function render(list) {
  resultsEl.innerHTML = "";

  if (list.length === 0) {
    if (allLocations.length === 0) {
      emptyTitle.textContent = "No current locations listed.";
      emptySub.textContent = "The directory is being updated, check back soon.";
    } else if (!searchInput.value.trim() && viewMode === "custom" && savedCities.size > 0) {
      // Browsing (no search typed) in Custom mode, but the saved cities
      // don't match anything currently in the data — e.g. a stop's city
      // changed, or every stop in a saved city was removed.
      emptyTitle.textContent = "No stops in your custom cities.";
      emptySub.textContent = "Open settings to change which cities are shown.";
    } else {
      emptyTitle.textContent = "No match on the board.";
      emptySub.textContent = "Search is by account number only.";
    }
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  const frag = document.createDocumentFragment();
  list.forEach(loc => {
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

    frag.appendChild(li);
  });
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
// number is the one field that isn't ambiguous.
// Applies the saved Custom city filter to the browsing list (empty search
// box only). Falls back to everything if Custom mode is on but nothing's
// been saved yet, per how this is meant to behave until a filter exists.
function applyCustomCityFilter(locations) {
  if (viewMode !== "custom" || savedCities.size === 0) return locations;
  return locations.filter(loc => savedCities.has(cityKey(loc.state, loc.city)));
}

function filterLocations(query) {
  const q = query.trim().toLowerCase();
  // A typed search always searches every stop by account number, regardless
  // of Custom mode or which cities are saved — the custom filter only
  // narrows what's shown while browsing with an empty search box.
  if (!q) return applyCustomCityFilter(allLocations);
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

function sortLocations(list, sortBy) {
  const sorted = list.slice();
  switch (sortBy) {
    case "account":
      sorted.sort((a, b) => compareAccountNumber(a.accountNumber, b.accountNumber));
      break;
    case "city":
      sorted.sort((a, b) => compareText(a.city, b.city) || compareText(a.name, b.name));
      break;
    case "state_city_name":
      sorted.sort((a, b) =>
        compareText(a.state, b.state) ||
        compareText(a.city, b.city) ||
        compareText(a.name, b.name)
      );
      break;
    case "state_city_account":
      sorted.sort((a, b) =>
        compareText(a.state, b.state) ||
        compareText(a.city, b.city) ||
        compareAccountNumber(a.accountNumber, b.accountNumber)
      );
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
  const filtered = filterLocations(searchInput.value);
  const sorted = applyFavoritesFirst(sortLocations(filtered, sortSelect.value));
  render(sorted);

  if (query) {
    statusLine.textContent = filtered.length === allLocations.length
      ? `Showing all ${allLocations.length} stops`
      : `${filtered.length} of ${allLocations.length} stops match`;
  } else if (viewMode === "custom" && savedCities.size > 0) {
    // Browsing with the Custom city filter actually narrowing the list —
    // distinct wording from a search match so it doesn't read like a typed
    // search came up short.
    statusLine.textContent = `Showing ${filtered.length} of ${allLocations.length} stops (custom cities)`;
  } else {
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
