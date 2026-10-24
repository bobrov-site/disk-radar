const TOKEN = window.DISK_RADAR_TOKEN;
const rowsEl = document.querySelector("#rows");
const crumbsEl = document.querySelector("#crumbs");
const statusEl = document.querySelector("#status");
const totalEl = document.querySelector("#total");
const upButton = document.querySelector("#up");
const largeButton = document.querySelector("#large");
const trashButton = document.querySelector("#trash");
const minInput = document.querySelector("#min");
const confirmDialog = document.querySelector("#confirm");
const confirmLead = document.querySelector("#confirm-lead");
const confirmList = document.querySelector("#confirm-list");

let home = null;
let current = null;
let parent = null;
let mode = "list";
let requestId = 0;
let controller = null;
const selected = new Map();

function headers() {
  return { "X-Disk-Radar-Token": TOKEN };
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

function setStatus(text) {
  statusEl.textContent = text;
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
  if (path !== home) {
    const relative = path.slice(home.length).split("/").filter(Boolean);
    let built = home;
    for (const part of relative) {
      built += "/" + part;
      parts.push({ label: part, path: built });
    }
  }
  parts.forEach((part, index) => {
    if (index) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      crumbsEl.append(sep);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = part.label;
    button.addEventListener("click", () => openList(part.path));
    crumbsEl.append(button);
  });
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
  label.textContent = entry.name;
  label.title = entry.path;
  if (entry.dir) {
    label.type = "button";
    label.addEventListener("click", () => openList(entry.path));
  }
  name.append(label);

  const size = document.createElement("td");
  size.className = "size";
  if (!entry.accessible) {
    size.textContent = "нет доступа";
    size.classList.add("muted");
  } else {
    size.textContent = formatSize(entry.size);
  }

  tr.append(check, name, size);
  return tr;
}

function showEntries(entries) {
  const fragment = document.createDocumentFragment();
  if (!entries.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty";
    td.textContent = mode === "large" ? "Файлов крупнее порога нет" : "Папка пуста";
    tr.append(td);
    fragment.append(tr);
  } else {
    entries.forEach((entry) => fragment.append(buildRow(entry)));
  }
  rowsEl.replaceChildren(fragment);
}

function insertLarge(entry) {
  const empty = rowsEl.querySelector(".empty");
  if (empty) empty.closest("tr").remove();
  const row = buildRow(entry);
  const size = entry.size || 0;
  const next = [...rowsEl.children].find((item) => Number(item.dataset.size) < size);
  rowsEl.insertBefore(row, next || null);
}

async function openList(path) {
  const id = ++requestId;
  mode = "list";
  const signal = abortRequest().signal;
  selected.clear();
  updateTrashButton();
  setStatus("Считаю…");
  const url = path ? "/api/list?path=" + encodeURIComponent(path) : "/api/list";
  let response;
  try {
    response = await fetch(url, { headers: headers(), signal });
  } catch (error) {
    if (error.name !== "AbortError" && id === requestId) setStatus("Не удалось посчитать папку");
    return;
  }
  const data = await response.json();
  if (id !== requestId) return;
  if (!response.ok) {
    setStatus(data.error || "Нет доступа");
    return;
  }
  if (data.cancelled) return;
  home = data.home;
  current = data.path;
  parent = data.parent;
  upButton.disabled = !parent;
  renderCrumbs(current);
  showEntries(data.entries);
  totalEl.textContent = data.total == null ? "" : "Всего " + formatSize(data.total);
  setStatus("");
}

async function openLarge() {
  if (!current) return;
  const id = ++requestId;
  mode = "large";
  const signal = abortRequest().signal;
  selected.clear();
  updateTrashButton();
  const minMb = Math.max(1, Number(minInput.value) || 300);
  minInput.value = String(minMb);
  setStatus("Ищу файлы крупнее " + minMb + " МБ…");
  totalEl.textContent = "Крупные файлы";
  showEntries([]);
  rowsEl.replaceChildren();
  const url = "/api/large-files?path=" + encodeURIComponent(current) + "&min_bytes=" + (minMb * 1024 * 1024);
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
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let count = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done || id !== requestId) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const item = JSON.parse(line);
        if (item.done) {
          if (id === requestId) setStatus(count ? "Найдено " + count : "");
        } else if (id === requestId) {
          insertLarge(item);
          count += 1;
          setStatus("Найдено " + count);
        }
      }
      newline = buffer.indexOf("\n");
    }
  }
}

async function trashSelected() {
  const entries = [...selected.values()];
  if (!entries.length) return;
  confirmLead.textContent = entries.length === 1
    ? "Объект можно будет вернуть из Корзины."
    : "Объекты можно будет вернуть из Корзины.";
  confirmList.replaceChildren();
  entries.forEach((entry) => {
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
    body: JSON.stringify({ paths: entries.map((entry) => entry.path) }),
  });
  const data = await response.json();
  const failed = data.failed || [];
  if (failed.length) setStatus(failed[0].error);
  else setStatus("В Корзине: " + (data.ok || []).length);
  if (mode === "list") {
    await openList(current);
    if (!failed.length) setStatus("В Корзине: " + (data.ok || []).length);
  } else {
    failed.concat(data.ok || []).forEach((item) => {
      if ((data.ok || []).some((ok) => ok.path === item.path)) {
        const row = [...rowsEl.children].find((candidate) => candidate.querySelector(".name")?.title === item.path);
        if (row) row.remove();
        selected.delete(item.path);
      }
    });
    updateTrashButton();
  }
}

upButton.addEventListener("click", () => {
  if (parent) openList(parent);
});
largeButton.addEventListener("click", () => openLarge());
trashButton.addEventListener("click", () => trashSelected());

openList(null);
