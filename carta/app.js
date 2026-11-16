// kionda IA · Carta digital — utilidades compartidas (sesión y llamadas al servidor)
const SB = "https://itnxcvnmmoqgeijerjqj.supabase.co";
const KEY = "sb_publishable_jJ7O9A5iqqLoeyWF1SYZZQ_LQpd4vLK";
const WA_KIONDA = "5491132654042";
const PRECIO = 15000;
const $id = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pesos = (n) => "$" + Math.round(n || 0).toLocaleString("es-AR");
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };
let ses = null; try { ses = JSON.parse(store.get("kionda_carta_ses") || "null"); } catch {}
function guardarSes(j) { ses = { a: j.access_token, r: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }; store.set("kionda_carta_ses", JSON.stringify(ses)); }
function salir(a = "../") { ses = null; store.del("kionda_carta_ses"); location.href = a; }
async function entrar(email, clave) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { "content-type": "application/json", apikey: KEY }, body: JSON.stringify({ email, password: clave }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Email o contraseña incorrectos");
  guardarSes(j);
}
async function token() {
  if (!ses) return null;
  if (ses.exp - 60000 > Date.now()) return ses.a;
  const r = await fetch(`${SB}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { "content-type": "application/json", apikey: KEY }, body: JSON.stringify({ refresh_token: ses.r }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { ses = null; store.del("kionda_carta_ses"); return null; }
  guardarSes(j); return ses.a;
}
async function api(accion, datos = {}) {
  const t = await token(), h = { "content-type": "application/json", apikey: KEY };
  if (t) h.authorization = "Bearer " + t;
  let r; try { r = await fetch(`${SB}/functions/v1/carta`, { method: "POST", headers: h, body: JSON.stringify({ accion, ...datos }) }); } catch { throw new Error("Sin conexión. Revisá internet y probá de nuevo."); }
  const j = await r.json().catch(() => ({ error: "Respuesta inválida" }));
  if (j.sesion === false) { const e = new Error(j.error); e.sesion = false; throw e; }
  if (!r.ok || j.error) throw new Error(j.error || "Error");
  return j;
}
function toast(t) { let e = $id("toast"); if (!e) { e = document.createElement("div"); e.id = "toast"; document.body.appendChild(e); } e.textContent = t; e.classList.add("on"); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove("on"), 2800); }
// Achica una foto antes de subirla (las fotos del celular pesan varios MB)
function achicar(file, max, tipo = "image/jpeg", calidad = 0.82) {
  return new Promise((ok, mal) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const x = c.getContext("2d"); if (tipo === "image/jpeg") { x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); } x.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); ok(c.toDataURL(tipo, calidad)); };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error("No pudimos abrir esa imagen")); };
    img.src = url;
  });
}
// Color principal de un logo: el más presente entre los que tienen color (ignora blancos, negros y transparentes)
function colorDeLogo(dataUrl) {
  return new Promise((ok) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d"); x.drawImage(img, 0, 0, 64, 64);
      const d = x.getImageData(0, 0, 64, 64).data, cub = new Map();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
        if (sat < 0.25 || mx < 50) continue;
        const k = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4), v = cub.get(k) || [0, 0, 0, 0, 0];
        v[0] += sat + 0.3; v[1] += r; v[2] += g; v[3] += b; v[4]++; cub.set(k, v);
      }
      let m = null; for (const v of cub.values()) if (!m || v[0] > m[0]) m = v;
      if (!m) return ok(null);
      ok("#" + [m[1], m[2], m[3]].map((s) => Math.round(s / m[4]).toString(16).padStart(2, "0")).join(""));
    };
    img.onerror = () => ok(null); img.src = dataUrl;
  });
}
function svgQR(url) {
  const q = qrcode(0, "M"); q.addData(url); q.make(); const n = q.getModuleCount(); let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + 1},${y + 1}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n + 2} ${n + 2}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}
