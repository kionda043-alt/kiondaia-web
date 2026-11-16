// kionda IA · Carta digital con QR (alta automática, multi-local)
// POST body {accion, ...}. Públicas: ver, registrar. Con sesión (Authorization: Bearer <token de Supabase Auth>): el resto.
// Las tablas carta_* no tienen políticas públicas: todo pasa por esta función con la service role.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const SITIO = "https://kiondaia.com/carta";
const DIAS_PRUEBA = 15, MAX_LECTURAS = 4, MAX_ITEMS = 400;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (r: unknown, status = 200) => new Response(JSON.stringify(r), { status, headers: { ...CORS, "content-type": "application/json" } });
const txt = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const hex = (v: unknown, def: string) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? "")) ? String(v) : def);
const iso = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

type Local = Record<string, any>;
// Avisos a kionda por WhatsApp. Por ahora salen por la línea de la demo de restaurantes (Green API) al celular de avisos cargado ahí.
async function avisar(texto: string) {
  try {
    const { data } = await db.from("resto_negocios").select("config").eq("id", "unapizza").maybeSingle();
    const c = data?.config ?? {}, tk = Deno.env.get(c.green_token_secret ?? "") ?? "", cel = String(c.celular_reclamos ?? "").replace(/\D/g, "");
    if (!tk || !cel || !c.green_url) return "sin configurar";
    const r = await fetch(`${c.green_url}/waInstance${c.green_id}/sendMessage/${tk}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: `${cel}@c.us`, message: texto }) });
    return `${r.status} ${(await r.text()).slice(0, 120)}`;
  } catch (e) { console.error("avisar", e); return "error"; }
}
// Una vez por día: qué pruebas vencen pronto y cuáles vencieron ayer
async function resumenDiario() {
  const { data: ls } = await db.from("carta_locales").select("nombre,slug,prueba_hasta,estado,pago_hasta").in("estado", ["prueba", "activo"]);
  const ahora = Date.now(), dia = 86_400_000, pronto: string[] = [], vencidas: string[] = [];
  for (const l of ls ?? []) {
    const fin = l.estado === "prueba" ? new Date(l.prueba_hasta).getTime() : l.pago_hasta ? new Date(l.pago_hasta + "T23:59:59-03:00").getTime() : null;
    if (fin === null) continue;
    const que = l.estado === "prueba" ? "prueba" : "abono";
    if (fin > ahora && fin - ahora <= 3 * dia) pronto.push(`• ${l.nombre} (${que}, ${Math.ceil((fin - ahora) / dia)} día/s)`);
    else if (fin <= ahora && ahora - fin < dia) vencidas.push(`• ${l.nombre} (${que})`);
  }
  if (!pronto.length && !vencidas.length) return "nada";
  let t = "📋 *Cartas · resumen del día*";
  if (pronto.length) t += `\n\n⏳ Vencen pronto:\n${pronto.join("\n")}`;
  if (vencidas.length) t += `\n\n⏸️ Se pausaron hoy:\n${vencidas.join("\n")}`;
  return avisar(`${t}\n\n${SITIO}/admin/`);
}
// Una carta está activa si está en prueba vigente o si tiene el abono al día
function activa(l: Local) {
  if (l.estado === "prueba") return new Date(l.prueba_hasta).getTime() > Date.now();
  if (l.estado === "activo") return !l.pago_hasta || new Date(l.pago_hasta + "T23:59:59-03:00").getTime() > Date.now();
  return false;
}
function estadoDe(l: Local) {
  const a = activa(l);
  const hasta = l.estado === "prueba" ? new Date(l.prueba_hasta) : l.pago_hasta ? new Date(l.pago_hasta + "T23:59:59-03:00") : null;
  return { activa: a, tipo: a ? l.estado : "pausado", dias: hasta ? Math.max(0, Math.ceil((hasta.getTime() - Date.now()) / 86_400_000)) : null };
}
function slugify(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "local";
}
function preciosLimpios(p: any): { nombre: string; precio: number }[] {
  return (Array.isArray(p) ? p : []).map((o) => ({ nombre: txt(o?.nombre, 40), precio: Math.max(0, Math.round(Number(o?.precio) || 0)) })).filter((o) => o.precio > 0).slice(0, 6);
}
function coloresLimpios(c: any, prev: any = {}) {
  return {
    primario: hex(c?.primario, prev.primario ?? "#c8341f"),
    estilo: ["claro", "oscuro"].includes(c?.estilo) ? c.estilo : prev.estilo ?? "claro",
    fuente: ["moderna", "clasica"].includes(c?.fuente) ? c.fuente : prev.fuente ?? "moderna",
  };
}
async function items(local: string) {
  const { data } = await db.from("carta_items").select("id,categoria,nombre,descripcion,precios,disponible,orden").eq("local", local).order("orden").order("id");
  const l = data ?? [], cats = [...new Set(l.map((i) => i.categoria))];
  return l.sort((a, b) => cats.indexOf(a.categoria) - cats.indexOf(b.categoria) || a.orden - b.orden || a.id - b.id);
}
const publico = (l: Local) => ({ slug: l.slug, nombre: l.nombre, logo_url: l.logo_url, colores: l.colores, direccion: l.direccion, horarios: l.horarios, whatsapp: l.whatsapp, instagram: l.instagram, nota: l.nota });

// ---------- Lectura de la carta con IA ----------
async function aBase64(buf: Uint8Array) {
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function leerCarta(imagenes: { mime: string; b64: string }[]) {
  const sys = `Sos un asistente que transcribe cartas de locales gastronómicos de Argentina a partir de fotos. Devolvé SOLO este JSON:
{"categorias":[{"nombre":string,"items":[{"nombre":string,"descripcion":string,"precios":[{"nombre":string,"precio":number}]}]}]}
Reglas:
- Transcribí TODOS los productos que se lean, en el orden de la carta, agrupados por las secciones que figuran (si no hay secciones, usá una llamada "Carta").
- "precio" es un número entero en pesos, sin puntos ni símbolos ("$12.500" → 12500; "12,5" o "12.5K" → 12500).
- Si un producto tiene varios precios (tamaños, por ejemplo chica/grande, individual/para compartir, copa/botella), poné uno por cada tamaño con su nombre. Si tiene uno solo, "nombre" va vacío.
- "descripcion": ingredientes o aclaración si figura; si no, cadena vacía. No inventes descripciones.
- No inventes productos ni precios. Si un precio no se lee, omití ese producto.
- Escribí los nombres con mayúscula inicial y buena ortografía (no TODO EN MAYÚSCULAS).
- Si las fotos no son de una carta o menú, devolvé {"categorias":[]}.`;
  const parts: any[] = [{ text: "Transcribí esta carta." }, ...imagenes.map((i) => ({ inlineData: { mimeType: i.mime, data: i.b64 } }))];
  for (let intento = 0; intento < 2; intento++) {
    const gen: Record<string, unknown> = { temperature: 0.1, maxOutputTokens: 32768, responseMimeType: "application/json" };
    if (intento === 0) gen.thinkingConfig = { thinkingBudget: 0 };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts }], generationConfig: gen }),
    });
    if (!r.ok) { console.error("Gemini", r.status, (await r.text()).slice(0, 300)); continue; }
    const j = await r.json();
    const t = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    try { return JSON.parse(t.replace(/^```json\s*|```$/g, "").trim()); } catch { console.error("JSON carta", t.slice(0, 200)); }
  }
  return null;
}

// ---------- Acciones ----------
async function accion(req: Request, b: any): Promise<[unknown, number?]> {
  const a = b.accion;
  const ip = (req.headers.get("x-forwarded-for") ?? "?").split(",")[0].trim();

  // Carta pública: si está pausada no se muestra nada del contenido ni se explica por qué
  if (a === "ver") {
    const { data: l } = await db.from("carta_locales").select("*").eq("slug", txt(b.slug, 60).toLowerCase()).maybeSingle();
    if (!l) return [{ error: "No encontramos esa carta" }, 404];
    if (!activa(l)) return [{ pausada: true, nombre: l.nombre }];
    return [{ local: publico(l), items: (await items(l.id)).map(({ orden: _o, ...r }) => r) }];
  }

  if (a === "registrar") {
    const email = txt(b.email, 120).toLowerCase(), clave = String(b.clave ?? ""), nombre = txt(b.nombre, 60);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [{ error: "Revisá el email" }, 400];
    if (clave.length < 6) return [{ error: "La contraseña tiene que tener al menos 6 caracteres" }, 400];
    if (nombre.length < 2) return [{ error: "Poné el nombre de tu local" }, 400];
    const { count } = await db.from("carta_altas").select("id", { count: "exact", head: true }).eq("ip", ip).gte("creado", iso(-24 * 60));
    if ((count ?? 0) >= 3) return [{ error: "Se crearon varias cuentas desde esta conexión hoy. Probá mañana o escribinos." }, 429];
    const { data: u, error } = await db.auth.admin.createUser({ email, password: clave, email_confirm: true });
    if (error || !u?.user) return [{ error: /already|registered|exists/i.test(error?.message ?? "") ? "Ese email ya tiene una cuenta. Entrá con tu contraseña." : "No pudimos crear la cuenta. Probá de nuevo." }, 400];
    await db.from("carta_altas").insert({ ip });
    const base = slugify(nombre); let slug = base;
    for (let i = 2; i < 60; i++) {
      const { data: ya } = await db.from("carta_locales").select("id").eq("slug", slug).maybeSingle();
      if (!ya) break; slug = `${base}-${i}`;
    }
    const { error: e2 } = await db.from("carta_locales").insert({ owner: u.user.id, slug, nombre, ip, prueba_hasta: iso(DIAS_PRUEBA * 24 * 60) });
    if (e2) { console.error("alta local", e2); await db.auth.admin.deleteUser(u.user.id); return [{ error: "No pudimos crear tu carta. Probá de nuevo." }, 500]; }
    // @ts-ignore EdgeRuntime existe en Supabase
    EdgeRuntime.waitUntil(avisar(`🆕 *Carta nueva* · ${nombre}\n${email}\n${SITIO}/ver/?l=${slug}\n\nEmpieza su prueba de ${DIAS_PRUEBA} días. Administrador: ${SITIO}/admin/`).then((r) => console.log("aviso alta", r)));
    return [{ ok: true }];
  }

  // ----- Desde acá hace falta sesión -----
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: au } = token ? await db.auth.getUser(token) : { data: { user: null } } as any;
  const user = au?.user;
  if (!user) return [{ error: "Iniciá sesión de nuevo", sesion: false }, 401];
  const { data: adm } = await db.from("carta_admins").select("email").eq("email", (user.email ?? "").toLowerCase()).maybeSingle();
  const esAdmin = !!adm;

  if (a === "admin_lista" || a === "admin_estado" || a === "admin_clave") {
    if (!esAdmin) return [{ error: "No autorizado" }, 403];
    if (a === "admin_lista") {
      const { data: ls } = await db.from("carta_locales").select("*").order("creado", { ascending: false }).limit(500);
      const { data: us } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const mail = new Map((us?.users ?? []).map((x: any) => [x.id, x.email]));
      const { data: cnt } = await db.from("carta_items").select("local").limit(20000);
      const n = new Map<string, number>(); for (const c of cnt ?? []) n.set(c.local, (n.get(c.local) ?? 0) + 1);
      return [{ locales: (ls ?? []).map((l) => ({ id: l.id, slug: l.slug, nombre: l.nombre, email: mail.get(l.owner) ?? "", whatsapp: l.whatsapp, estado: l.estado, prueba_hasta: l.prueba_hasta, pago_hasta: l.pago_hasta, creado: l.creado, productos: n.get(l.id) ?? 0, visto: l.visto_admin, ...estadoDe(l) })) }];
    }
    const { data: l } = await db.from("carta_locales").select("*").eq("id", b.id).maybeSingle();
    if (!l) return [{ error: "No existe" }, 404];
    if (a === "admin_clave") {
      if (String(b.clave ?? "").length < 6) return [{ error: "Mínimo 6 caracteres" }, 400];
      const { error } = await db.auth.admin.updateUserById(l.owner, { password: String(b.clave) });
      return [error ? { error: "No se pudo cambiar" } : { ok: true }];
    }
    const hoy = new Date(Date.now() - 3 * 3600_000);
    const mas = (d: number, desde = hoy) => new Date(desde.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    let c: Record<string, unknown> = { visto_admin: true };
    if (b.cambio === "activar") {
      // Suma 30 días desde hoy, o desde el vencimiento si todavía no venció
      const base = l.estado === "activo" && l.pago_hasta && new Date(l.pago_hasta) > hoy ? new Date(l.pago_hasta) : hoy;
      c = { ...c, estado: "activo", pago_hasta: mas(30, base) };
    } else if (b.cambio === "pausar") c = { ...c, estado: "pausado" };
    else if (b.cambio === "extender") c = { ...c, estado: "prueba", prueba_hasta: new Date(Math.max(Date.now(), new Date(l.prueba_hasta).getTime()) + 15 * 86_400_000).toISOString() };
    else if (b.cambio !== "visto") return [{ error: "cambio inválido" }, 400];
    await db.from("carta_locales").update(c).eq("id", l.id);
    return [{ ok: true }];
  }

  const { data: local } = await db.from("carta_locales").select("*").eq("owner", user.id).maybeSingle();
  if (a === "mio") {
    if (!local) return [{ local: null, admin: esAdmin, email: user.email }];
    const { ip: _ip, owner: _ow, visto_admin: _v, ...l } = local;
    return [{ local: { ...l, ...estadoDe(local), lecturas_restantes: Math.max(0, MAX_LECTURAS - local.lecturas_ia) }, items: await items(local.id), admin: esAdmin, email: user.email, url: `${SITIO}/ver/?l=${local.slug}` }];
  }
  if (!local) return [{ error: "Tu cuenta no tiene una carta" }, 404];
  const tocar = () => db.from("carta_locales").update({ actualizado: new Date().toISOString() }).eq("id", local.id);

  if (a === "leer_carta") {
    if (local.lecturas_ia >= MAX_LECTURAS) return [{ error: "Ya usaste las lecturas automáticas de tu cuenta. Podés seguir cargando productos a mano o escribirnos." }, 429];
    const imgs: { mime: string; b64: string }[] = [];
    for (const im of (Array.isArray(b.imagenes) ? b.imagenes : []).slice(0, 6)) {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(im));
      if (m && m[2].length < 3_000_000) imgs.push({ mime: m[1], b64: m[2] });
    }
    if (b.ejemplo) { // carta de muestra, para probar sin tener la foto a mano
      const r = await fetch(`${SITIO}/ejemplo-carta.jpg`);
      if (r.ok) imgs.push({ mime: "image/jpeg", b64: await aBase64(new Uint8Array(await r.arrayBuffer())) });
    }
    if (!imgs.length) return [{ error: "Subí al menos una foto de tu carta" }, 400];
    await db.from("carta_locales").update({ lecturas_ia: local.lecturas_ia + 1 }).eq("id", local.id);
    const out = await leerCarta(imgs);
    const filas: any[] = []; let orden = 0;
    for (const c of out?.categorias ?? []) for (const it of c?.items ?? []) {
      const precios = preciosLimpios(it?.precios), nombre = txt(it?.nombre, 80);
      if (nombre && precios.length && filas.length < MAX_ITEMS) filas.push({ local: local.id, categoria: txt(c?.nombre, 60) || "Carta", nombre, descripcion: txt(it?.descripcion, 300), precios, orden: orden++ });
    }
    if (!filas.length) {
      await db.from("carta_locales").update({ lecturas_ia: local.lecturas_ia }).eq("id", local.id); // no cuenta si no salió nada
      return [{ error: "No pudimos leer productos en esas fotos. Probá con fotos más nítidas, derechas y con buena luz." }, 422];
    }
    if (b.reemplazar !== false) await db.from("carta_items").delete().eq("local", local.id);
    else { const { data: ult } = await db.from("carta_items").select("orden").eq("local", local.id).order("orden", { ascending: false }).limit(1).maybeSingle(); const d = (ult?.orden ?? -1) + 1; filas.forEach((f) => f.orden += d); }
    const { error } = await db.from("carta_items").insert(filas);
    if (error) { console.error("insert items", error); return [{ error: "No pudimos guardar la carta. Probá de nuevo." }, 500]; }
    await tocar();
    return [{ ok: true, productos: filas.length, categorias: new Set(filas.map((f) => f.categoria)).size }];
  }

  if (a === "guardar_local") {
    const c: Record<string, unknown> = { actualizado: new Date().toISOString() };
    if ("nombre" in b && txt(b.nombre, 60).length >= 2) c.nombre = txt(b.nombre, 60);
    for (const k of ["direccion", "horarios", "nota"]) if (k in b) c[k] = txt(b[k], 200) || null;
    if ("whatsapp" in b) c.whatsapp = String(b.whatsapp ?? "").replace(/\D/g, "").slice(0, 15) || null;
    if ("instagram" in b) c.instagram = txt(b.instagram, 40).replace(/^@/, "").replace(/[^a-zA-Z0-9._]/g, "") || null;
    if (b.colores) c.colores = coloresLimpios(b.colores, local.colores);
    if (b.quitar_logo) c.logo_url = null;
    await db.from("carta_locales").update(c).eq("id", local.id);
    return [{ ok: true }];
  }

  if (a === "logo") {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(b.imagen ?? ""));
    if (!m || m[2].length > 1_400_000) return [{ error: "La imagen del logo es muy pesada o no es válida" }, 400];
    const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    const ruta = `${local.id}/logo-${Date.now()}.${m[1].split("/")[1].replace("jpeg", "jpg")}`;
    const { error } = await db.storage.from("carta").upload(ruta, bin, { contentType: m[1], upsert: true });
    if (error) { console.error("logo", error); return [{ error: "No pudimos subir el logo" }, 500]; }
    const url = db.storage.from("carta").getPublicUrl(ruta).data.publicUrl;
    const c: Record<string, unknown> = { logo_url: url, actualizado: new Date().toISOString() };
    if (b.colores) c.colores = coloresLimpios(b.colores, local.colores);
    await db.from("carta_locales").update(c).eq("id", local.id);
    return [{ ok: true, logo_url: url }];
  }

  if (a === "item_guardar") {
    const precios = preciosLimpios(b.precios), nombre = txt(b.nombre, 80), categoria = txt(b.categoria, 60);
    if (!nombre || !categoria || !precios.length) return [{ error: "Falta nombre, categoría o precio" }, 400];
    const fila = { categoria, nombre, descripcion: txt(b.descripcion, 300), precios, disponible: b.disponible !== false };
    if (b.id) await db.from("carta_items").update(fila).eq("local", local.id).eq("id", b.id);
    else {
      const { count } = await db.from("carta_items").select("id", { count: "exact", head: true }).eq("local", local.id);
      if ((count ?? 0) >= MAX_ITEMS) return [{ error: "Llegaste al máximo de productos" }, 400];
      const { data: ult } = await db.from("carta_items").select("orden").eq("local", local.id).order("orden", { ascending: false }).limit(1).maybeSingle();
      await db.from("carta_items").insert({ ...fila, local: local.id, orden: (ult?.orden ?? -1) + 1 });
    }
    await tocar();
    return [{ ok: true }];
  }
  if (a === "item_disponible") { await db.from("carta_items").update({ disponible: !!b.disponible }).eq("local", local.id).eq("id", b.id); await tocar(); return [{ ok: true }]; }
  if (a === "item_borrar") { await db.from("carta_items").delete().eq("local", local.id).eq("id", b.id); await tocar(); return [{ ok: true }]; }
  if (a === "categoria_renombrar") {
    const de = txt(b.de, 60), aNombre = txt(b.a, 60);
    if (!de || !aNombre) return [{ error: "Falta el nombre" }, 400];
    await db.from("carta_items").update({ categoria: aNombre }).eq("local", local.id).eq("categoria", de); await tocar();
    return [{ ok: true }];
  }
  if (a === "categoria_borrar") { await db.from("carta_items").delete().eq("local", local.id).eq("categoria", txt(b.categoria, 60)); await tocar(); return [{ ok: true }]; }
  return [{ error: "acción desconocida" }, 400];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    const u = new URL(req.url);
    if (u.searchParams.get("tareas")) { // lo llama el cron diario, con la misma clave que usa el webhook de la demo
      const { data } = await db.from("resto_negocios").select("config").eq("id", "unapizza").maybeSingle();
      if (u.searchParams.get("k") !== data?.config?.webhook_key) return json({ error: "no" }, 403);
      return json({ ok: true, resultado: await resumenDiario() });
    }
    return json({ ok: true, servicio: "carta" });
  }
  let b: any = {}; try { b = await req.json(); } catch { /* vacío */ }
  try {
    const [r, status] = await accion(req, b);
    return json(r, status ?? 200);
  } catch (e) {
    console.error("carta", b?.accion, e);
    return json({ error: "Algo falló de nuestro lado. Probá de nuevo." }, 500);
  }
});
