/** On-demand storage diagnostics. Never infer the Docker host's bind paths. */
import { request } from "./api.js";
import * as ui from "./ui.js";
import * as auth from "./auth.js";
import { state } from "./store.js";

let nodes = null;
let status = {};
let snapshot = null;
let attempted = false;
let pending = null;
let clearPending = null;
let clearDialog = null;
let clearGeneration = 0;
let lastClearResult = null;
let accessBlocked = false;
let generation = 0;
let refreshController = null;
let accessGeneration = 0;
const SCOPES = { thumbnails: "AVIF 缩略图", originals: "封面原图", all: "全部图片缓存" };
const focusable = node => node?.isConnected && node.getClientRects().length && !node.closest("[inert]") && !node.matches(":disabled");
function usable() {
  const session = auth.current();
  return !accessBlocked && state.tab === "settings" && (!session.required || session.authenticated) && !document.querySelector(".app-content")?.inert;
}

export function init(statusKv, reload) {
  if (nodes) return;
  const card = statusKv.closest(".card");
  card.classList.add("storage-panel");
  const heading = card.querySelector(".card-head h2");
  if (heading) heading.textContent = "存储与运行状态";
  reload.textContent = "刷新用量";
  reload.title = "读取目录与缓存用量，不会写入文件";
  const cards = ui.el("div", { id: "storage-cards", class: "storage-grid" });
  const breakdown = ui.el("div", { class: "storage-breakdown" });
  const checked = ui.el("span", { id: "storage-checked-at", class: "hint" });
  const feedback = ui.el("div", { id: "storage-feedback", class: "storage-feedback", role: "status", "aria-live": "polite" });
  const clearResult = ui.el("div", { id: "storage-clear-result", class: "storage-clear-result", role: "status", "aria-live": "polite" });
  const check = ui.el("button", {
    id: "storage-check-write", type: "button", class: "btn btn-primary", text: "检查缓存写入",
    onClick: () => refresh({ checkWrite: true }),
  });
  const copy = ui.el("button", {
    id: "storage-copy-report", type: "button", class: "btn", text: "复制诊断信息", disabled: true,
    onClick: copyReport,
  });
  const clear = ui.el("button", {
    id: "storage-clear-cache", type: "button", class: "btn btn-primary", text: "清理缓存",
    onClick: () => openClearDialog(),
  });
  const locationNote = ui.el("p", { id: "storage-host-note", class: "hint storage-host-note" });
  const details = ui.el("details", { class: "storage-service-details" }, [
    ui.el("summary", { text: "服务详情" }), statusKv,
  ]);
  const body = card.querySelector(".card-body");
  body.replaceChildren(
    ui.el("p", { class: "storage-intro", text: "音乐留在曲库，图片按需缓存，设置保存在数据库。" }),
    cards, breakdown,
    ui.el("div", { class: "storage-actions" }, [
      ui.el("div", { class: "storage-action-buttons" }, [check, copy, clear]), checked,
    ]),
    ui.el("p", { class: "hint storage-probe-note", text: "写入检查会创建缺少的缓存目录，并创建后立即删除一个临时文件；不会修改音乐或目录权限。" }),
    feedback, clearResult, locationNote, details,
  );
  nodes = { cards, breakdown, feedback, clearResult, check, copy, clear, reload, checked, statusKv, locationNote };
  reload.addEventListener("click", () => refresh());
  render();
}

export function onStatus(value) {
  status = value || {};
  if (!nodes) return;
  const rows = [
    ["后端版本", status.version || "等待连接"],
    ["索引引擎", status.postgres ? "PostgreSQL" : "等待连接"],
    ["任务进度", status.redis ? "Redis 已连接" : "保存在 PostgreSQL"],
    ["支持音频", (status.supported_formats || []).join(" · ") || "—"],
    ["元数据源", status.scraper?.available ? `${status.scraper.count} 个可用` : "等待连接"],
    ["整理目录边界", status.library_root || status.music_dir || "—"],
  ];
  nodes.statusKv.replaceChildren(...rows.flatMap(([label, value]) => [ui.el("dt", { text: label }), ui.el("dd", { text: value })]));
  if (!snapshot) render();
}

export function ensureLoaded() {
  return usable() ? attempted ? pending || clearPending || Promise.resolve() : refresh() : Promise.resolve();
}

export function refresh({ checkWrite = false } = {}) {
  if (!nodes || !usable()) return Promise.resolve();
  if (pending || clearPending) return pending || clearPending;
  attempted = true;
  const token = ++generation;
  refreshController = new AbortController();
  const controller = refreshController;
  setBusy(true, checkWrite);
  nodes.feedback.replaceChildren(ui.loadingLine(checkWrite ? "正在以应用用户检查缓存写入…" : "正在读取缓存用量…"));
  pending = (async () => {
    try {
      const data = await request(checkWrite ? "/api/storage/check" : "/api/storage", {
        method: checkWrite ? "POST" : "GET", timeout: 45000, signal: controller.signal,
      });
      if (token !== generation || !usable()) return;
      snapshot = data;
      render();
      renderWriteChecks();
      renderClearResult();
    } catch (error) {
      if (token !== generation || !usable()) return;
      const notice = ui.notice("err", `暂时无法读取存储诊断：${error.message}。可点击「刷新用量」重试。`);
      if (lastClearResult) {
        nodes.feedback.replaceChildren(notice);
        renderClearResult();
      } else nodes.feedback.replaceChildren(notice);
    } finally {
      if (token === generation) { pending = null; refreshController = null; setBusy(false); }
    }
  })();
  return pending;
}

function setBusy(busy, checking = false) {
  if (!nodes) return;
  const locked = busy || Boolean(clearPending) || accessBlocked;
  nodes.reload.disabled = locked;
  nodes.check.disabled = locked;
  nodes.clear.disabled = locked;
  nodes.copy.disabled = locked || !snapshot;
  nodes.check.textContent = busy && checking ? "正在检查…" : "检查缓存写入";
  nodes.clear.textContent = clearPending ? "正在清理…" : "清理缓存";
  nodes.cards.setAttribute("aria-busy", String(locked));
}

export function leave() {
  generation += 1;
  refreshController?.abort(); refreshController = null; pending = null; attempted = false;
  clearDialog?.({ restoreFocus: false });
  setBusy(false);
}

function scopeEstimate(scope) {
  const buckets = (scope === "all" ? ["thumbnails", "originals"] : [scope]).map(key => snapshot?.cache?.[key]);
  if (!snapshot || buckets.some(item => !item || item.error)) return "用量未能完整统计";
  return `${buckets.some(item => item.truncated) ? "至少 " : "约 "}${ui.fmtNum(buckets.reduce((sum, item) => sum + number(item.files), 0))} 份 · ${ui.fmtBytes(buckets.reduce((sum, item) => sum + number(item.bytes), 0))}`;
}

function validClearResult(result, scope) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  return result && typeof result === "object" && result.scope === scope && typeof result.complete === "boolean"
    && ["removed_files", "removed_images", "removed_metadata", "removed_bytes", "skipped_entries", "failed_entries"].every(key => count(result[key]))
    && typeof result.finished_at === "number" && Number.isFinite(result.finished_at) && result.finished_at > 0
    && typeof result.truncated === "boolean" && Array.isArray(result.errors) && result.errors.length <= 20
    && result.removed_files === result.removed_images + result.removed_metadata
    && result.complete === (result.failed_entries === 0 && !result.truncated && result.errors.length === 0)
    && result.errors.every(item => item && typeof item.path === "string" && typeof item.message === "string");
}

function clearSummary(result) {
  const unknown = result.uncertain;
  const heading = unknown ? "清理结果暂未确认" : result.complete ? "缓存清理完成" : "缓存部分清理完成";
  const copy = unknown ? result.message : result.complete && result.removed_files === 0
    ? "缓存目录中没有可删除的缓存文件。"
    : `已删除 ${ui.fmtNum(result.removed_files)} 个文件，释放 ${ui.fmtBytes(result.removed_bytes)}。跳过 ${ui.fmtNum(result.skipped_entries)} 项，失败 ${ui.fmtNum(result.failed_entries)} 项。`;
  return ui.el("section", { class: `storage-clear-summary ${unknown || !result.complete ? "has-errors" : "is-ok"}` }, [
    ui.el("strong", { text: heading }), ui.el("p", { text: copy }),
    unknown ? ui.el("p", { class: "hint", text: "服务器可能已清理部分缓存。请刷新用量核对；不会自动再次清理。" })
      : ui.el("p", { class: "hint", text: `图片 ${ui.fmtNum(result.removed_images)} 份 · 配套校验文件 ${ui.fmtNum(result.removed_metadata)} 份` }),
    result.truncated ? ui.el("p", { class: "hint", text: "本次处理或错误信息未能完整返回，可刷新用量检查剩余缓存。" }) : null,
    result.refresh_error ? ui.el("p", { class: "hint", text: `清理结果已保留，但最新用量读取失败：${result.refresh_error}。可刷新用量重试。` }) : null,
    result.errors?.length ? ui.el("details", { class: "storage-clear-errors" }, [ui.el("summary", { text: `查看 ${ui.fmtNum(result.errors.length)} 条错误` }),
      ui.el("ul", {}, result.errors.map(item => ui.el("li", {}, [ui.el("code", { text: item.path }), ui.el("span", { text: item.message })])))]) : null,
  ]);
}

function renderClearResult() {
  if (!nodes) return;
  nodes.clearResult.replaceChildren(...(lastClearResult ? [clearSummary(lastClearResult)] : []));
}

function openClearDialog() {
  if (!nodes || !usable() || pending || clearPending || clearDialog || document.querySelector("dialog[open]")) return;
  const opener = document.activeElement;
  const token = ++clearGeneration;
  let closed = false, sent = false, finished = false;
  let selected = "thumbnails";
  const dialog = ui.el("dialog", { id: "storage-clear-dialog", class: "storage-clear-dialog", "aria-labelledby": "storage-clear-title", "aria-describedby": "storage-clear-description" });
  const title = ui.el("h2", { id: "storage-clear-title", text: "清理图片缓存", tabindex: "-1" });
  const closeButton = ui.el("button", { id: "storage-clear-close", type: "button", class: "btn btn-sm btn-ghost", "aria-label": "关闭缓存清理", text: "关闭", onClick: () => close() });
  const description = ui.el("p", { id: "storage-clear-description", class: "storage-clear-description", text: "音乐文件、曲库索引、设置、任务记录和歌手头像会保留。清理的图片会在下次浏览时重建，云盘音乐可能需要重新读取。" });
  const estimate = ui.el("p", { id: "storage-clear-estimate", class: "storage-clear-estimate", text: `${scopeEstimate(selected)}（统计仅供参考）` });
  const progress = ui.el("div", { id: "storage-clear-status", class: "storage-clear-status", role: "status", "aria-live": "polite" });
  const choiceInputs = [];
  const choices = ui.el("fieldset", { id: "storage-clear-scopes", class: "storage-clear-scopes" }, [ui.el("legend", { text: "清理范围" })]);
  for (const [value, label] of Object.entries(SCOPES)) {
    const radio = ui.el("input", { type: "radio", name: "cache-scope", value, checked: value === selected });
    const option = ui.el("label", { class: "storage-clear-option", dataset: { selected: String(value === selected) } }, [radio,
      ui.el("span", {}, [ui.el("strong", { text: label }), ui.el("span", { text: value === "thumbnails" ? "128 / 256 / 512px 图片" : value === "originals" ? "已缓存的封面原始图片" : "缩略图、封面原图及配套校验文件" })])]);
    radio.addEventListener("change", () => {
      if (closed || sent || !radio.checked) return;
      selected = value;
      for (const input of choiceInputs) input.closest("label").dataset.selected = String(input.checked);
      estimate.textContent = `${scopeEstimate(selected)}（统计仅供参考）`;
    });
    choiceInputs.push(radio); choices.append(option);
  }
  const cancel = ui.el("button", { id: "storage-clear-cancel", type: "button", class: "btn", text: "取消", onClick: () => close() });
  const confirm = ui.el("button", { id: "storage-clear-confirm", type: "button", class: "btn btn-primary", text: "确认清理", onClick: () => void performClear() });
  dialog.append(ui.el("header", { class: "storage-clear-head" }, [ui.el("div", {}, [ui.el("p", { class: "eyebrow", text: "CACHE MAINTENANCE" }), title]), closeButton]),
    ui.el("div", { class: "storage-clear-body" }, [description, choices, estimate, progress]), ui.el("footer", { class: "storage-clear-actions" }, [cancel, confirm]));

  function current() { return !closed && token === clearGeneration && dialog.open && dialog.isConnected && usable(); }
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    if (clearDialog === close) clearDialog = null;
    if (dialog.open) dialog.close(); dialog.remove();
    if (sent && !finished && clearPending && !accessBlocked) {
      lastClearResult = { uncertain: true, message: "已关闭清理窗口；请求可能仍在服务端处理中。" };
      attempted = false;
      renderClearResult();
    }
    if (restoreFocus && usable()) [opener, nodes?.clear, nodes?.reload].find(focusable)?.focus({ preventScroll: true });
  }
  async function performClear() {
    if (!current() || sent || clearPending || pending) return;
    const scope = selected, lifetime = generation, access = accessGeneration;
    sent = true; dialog.dataset.phase = "clearing";
    confirm.disabled = true; confirm.textContent = "正在清理…"; cancel.textContent = "关闭窗口";
    for (const input of choiceInputs) input.disabled = true;
    progress.replaceChildren(ui.loadingLine(`正在清理${SCOPES[scope]}…`));
    if (!current() || lifetime !== generation || access !== accessGeneration) return;
    const operation = request("/api/storage/clear-cache", { method: "POST", body: { scope }, timeout: 60000 });
    clearPending = operation; setBusy(false);
    try {
      const result = await operation;
      if (!validClearResult(result, scope)) throw new Error("返回的清理范围或数量不完整");
      if (!current() || lifetime !== generation) return;
      finished = true;
      lastClearResult = result; renderClearResult();
      progress.replaceChildren(clearSummary(result));
      dialog.dataset.phase = result.complete ? "done" : "partial";
      confirm.hidden = true; cancel.textContent = "完成";
      const data = await request("/api/storage", { timeout: 45000 });
      if (!current() || lifetime !== generation) return;
      snapshot = data; attempted = true; render(); renderWriteChecks();
    } catch (error) {
      if (!current() || lifetime !== generation) return;
      if (lastClearResult && !lastClearResult.uncertain && dialog.dataset.phase !== "clearing") {
        lastClearResult = { ...lastClearResult, refresh_error: error.message }; renderClearResult();
        progress.replaceChildren(clearSummary(lastClearResult));
      } else {
        lastClearResult = { uncertain: true, message: `无法确认清理结果：${error.message}` }; renderClearResult();
        progress.replaceChildren(clearSummary(lastClearResult)); dialog.dataset.phase = "unknown";
        confirm.hidden = true; cancel.textContent = "关闭";
      }
      attempted = false;
    } finally {
      if (clearPending === operation) clearPending = null;
      setBusy(Boolean(pending));
      if (current() && (document.activeElement === document.body || !focusable(document.activeElement))) cancel.focus({ preventScroll: true });
    }
  }
  clearDialog = close; dialog.dataset.phase = "choosing";
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => close());
  document.body.append(dialog); dialog.showModal(); choiceInputs[0].focus({ preventScroll: true });
}

for (const event of ["metatidy:unauthorized", "metatidy:logout"]) window.addEventListener(event, () => {
  accessGeneration += 1; accessBlocked = true; leave(); snapshot = null; lastClearResult = null; status = {};
  if (nodes) { renderClearResult(); nodes.feedback.replaceChildren(); render(); }
});
window.addEventListener("metatidy:authenticated", () => {
  accessBlocked = false;
  attempted = false;
  setBusy(Boolean(pending || clearPending));
});

function pill(text, tone = "neutral") {
  return ui.el("span", { class: `storage-pill storage-pill-${tone}`, text });
}

function pathLine(path, label) {
  return ui.el("div", { class: "storage-path" }, [
    ui.el("span", { class: "storage-path-label", text: label }),
    ui.el("code", { text: path || "等待连接", title: path || "" }),
  ]);
}

function tile({ icon, title, badge, children, tone = "" }) {
  return ui.el("section", { class: `storage-card ${tone}`.trim() }, [
    ui.el("div", { class: "storage-card-head" }, [
      ui.el("span", { class: "storage-icon", "aria-hidden": "true" }, [ui.icon(icon, { size: 20 })]), badge,
    ]),
    ui.el("h3", { text: title }), ...children,
  ]);
}

function number(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

function render() {
  const music = snapshot?.music || { path: status.music_dir, exists: status.music_dir_exists };
  const cache = snapshot?.cache || { root: status.data_dir };
  const database = snapshot?.database || { connected: status.postgres, engine: "PostgreSQL" };
  const container = snapshot?.runtime?.container ?? status.docker;
  const pathLabel = container ? "容器内路径" : "服务所在机器路径";
  const thumbnails = cache.thumbnails;
  const originals = cache.originals;
  const cacheError = Boolean(thumbnails?.error || originals?.error);
  const partial = Boolean(thumbnails?.truncated || originals?.truncated || cacheError);
  const totalBytes = number(thumbnails?.bytes) + number(originals?.bytes);
  nodes.cards.replaceChildren(
    tile({ icon: "music", title: "音乐文件", badge: pill(music.exists === true ? "已找到目录" : music.exists === false ? "目录不可用" : "等待连接", music.exists === true ? "ok" : music.exists === false ? "warn" : "neutral"), children: [
      pathLine(music.path, pathLabel),
      ui.el("p", { class: "storage-card-copy", text: "音频与内嵌封面保存在音乐文件中，扫描后仍留在原目录。" }),
    ] }),
    tile({ icon: "cover", title: "图片缓存", tone: "storage-card-featured", badge: pill("AVIF · 按需生成", "accent"), children: [
      ui.el("div", { class: "storage-metric" }, [
        ui.el("strong", { text: snapshot ? cacheError && !totalBytes ? "读取受限" : `${partial ? "至少 " : ""}${ui.fmtBytes(totalBytes)}` : "—" }),
        ui.el("span", { text: snapshot ? thumbnails?.error ? "缩略图数量暂不可用" : `${partial ? "已统计 " : ""}${ui.fmtNum(number(thumbnails?.files))} 张缩略图` : "打开设置后读取用量" }),
      ]),
      pathLine(cache.root, pathLabel),
      ui.el("p", { class: "storage-card-copy", text: cacheError ? "部分缓存目录未能读取，请查看下方详情。" : "浏览有封面的曲目时才生成缓存。目录为空，也可能只是尚未请求过图片。" }),
    ] }),
    tile({ icon: "disk", title: "索引与设置", badge: pill(database.connected === true ? "已连接" : database.connected === false ? "连接异常" : "等待连接", database.connected === true ? "ok" : database.connected === false ? "warn" : "neutral"), children: [
      ui.el("div", { class: "storage-database-name", text: "PostgreSQL" }),
      ui.el("p", { class: "storage-card-copy", text: "曲库索引、应用设置、别名和任务记录保存在数据库，不会写成缓存目录下的配置文件。" }),
      ui.el("div", { class: "storage-store-tags" }, ["曲库索引", "应用设置", "别名", "任务"].map((text) => ui.el("span", { text }))),
    ] }),
  );
  nodes.breakdown.replaceChildren();
  if (snapshot) {
    for (const [label, item, note] of [
      ["AVIF 缩略图", thumbnails, "128 / 256 / 512px，保持比例"],
      ["封面原图", originals, "请求原图时保存，保留原始格式"],
    ]) {
      if (!item) continue;
      nodes.breakdown.append(ui.el("div", { class: "storage-cache-row" }, [
        ui.el("div", {}, [ui.el("strong", { text: label }), ui.el("span", { class: "hint", text: note })]),
        ui.el("code", { text: item.path || "—", title: item.path || "" }),
        ui.el("span", { class: "storage-cache-size", text: item.error ? "读取受限" : `${item.truncated ? "至少 " : ""}${ui.fmtNum(number(item.files))} 份 · ${ui.fmtBytes(number(item.bytes))}` }),
        item.error ? ui.el("p", { class: "storage-cache-error", text: item.error }) : item.exists === false ? ui.el("p", { class: "hint storage-cache-note", text: "目录尚未创建，首次成功缓存时会自动建立。" }) : null,
      ]));
    }
  }
  nodes.checked.textContent = snapshot?.checked_at ? `更新于 ${ui.fmtTime(snapshot.checked_at)}` : "尚未读取用量";
  nodes.locationNote.textContent = container
    ? "这里显示容器内路径。宿主机目录由 Compose 的卷映射决定，请在运行 Docker 的那台设备上核对。"
    : "这里显示运行服务的机器路径。环境变量保存在部署配置中，界面设置保存在 PostgreSQL。";
}

function renderWriteChecks() {
  const checks = snapshot?.write_checks;
  nodes.feedback.replaceChildren();
  if (!Array.isArray(checks)) {
    nodes.feedback.append(ui.el("p", { class: "hint", text: "用量统计不会测试写入权限。图片可在缓存写入失败时继续显示，可手动检查确认。" }));
    return;
  }
  const failures = checks.filter((check) => check.state !== "ok");
  nodes.feedback.append(ui.el("div", { class: `storage-check-summary ${failures.length ? "has-errors" : "is-ok"}` }, [
    ui.icon(failures.length ? "warn" : "check", { size: 18 }),
    ui.el("strong", { text: failures.length ? `${failures.length} 个目录未通过写入检查` : "缓存目录可正常写入" }),
  ]));
  for (const check of checks) {
    nodes.feedback.append(ui.el("div", { class: "storage-check-row" }, [
      pill(check.state === "ok" ? "可写" : "检查失败", check.state === "ok" ? "ok" : "warn"),
      ui.el("code", { text: check.path || "—" }),
      check.error ? ui.el("span", { class: "hint", text: check.error }) : null,
    ]));
  }
  if (failures.length) nodes.feedback.append(ui.el("p", { class: "hint storage-check-help", text: "请核对卷是否只读，以及容器运行用户对宿主目录的写入权限。检查过程没有更改目录权限。" }));
}

// Use an allowlist even if a future API version adds deployment fields. Paths
// and filesystem errors are useful here; credentials and connection URLs are not.
function diagnosticReport() {
  const bucket = (item = {}) => ({
    path: item.path, exists: item.exists, files: item.files, bytes: item.bytes,
    truncated: item.truncated, error: item.error,
  });
  return JSON.stringify({
    version: status.version || "unknown", checked_at: snapshot.checked_at,
    database: { engine: snapshot.database?.engine, connected: snapshot.database?.connected, stores: snapshot.database?.stores },
    music: { path: snapshot.music?.path, exists: snapshot.music?.exists },
    cache: {
      root: snapshot.cache?.root, format: snapshot.cache?.format, on_demand: snapshot.cache?.on_demand,
      originals: bucket(snapshot.cache?.originals), thumbnails: bucket(snapshot.cache?.thumbnails),
    },
    runtime: { container: snapshot.runtime?.container },
    write_checks: snapshot.write_checks?.map((entry) => ({ path: entry.path, state: entry.state, error: entry.error })) || null,
  }, null, 2);
}

async function copyReport() {
  if (!snapshot || pending) return;
  const report = diagnosticReport();
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(report);
    ui.toast("ok", "诊断信息已复制", "包含目录与检查结果，不含口令或数据库连接串");
  } catch {
    const text = ui.el("textarea", { class: "storage-report-text", readonly: true, rows: 12, value: report, "aria-label": "可复制的存储诊断信息", spellcheck: "false" });
    const closed = ui.openDialog({
      title: "存储诊断信息", subtitle: "浏览器未开放自动复制，可选中文字后手动复制。内容不含口令或连接串。",
      body: text, actions: [{ id: "close", label: "完成", variant: "btn-primary" }],
    });
    text.focus();
    text.select();
    await closed;
  }
}
