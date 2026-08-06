const DATA_URL = "data.json";

const resultsEl = document.getElementById("results");
const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");
const statusLine = document.getElementById("statusLine");
const stopCount = document.getElementById("stopCount");
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

let allLocations = [];

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
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !videoModal.hidden) closeVideo();
});

function render(list) {
  resultsEl.innerHTML = "";

  if (list.length === 0) {
    if (allLocations.length === 0) {
      emptyTitle.textContent = "No current locations listed.";
      emptySub.textContent = "The directory is being updated, check back soon.";
    } else {
      emptyTitle.textContent = "No match on the board.";
      emptySub.textContent = "Try the street name or just the city.";
    }
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  const frag = document.createDocumentFragment();
  list.forEach(loc => {
    const li = document.createElement("li");
    li.className = "ticket";

    li.innerHTML = `
      ${loc.accountNumber ? `<span class="ticket-account">#${escapeHtml(loc.accountNumber)}</span>` : `<span class="ticket-account ticket-account-empty"></span>`}
      <span class="ticket-name">${escapeHtml(loc.name)}</span>
      ${loc.videoUrl ? `<button type="button" class="ticket-watch" data-id="${escapeAttr(loc.id)}">&#9654; Watch</button>` : ""}
    `;

    if (loc.videoUrl) {
      li.querySelector(".ticket-watch").addEventListener("click", () => openVideo(loc));
    }

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

function filterLocations(query) {
  const q = query.trim().toLowerCase();
  if (!q) return allLocations;
  return allLocations.filter(loc => {
    const haystack = [loc.name, loc.address, loc.city, loc.state, loc.zip, loc.accountNumber]
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(q);
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

function applySearch() {
  const filtered = filterLocations(searchInput.value);
  const sorted = sortLocations(filtered, sortSelect.value);
  render(sorted);
  statusLine.textContent = filtered.length === allLocations.length
    ? `Showing all ${allLocations.length} stops`
    : `${filtered.length} of ${allLocations.length} stops match`;
}

async function loadData({ forceNetwork = false } = {}) {
  stopCount.textContent = "loading stops\u2026";
  try {
    const url = forceNetwork ? `${DATA_URL}?t=${Date.now()}` : DATA_URL;
    const res = await fetch(url, { cache: forceNetwork ? "no-store" : "default" });
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    allLocations = data.locations || [];
    stopCount.textContent = `${allLocations.length} stops on file`;
    updatedLine.textContent = data.updated ? `Data updated ${data.updated}` : "";
    applySearch();
  } catch (err) {
    stopCount.textContent = "couldn't load stops";
    statusLine.textContent = "Check your connection and try refresh.";
  }
}

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
