const TOKEN = window.DISK_RADAR_TOKEN;
const rowsEl = document.querySelector("#rows");
const crumbsEl = document.querySelector("#crumbs");
const statusEl = document.querySelector("#status");
const statusTextEl = document.querySelector("#status-text");
const totalEl = document.querySelector("#total");
const largeButton = document.querySelector("#large");
const trashButton = document.querySelector("#trash");
const minInput = document.querySelector("#min");
const queryInput = document.querySelector("#query");
const confirmDialog = document.querySelector("#confirm");
const confirmLead = document.querySelector("#confirm-lead");
const confirmList = document.querySelector("#confirm-list");

let home = null;
let current = null;
let parent = null;
let mode = "list";
let requestId = 0;
let controller = null;
let sortKey = "size";
let sortDir = "desc";
let entries = [];
const selected = new Map();
const listCache = new Map();

function headers() {
  return { "X-Disk-Radar-Token": TOKEN };
}

function formatDate(seconds) {
  if (seconds == null) return "—";
  return new Date(seconds * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSize(bytes) {
  if (bytes == null) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 || value >= 10 ? 0 : 1;
  return value.toFixed(digits) + " " + units[index];
}

let phraseTimer = null;

function stopBusy() {
  if (phraseTimer) clearInterval(phraseTimer);
  phraseTimer = null;
  statusEl.classList.remove("busy");
}

function setStatus(text) {
  stopBusy();
  statusTextEl.textContent = text;
}

function setBusy(messages) {
  stopBusy();
  statusEl.classList.add("busy");
  let index = 0;
  const tick = () => {
    statusTextEl.textContent = messages[index % messages.length];
    index += 1;
  };
  tick();
  phraseTimer = setInterval(tick, 1600);
}

function setBusyText(text) {
  if (phraseTimer) clearInterval(phraseTimer);
  phraseTimer = null;
  statusEl.classList.add("busy");
  statusTextEl.textContent = text;
}

function updateTrashButton() {
  trashButton.disabled = selected.size === 0;
  trashButton.textContent = selected.size ? "В Корзину (" + selected.size + ")" : "В Корзину";
}

function abortRequest() {
  if (controller) controller.abort();
  controller = new AbortController();
  return controller;
}

function renderCrumbs(path) {
  crumbsEl.replaceChildren();
  if (!home || !path) return;
  const parts = [{ label: "Дом", path: home }];
  if (path !== home && path.startsWith(home + "/")) {
    let built = home;
    path.slice(home.length + 1).split("/").filter(Boolean).forEach((part) => {
      built += "/" + part;
      parts.push({ label: part, path: built });
    });
  }
  parts.forEach((part, index) => {
    const current = index === parts.length - 1;
    const node = document.createElement(current ? "span" : "button");
    node.className = current ? "here" : "";
    node.textContent = part.label;
    node.style.paddingLeft = (12 + index * 18) + "px";
    if (!current) {
      node.type = "button";
      node.addEventListener("click", () => openList(part.path));
    }
    crumbsEl.append(node);
  });
}

const ICON = {
  folder: "M3 7h6l2 2h10v10H3z",
  file: "M7 3h7l6 6v12H7zM14 3v6h6",
  doc: "M7 3h7l6 6v12H7zM14 3v6h6M9 13h8M9 17h5",
  image: "M4 5h16v14H4zM8 10h.01M4 16l4-4 3 3 3-2 6 5",
  audio: "M9 18a3 3 0 1 1 0-6V6l10-2v8M17 14a3 3 0 1 1-2-2.8",
  video: "M4 7h11v10H4zM15 11l5-3v8l-5-3z",
  archive: "M4 7h16v12H4zM4 11h16M12 7v12",
  code: "M9 8L4 12l5 4M15 8l5 4-5 4",
  disk: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
};

const EXT_KIND = {};
[
  ["doc", "pdf doc docx rtf txt md csv xls xlsx ppt pptx pages numbers key odt ods odp"],
  ["image", "jpg jpeg png gif webp heic heif svg bmp tif tiff ico raw cr2 nef"],
  ["audio", "mp3 wav aac flac m4a ogg aiff aif wma"],
  ["video", "mp4 mov mkv avi webm m4v mpg mpeg wmv"],
  ["archive", "zip rar 7z tar gz tgz bz2 xz iso"],
  ["code", "js mjs ts tsx jsx py rb go rs java c cpp h hpp css scss html json xml yml yaml sh bash sql php swift kt vue"],
  ["disk", "dmg qcow2 qcow vmdk vdi img"],
].forEach(([kind, list]) => {
  list.split(" ").forEach((ext) => {
    EXT_KIND[ext] = kind;
  });
});

function fileKind(entry) {
  if (entry.dir) return "folder";
  const base = String(entry.name || "").split("/").pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "file";
  return EXT_KIND[base.slice(dot + 1).toLowerCase()] || "file";
}

function typeIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("type-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON[kind] || ICON.file);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.7");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}

function buildRow(entry) {
  const tr = document.createElement("tr");
  tr.dataset.size = String(entry.size || 0);
  const check = document.createElement("td");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = selected.has(entry.path);
  input.setAttribute("aria-label", entry.name);
  input.addEventListener("change", () => {
    if (input.checked) selected.set(entry.path, entry);
    else selected.delete(entry.path);
    updateTrashButton();
  });
  check.append(input);

  const name = document.createElement("td");
  const label = document.createElement(entry.dir ? "button" : "span");
  label.className = "name";
  label.textContent = displayName(entry);
  label.title = entry.path;
  if (entry.dir) {
    label.type = "button";
    label.addEventListener("click", () => openList(entry.path));
  }
  const line = document.createElement("div");
  line.className = "name-line";
  line.append(typeIcon(fileKind(entry)), label);
  name.append(line);

  const when = document.createElement("td");
  when.className = "when";
  when.textContent = formatDate(entry.modified);

  const size = document.createElement("td");
  size.className = "size";
  if (entry.pending && entry.size == null) {
    size.textContent = "…";
    size.classList.add("muted");
  } else if (!entry.accessible) {
    size.textContent = "нет доступа";
    size.classList.add("muted");
  } else {
    size.textContent = formatSize(entry.size);
  }

  tr.append(check, name, when, size);
  return tr;
}

function showEntries(visible) {
  const fragment = document.createDocumentFragment();
  if (!visible.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "empty";
    if (entries.length && queryInput.value.trim()) td.textContent = "Ничего не найдено";
    else td.textContent = mode === "large" ? "Файлов крупнее порога нет" : "Папка пуста";
    tr.append(td);
    fragment.append(tr);
  } else {
    visible.forEach((entry) => fragment.append(buildRow(entry)));
  }
  rowsEl.replaceChildren(fragment);
}

function displayName(entry) {
  if (mode === "large" && current && entry.path.startsWith(current + "/")) {
    return entry.path.slice(current.length + 1);
  }
  return entry.name;
}

function matchesQuery(entry) {
  const query = queryInput.value.trim().toLowerCase();
  if (!query) return true;
  return displayName(entry).toLowerCase().includes(query);
}

function sortEntries(list) {
  const direction = sortDir === "asc" ? 1 : -1;
  return list.slice().sort((a, b) => {
    const byName = displayName(a).localeCompare(displayName(b), "ru", { sensitivity: "base" });
    if (sortKey === "name") return byName * direction;
    const left = sortKey === "modified" ? a.modified : a.size;
    const right = sortKey === "modified" ? b.modified : b.size;
    if (left == null && right == null) return byName;
    if (left == null) return 1;
    if (right == null) return -1;
    return (left - right) * direction || byName;
  });
}

function renderRows() {
  showEntries(sortEntries(entries.filter(matchesQuery)));
}

function markSort() {
  document.querySelectorAll("th .sort").forEach((button) => {
    const active = button.dataset.sort === sortKey;
    button.classList.toggle("active", active);
    const label = button.dataset.sort === "name" ? "Имя" : button.dataset.sort === "modified" ? "Изменён" : "На диске";
    button.textContent = label + (active ? (sortDir === "asc" ? " ↑" : " ↓") : "");
    button.closest("th").setAttribute("aria-sort", active ? (sortDir === "asc" ? "ascending" : "descending") : "none");
  });
}

function chooseSort(key) {
  if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
  else {
    sortKey = key;
    sortDir = key === "name" ? "asc" : "desc";
  }
  markSort();
  renderRows();
}

function knownTotal(entries) {
  return entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
}

async function readEvents(response, id, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const take = (line) => {
    if (!line || id !== requestId) return;
    onEvent(JSON.parse(line));
  };
  while (true) {
    const chunk = await reader.read();
    if (id !== requestId) break;
    if (!chunk.done) buffer += decoder.decode(chunk.value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      take(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (chunk.done) {
      take(buffer.trim());
      break;
    }
  }
}

function snapshotList(path, total) {
  listCache.set(path, {
    home,
    parent,
    total,
    entries: entries.map((entry) => ({ ...entry })),
  });
}

function showCachedList(path) {
  const cached = listCache.get(path);
  if (!cached) return false;
  home = cached.home;
  current = path;
  parent = cached.parent;
  entries = cached.entries.map((entry) => ({ ...entry }));
  renderCrumbs(path);
  totalEl.textContent = "Всего " + formatSize(cached.total);
  renderRows();
  setStatus("");
  return true;
}

function invalidateAfterTrash(paths) {
  const stale = new Set();
  paths.forEach((path) => {
    if (!path) return;
    stale.add(path);
    let cursor = path;
    while (cursor && cursor !== home) {
      const slash = cursor.lastIndexOf("/");
      if (slash <= 0) break;
      cursor = cursor.slice(0, slash);
      stale.add(cursor);
      if (cursor === home) break;
    }
  });
  for (const key of listCache.keys()) {
    if (stale.has(key) || paths.some((path) => key.startsWith(path + "/"))) listCache.delete(key);
  }
}

async function openList(path, options = {}) {
  const id = ++requestId;
  mode = "list";
  setLargeActive(false);
  const signal = abortRequest().signal;
  selected.clear();
  updateTrashButton();
  if (!options.fresh && path && showCachedList(path)) return;
  if (path && home) renderCrumbs(path);
  setBusy(["Считаю…", "Смотрю папки…", "Собираю размеры…"]);
  entries = [];
  rowsEl.replaceChildren();
  const url = path ? "/api/list?path=" + encodeURIComponent(path) : "/api/list";
  let response;
  try {
    response = await fetch(url, { headers: headers(), signal });
  } catch (error) {
    if (error.name !== "AbortError" && id === requestId) setStatus("Не удалось посчитать папку");
    return;
  }
  if (!response.ok) {
    const data = await response.json();
    if (id === requestId) setStatus(data.error || "Нет доступа");
    return;
  }
  await readEvents(response, id, (item) => {
    if (item.kind === "start") {
      home = item.home;
      current = item.path;
      parent = item.parent;
      renderCrumbs(current);
      return;
    }
    if (item.kind === "entry") {
      entries.push(item);
      renderRows();
      totalEl.textContent = "Всего " + formatSize(knownTotal(entries));
      setBusyText("Показано " + entries.length);
      return;
    }
    if (item.kind === "size") {
      const entry = entries.find((candidate) => candidate.path === item.path);
      if (entry) {
        entry.size = item.size;
        entry.pending = false;
        entry.accessible = item.accessible;
        renderRows();
        totalEl.textContent = "Всего " + formatSize(knownTotal(entries));
      }
      return;
    }
    if (item.done && !item.cancelled) {
      const total = item.total != null ? item.total : knownTotal(entries);
      if (item.total != null) totalEl.textContent = "Всего " + formatSize(item.total);
      renderRows();
      if (current) snapshotList(current, total);
      setStatus("");
    }
  });
}

function thresholdGigabytes() {
  return Math.max(1, Number(minInput.value) || 1);
}

function updateLargeHint() {
  const gigabytes = thresholdGigabytes();
  largeButton.title = "Файлы от " + gigabytes + " ГБ и больше по занятому месту на диске";
}

function setLargeActive(active) {
  largeButton.setAttribute("aria-checked", active ? "true" : "false");
}

function thresholdBytes() {
  const gigabytes = thresholdGigabytes();
  minInput.value = String(gigabytes);
  updateLargeHint();
  return gigabytes * 1024 * 1024 * 1024;
}

async function openLarge() {
  if (!current) return;
  const id = ++requestId;
  mode = "large";
  setLargeActive(true);
  const signal = abortRequest().signal;
  selected.clear();
  updateTrashButton();
  const gigabytes = Math.max(1, Number(minInput.value) || 1);
  const minBytes = thresholdBytes();
  setBusy(["Ищу файлы от " + gigabytes + " ГБ…", "Проверяю размеры…", "Собираю список…"]);
  totalEl.textContent = "Крупные файлы";
  entries = [];
  rowsEl.replaceChildren();
  const url = "/api/large-files?path=" + encodeURIComponent(current) + "&min_bytes=" + minBytes;
  let response;
  try {
    response = await fetch(url, { headers: headers(), signal });
  } catch (error) {
    if (error.name !== "AbortError" && id === requestId) setStatus("Поиск прерван");
    return;
  }
  if (!response.ok) {
    const data = await response.json();
    if (id === requestId) setStatus(data.error || "Не удалось искать");
    return;
  }
  await readEvents(response, id, (item) => {
    if (item.done) {
      renderRows();
      setStatus(entries.length ? "Найдено " + entries.length : "Файлов крупнее порога нет");
      return;
    }
    entries.push(item);
    renderRows();
    setBusyText("Найдено " + entries.length);
  });
}

async function trashSelected() {
  const chosen = [...selected.values()];
  if (!chosen.length) return;
  confirmLead.textContent = chosen.length === 1
    ? "Объект можно будет вернуть из Корзины."
    : "Объекты можно будет вернуть из Корзины.";
  confirmList.replaceChildren();
  chosen.forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = entry.path + " — " + (entry.accessible ? formatSize(entry.size) : "нет доступа");
    confirmList.append(li);
  });
  confirmDialog.showModal();
  const choice = await new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue), { once: true });
  });
  if (choice !== "ok") return;
  trashButton.disabled = true;
  setStatus("Убираю в Корзину…");
  const response = await fetch("/api/trash", {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ paths: chosen.map((entry) => entry.path) }),
  });
  const data = await response.json();
  const failed = data.failed || [];
  if (failed.length) setStatus(failed[0].error);
  else setStatus("В Корзине: " + (data.ok || []).length);
  if ((data.ok || []).length) invalidateAfterTrash(data.ok.map((item) => item.path));
  if (mode === "list") {
    await openList(current, { fresh: true });
    if (!failed.length) setStatus("В Корзине: " + (data.ok || []).length);
  } else {
    const removed = new Set((data.ok || []).map((item) => item.path));
    entries = entries.filter((entry) => !removed.has(entry.path));
    removed.forEach((path) => selected.delete(path));
    updateTrashButton();
    renderRows();
  }
}

updateLargeHint();
minInput.addEventListener("input", updateLargeHint);
largeButton.addEventListener("click", () => {
  if (largeButton.getAttribute("aria-checked") === "true") openList(current);
  else openLarge();
});
let thresholdTimer = null;
minInput.addEventListener("input", () => {
  clearTimeout(thresholdTimer);
  thresholdTimer = setTimeout(() => openLarge(), 400);
});
minInput.addEventListener("change", () => {
  clearTimeout(thresholdTimer);
  openLarge();
});
trashButton.addEventListener("click", () => trashSelected());
queryInput.addEventListener("input", () => renderRows());
document.querySelectorAll("th .sort").forEach((button) => {
  button.addEventListener("click", () => chooseSort(button.dataset.sort));
});
markSort();

openList(null);
