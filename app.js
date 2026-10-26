/* Image to Text — OCR by tesseract.js 5 (Apache-2.0) in a Web Worker on this device; PDFs rendered by pdf.js.
   Every engine file and language model is loaded from this site's lib/ folder. Nothing is uploaded. */
const { $, $$, h } = S3;
const LANG_NAME = { eng: "English", ara: "Arabic", "eng+ara": "English + Arabic" };
const saved = S3.store("ocr") || {};
const o = { lang: LANG_NAME[saved.lang] ? saved.lang : "eng", dpi: saved.dpi || "200", join: !!saved.join };
const st = { pages: [], running: false, stop: false, cancel: null, current: null };
const queue = [];
const MAX_SIDE = 4200; // bigger photos are scaled down: faster, and Tesseract gains nothing past this

// ---------- pure helpers (tested in S3_SELFTEST) ----------
// Tidy Tesseract's output: trim line ends, collapse 3+ blank lines.
function tidy(t) {
  return String(t || "").replace(/\r/g, "").split("\n").map(l => l.replace(/[ \t]+$/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// Join wrapped lines into paragraphs; blank lines stay paragraph breaks; "exam-\nple" -> "example".
function reflow(t) {
  return tidy(t).split(/\n\s*\n/).map(p => p.replace(/(\p{Ll})-\n(?=\p{Ll})/gu, "$1").replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).join("\n\n");
}
// Rebuild the text from line boxes: Tesseract tends to call every short line a paragraph, so a blank line
// is kept only where there is real vertical space (or a jump back up, i.e. a new column).
function layoutText(lines) {
  const L = (lines || []).map(l => ({ t: String(l.text || "").replace(/\s+$/, ""), b: l.bbox })).filter(l => l.t && l.b);
  if (!L.length) return null;
  const hs = L.map(l => l.b.y1 - l.b.y0).sort((a, b) => a - b), hMed = hs[hs.length >> 1] || 1;
  return L.map((l, i) => {
    if (!i) return l.t;
    const p = L[i - 1].b, gap = l.b.y0 - p.y1;
    return (gap > hMed * 0.75 || l.b.y0 < p.y0 - hMed ? "\n\n" : "\n") + l.t;
  }).join("");
}
function wordCount(t) { const m = String(t).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu); return m ? m.length : 0; }
function isRtl(t) { const s = String(t).replace(/[^\p{L}]/gu, ""); if (!s) return false; const ar = (s.match(/[\u0590-\u08FF\uFB1D-\uFEFF]/g) || []).length; return ar / s.length > 0.5; }
function fitSide(w, hh, max) { const k = Math.min(1, max / Math.max(w, hh)); return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(hh * k)) }; }
function combine(pages, join) {
  const done = pages.filter(p => p.text != null);
  const multi = pages.length > 1;
  return done.map(p => { const t = join ? reflow(p.text) : p.text; return multi ? "— " + p.label + " —\n" + (t || "(no text found)") : t; }).join("\n\n");
}

// ---------- the OCR worker (one, re-made when the language changes) ----------
let W = null;
function getWorker(langs) {
  if (W && W.langs === langs) return W.ready;
  dropWorker();
  const rec = { langs };
  rec.ready = Tesseract.createWorker(langs.split("+"), 1, {
    workerPath: "lib/tesseract.worker.min.js", corePath: "lib/", langPath: "lib",
    gzip: true, cacheMethod: "none", workerBlobURL: false,
    logger: m => { if (W === rec && st.onLog) st.onLog(m); },
    errorHandler: e => console.warn("OCR worker:", e)
  });
  rec.ready.catch(() => { if (W === rec) W = null; });
  W = rec;
  return rec.ready;
}
function dropWorker() { if (!W) return; const r = W; W = null; r.ready.then(w => w.terminate()).catch(() => {}); }
async function ocrCanvas(canvas, langs) {
  const w = await withCancel(getWorker(langs));
  const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
  const res = await withCancel(w.recognize(blob));
  return { text: tidy(layoutText(res.data.lines) ?? res.data.text), conf: Math.round(res.data.confidence || 0) };
}
function withCancel(p) { return st.cancel ? Promise.race([p, st.cancel.promise]) : p; }

// ---------- turning files into page canvases ----------
let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) { pdfjs = await import("./lib/pdf.min.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs"; }
  return pdfjs;
}
function isPdf(f) { return f.type === "application/pdf" || /\.pdf$/i.test(f.name); }
async function imageCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { throw new Error("This browser can't open " + file.name); }
  const s = fitSide(bmp.width, bmp.height, MAX_SIDE), c = document.createElement("canvas");
  c.width = s.w; c.height = s.h;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, s.w, s.h); g.drawImage(bmp, 0, 0, s.w, s.h);
  bmp.close && bmp.close();
  return c;
}
async function* pagesOf(src) {
  if (src.canvas) { yield { label: src.name, canvas: src.canvas }; return; }
  const f = src.file;
  if (!isPdf(f)) { yield { label: f.name, canvas: await imageCanvas(f) }; return; }
  const lib = await loadPdfjs();
  let doc;
  try { doc = await lib.getDocument({ data: new Uint8Array(await S3.readFile(f)), isEvalSupported: false, verbosity: 0 }).promise; }
  catch (e) { throw new Error(e && e.name === "PasswordException" ? f.name + " is password-protected" : "Couldn't open " + f.name + " as a PDF"); }
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      if (st.stop) return;
      const page = await doc.getPage(i), v1 = page.getViewport({ scale: 1 });
      const k = Math.min(+o.dpi / 72, MAX_SIDE / Math.max(v1.width, v1.height)), vp = page.getViewport({ scale: k });
      const c = document.createElement("canvas"); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp, background: "#ffffff" }).promise;
      page.cleanup();
      yield { label: f.name + " · page " + i + " of " + doc.numPages, canvas: c, pdfPage: i };
    }
  } finally { doc.destroy(); }
}

// ---------- the job loop ----------
function enqueue(srcs) {
  if (!srcs.length) return;
  queue.push(...srcs);
  $("#results").hidden = false; $("#drop").classList.add("ocr-compact");
  if (!st.running) pump();
}
async function pump() {
  st.running = true; st.stop = false;
  let resolveCancel; st.cancel = { promise: new Promise((_, rej) => { resolveCancel = rej; }) }; st.cancel.fire = resolveCancel;
  st.cancel.promise.catch(() => {});
  setBusy(true);
  try {
    while (queue.length && !st.stop) {
      const src = queue.shift();
      try {
        for await (const pg of pagesOf(src)) {
          if (st.stop) break;
          await ocrPage(pg);
        }
      } catch (e) {
        if (st.stop) break;
        S3.toast(e && e.message ? e.message : "Couldn't read that file", "error");
      }
    }
    if (!st.stop && st.pages.some(p => p.text != null)) S3.done();
  } finally {
    queue.length = 0; st.running = false; st.cancel = null; st.onLog = null;
    st.pages.forEach(p => { if (p.text == null && p.state !== "error") { p.state = "stopped"; paintPage(p); } });
    setBusy(false); refresh();
  }
}
async function ocrPage(pg) {
  const p = { label: pg.label, text: null, conf: null, state: "waiting", el: null, thumb: thumbOf(pg.canvas, 140), big: await previewOf(pg.canvas) };
  st.pages.push(p); paintPage(p); showSource(p); refresh();
  const langs = o.lang;
  st.onLog = m => {
    const pct = Math.round((m.progress || 0) * 100);
    if (m.status === "recognizing text") { p.state = "reading " + pct + "%"; setProg(pct / 100, "Reading " + pg.label + "… " + pct + "%"); }
    else setProg(null, cap(m.status || "working") + (m.progress && m.progress < 1 ? " " + pct + "%" : "") + "…");
    paintPage(p);
  };
  p.state = "reading"; paintPage(p);
  try {
    const r = await ocrCanvas(pg.canvas, langs);
    p.text = r.text; p.conf = r.conf; p.state = "done";
  } catch (e) {
    if (st.stop) { p.state = "stopped"; } else { p.state = "error"; S3.toast("OCR failed on " + pg.label, "error"); console.warn(e); }
  }
  pg.canvas.width = pg.canvas.height = 0;
  paintPage(p); refresh();
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function scaled(c, max) {
  const s = fitSide(c.width, c.height, max), t = document.createElement("canvas"); t.width = s.w; t.height = s.h;
  t.getContext("2d").drawImage(c, 0, 0, s.w, s.h);
  return t;
}
function thumbOf(c, max) { return scaled(c, max).toDataURL("image/jpeg", 0.8); }
async function previewOf(c) { const b = await new Promise(r => scaled(c, 1100).toBlob(r, "image/jpeg", 0.85)); return URL.createObjectURL(b); }
function showSource(p) {
  st.shown = p;
  $("#srcImg").src = p.big; $("#srcCap").textContent = p.label;
  st.pages.forEach(x => x.el && x.el.classList.toggle("is-on", x === p));
}

// ---------- UI ----------
function save() { S3.store("ocr", o); }
function setBusy(on) { $("#progWrap").hidden = !on; $("#clear").disabled = on; if (on) setProg(null, "Starting…"); }
function setProg(v, text) {
  const pr = $("#prog");
  if (v == null) pr.removeAttribute("value"); else pr.value = v;
  if (text) $("#progText").textContent = text;
}
function confChip(c) { return c >= 85 ? "ok" : c >= 65 ? "warn" : "bad"; }
function paintPage(p) {
  if (!p.el) {
    p.el = h("div", { "class": "ocr-page" }, [
      h("img", { src: p.thumb, alt: "" }),
      h("div", { "class": "ocr-pmeta" }, [h("b", { text: p.label }), h("span", { "class": "faint" })]),
      h("button", { "class": "btn small", type: "button", disabled: true, onclick: e => { e.stopPropagation(); if (p.text != null) S3.copy(o.join ? reflow(p.text) : p.text, "Page text copied"); } }, ["Copy"])
    ]);
    p.el.addEventListener("click", () => showSource(p));
    $("#pages").appendChild(p.el);
  }
  const meta = p.el.querySelector(".ocr-pmeta span");
  meta.className = "chip";
  if (p.state === "done") {
    const n = wordCount(p.text);
    meta.textContent = n ? n + " words · " + p.conf + "% confident" : "No text found";
    meta.classList.add(n ? confChip(p.conf) : "warn");
  } else meta.textContent = cap(p.state);
  if (p.state === "error") meta.classList.add("bad");
  p.el.querySelector("button").disabled = p.text == null;
}
function refresh() {
  const done = st.pages.filter(p => p.text != null);
  const text = combine(st.pages, o.join);
  const ta = $("#text");
  ta.value = text; ta.dir = isRtl(text) ? "rtl" : "auto";
  $("#pages").hidden = st.pages.length < 2;
  const words = done.reduce((s, p) => s + wordCount(p.text), 0);
  const conf = done.length ? Math.round(done.reduce((s, p) => s + p.conf, 0) / done.length) : null;
  $("#rsum").textContent = st.pages.length ? done.length + " of " + st.pages.length + (st.pages.length === 1 ? " image" : " pages") : "";
  const stats = $("#stats"); stats.textContent = "";
  if (done.length) {
    [[words.toLocaleString(), "words"], [text.length.toLocaleString(), "characters"], [conf + "%", "average confidence"], [LANG_NAME[o.lang], "language"]]
      .forEach(([b, s]) => stats.appendChild(h("div", { "class": "stat" }, [h("b", { text: b }), h("span", { text: s })])));
  }
  if (done.length && conf < 65) $("#rsum").textContent += " · low confidence: try a sharper image or the other language";
}

function wireSeg(el, val, pick) {
  $$("button", el).forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.v === val));
    b.addEventListener("click", () => { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); pick(b.dataset.v); });
  });
}
wireSeg($("#lang"), o.lang, v => { o.lang = v; save(); if (!st.running) dropWorker(); });
$("#dpi").value = o.dpi; $("#dpi").addEventListener("change", e => { o.dpi = e.target.value; save(); });
$("#join").checked = o.join; $("#join").addEventListener("change", e => { o.join = e.target.checked; save(); refresh(); });

const ACCEPT = "image/*,.pdf,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp";
S3.drop($("#drop"), files => enqueue(files.map(file => ({ file }))), { accept: ACCEPT, multiple: true });
$("#cam input").addEventListener("change", e => { const f = e.target.files[0]; if (f) enqueue([{ file: f }]); e.target.value = ""; });
document.addEventListener("paste", e => {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []).filter(i => i.kind === "file" && /^image\//.test(i.type));
  if (!items.length) return;
  e.preventDefault();
  enqueue(items.map((it, k) => { const f = it.getAsFile(); return { file: new File([f], "pasted-image" + (k ? "-" + (k + 1) : "") + ".png", { type: f.type }) }; }));
});
$("#cancel").addEventListener("click", () => {
  if (!st.running) return;
  st.stop = true; queue.length = 0;
  if (st.cancel) st.cancel.fire(new Error("stopped"));
  dropWorker(); // the only way to interrupt Tesseract mid-page
  S3.toast("Stopped");
});
$("#copy").addEventListener("click", () => { const t = $("#text").value; if (t.trim()) S3.copy(t); else S3.toast("No text yet", "error"); });
$("#save").addEventListener("click", () => {
  const t = $("#text").value; if (!t.trim()) { S3.toast("No text yet", "error"); return; }
  const first = st.pages[0] ? st.pages[0].label.replace(/ · page.*$/, "").replace(/\.[^.]+$/, "") : "text";
  S3.download(new Blob(["﻿" + t.replace(/\n/g, "\r\n")], { type: "text/plain;charset=utf-8" }), (first || "text") + ".txt");
  S3.done();
});
$("#clear").addEventListener("click", () => { if (st.running) return; st.pages.forEach(p => URL.revokeObjectURL(p.big)); st.pages = []; $("#drop").classList.remove("ocr-compact"); $("#pages").textContent = ""; $("#text").value = ""; $("#results").hidden = true; refresh(); });

// ---------- synthetic page (demo + self-test) ----------
function textCanvas(lines, opt) {
  opt = opt || {};
  const size = opt.size || 56, pad = size, lh = Math.round(size * (opt.lh || 1.45)), font = (opt.weight || "600") + " " + size + "px " + (opt.family || "Arial, Helvetica, sans-serif");
  const c = document.createElement("canvas"), g = c.getContext("2d");
  g.font = font;
  const w = Math.ceil(Math.max(...lines.map(l => g.measureText(l).width)) + pad * 2);
  c.width = Math.max(opt.minW || 0, w); c.height = lh * lines.length + pad * 2;
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#111"; g.font = font; g.textBaseline = "middle";
  if (opt.rtl) { g.direction = "rtl"; g.textAlign = "right"; }
  lines.forEach((l, i) => g.fillText(l, opt.rtl ? c.width - pad : pad, pad + lh * i + lh / 2));
  return c;
}

window.S3_DEMO = async function () {
  $$("#lang button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === "eng")));
  o.lang = "eng"; o.join = false; $("#join").checked = false;
  const page = textCanvas([
    "City Library — Opening Hours",
    "Monday to Thursday: 9:00 to 18:00",
    "Friday: closed",
    "Saturday and Sunday: 10:00 to 16:00",
    "Please return borrowed books within 14 days.",
    "Questions? Ask at the front desk."
  ], { size: 34, weight: "500", family: "Georgia, 'Times New Roman', serif", lh: 1.2 });
  enqueue([{ name: "library-notice.png", canvas: page }]);
  while (st.running) await new Promise(r => setTimeout(r, 100));
};

// Self-test: real OCR of text we drew ourselves, through the same local worker the tool uses.
window.S3_SELFTEST = async function () {
  const unit = tidy("a  \n\n\n\nb ") === "a\n\nb" && reflow("The quick bro-\nwn fox\njumps.\n\nNew para") === "The quick brown fox jumps.\n\nNew para" &&
    wordCount("Hello, world — it's 2026! مرحبا بكم") === 6 && isRtl("مرحبا بكم في الموقع") && !isRtl("Hello مرحبا world again") &&
    fitSide(8400, 4200, 4200).w === 4200 && fitSide(8400, 4200, 4200).h === 2100 && fitSide(100, 50, 4200).w === 100 &&
    layoutText([{ text: "One\n\n", bbox: { y0: 10, y1: 40 } }, { text: "two\n", bbox: { y0: 50, y1: 80 } }, { text: "Three", bbox: { y0: 130, y1: 160 } }, { text: "col 2", bbox: { y0: 10, y1: 40 } }]) === "One\ntwo\n\nThree\n\ncol 2" &&
    layoutText([]) === null &&
    combine([{ label: "a.png", text: "x\ny" }, { label: "b.png", text: "" }], true) === "— a.png —\nx y\n\n— b.png —\n(no text found)";
  if (!unit) return "unit helpers failed";
  const norm = s => s.replace(/\s+/g, " ").trim().toUpperCase();
  const en = await (await getWorker("eng")).recognize(await new Promise(r => textCanvas(["HELLO 2026"], { size: 72, weight: "700" }).toBlob(r, "image/png")));
  if (!norm(en.data.text).includes("HELLO 2026")) return "English OCR read: " + JSON.stringify(en.data.text);
  const ar = await (await getWorker("ara")).recognize(await new Promise(r => textCanvas(["السلام عليكم"], { size: 64, weight: "400", family: "Arial, Tahoma, sans-serif", rtl: true, minW: 700 }).toBlob(r, "image/png")));
  if (!ar.data.text.replace(/\s+/g, "").includes("السلامعليكم")) return "Arabic OCR read: " + JSON.stringify(ar.data.text);
  return true;
};
