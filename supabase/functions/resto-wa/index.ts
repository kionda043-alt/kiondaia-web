// kionda IA · Bot de pedidos para locales de comida (WhatsApp por QR con Green-API + Gemini)
// Un solo endpoint para dos cosas:
//   1) Webhook de Green:   POST ?n=<negocio>&k=<webhook_key>
//   2) API del panel:      POST ?n=<negocio>&panel=1   body {pin, accion, ...}
// Setup del webhook en Green: GET ?n=<negocio>&k=<webhook_key>&setup=1
// Los precios y el total los calcula SIEMPRE el servidor con la carta de la base (la IA solo arma el carrito).
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const BASE = Deno.env.get("SUPABASE_URL")!;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

// ---------- Tipos ----------
type Opcion = { nombre: string; precio: number };
type Item = { id: number; categoria: string; nombre: string; descripcion: string; opciones: Opcion[]; disponible: boolean; admite_mitad: boolean; orden: number };
type Neg = { id: string; nombre: string; config: Record<string, any> };
type Linea = { item_id: number; opcion: string; cantidad: number; mitad_id?: number | null; nota?: string };
type LineaOk = Linea & { nombre: string; precio_unit: number; subtotal: number };
type Datos = { nombre?: string | null; tipo?: "retiro" | "delivery" | null; direccion?: string | null; entre_calles?: string | null; referencia?: string | null; pago?: "efectivo" | "transferencia" | null; paga_con?: number | null; notas?: string | null };
type Chat = { negocio: string; telefono: string; historial: { r: string; t: string }[]; carrito: { lineas?: Linea[]; datos?: Datos }; esperando_confirmacion: boolean; ids_procesados: string[]; modo?: string; actualizado?: string };

const $ = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");

// ---------- Datos ----------
async function negocio(id: string): Promise<Neg | null> {
  const { data } = await db.from("resto_negocios").select("*").eq("id", id).maybeSingle();
  return data;
}
async function menu(neg: string): Promise<Item[]> {
  const { data } = await db.from("resto_menu").select("*").eq("negocio", neg).order("orden");
  return (data ?? []) as Item[];
}
async function cargarChat(neg: string, tel: string): Promise<Chat> {
  const { data } = await db.from("resto_chats").select("*").eq("negocio", neg).eq("telefono", tel).maybeSingle();
  return data ?? { negocio: neg, telefono: tel, historial: [], carrito: {}, esperando_confirmacion: false, ids_procesados: [] };
}
async function guardarChat(ch: Chat) {
  ch.historial = ch.historial.slice(-40);
  ch.ids_procesados = ch.ids_procesados.slice(-50);
  await db.from("resto_chats").upsert({ ...ch, actualizado: new Date().toISOString() });
}

// ---------- Green-API ----------
async function green(cfg: Record<string, any>, metodo: string, body: unknown) {
  const token = Deno.env.get(cfg.green_token_secret) ?? "";
  const r = await fetch(`${cfg.green_url}/waInstance${cfg.green_id}/${metodo}/${token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) console.error("green", metodo, r.status, t.slice(0, 300));
  return t;
}
const enviar = (cfg: Record<string, any>, chatId: string, message: string) => green(cfg, "sendMessage", { chatId, message });

// ---------- Carta ----------
function cartaTexto(items: Item[]) {
  let out = "", cat = "";
  for (const it of items) {
    if (it.categoria !== cat) { cat = it.categoria; out += `\n*${cat}*\n`; }
    const precios = it.opciones.map((o) => (it.opciones.length > 1 ? `${o.nombre} ${$(o.precio)}` : $(o.precio))).join(" · ");
    out += it.disponible ? `• ${it.nombre} — ${precios}` : `• ~${it.nombre}~ _(sin stock hoy)_`;
    if (it.descripcion && it.disponible) out += `\n   _${it.descripcion}_`;
    out += "\n";
  }
  return out.trim();
}
function cartaParaIA(items: Item[]) {
  return items.map((it) =>
    `[id ${it.id}] ${it.categoria} · ${it.nombre}${it.descripcion ? ` (${it.descripcion})` : ""} · ` +
    it.opciones.map((o) => `${o.nombre}: ${o.precio}`).join(" | ") +
    (it.admite_mitad ? " · admite mitad y mitad" : "") +
    (it.disponible ? "" : " · *** SIN STOCK: NO SE PUEDE PEDIR ***")
  ).join("\n");
}

// ---------- Validación del carrito (los precios salen de la base) ----------
function validar(lineas: Linea[], items: Item[]) {
  const ok: LineaOk[] = [], problemas: string[] = [];
  const porId = new Map(items.map((i) => [i.id, i]));
  for (const l of lineas ?? []) {
    const it = porId.get(Number(l.item_id));
    const cant = Math.max(1, Math.min(50, Math.round(Number(l.cantidad) || 1)));
    if (!it) continue;
    if (!it.disponible) { problemas.push(`${it.nombre} no tiene stock ahora`); continue; }
    const op = it.opciones.find((o) => o.nombre.toLowerCase() === String(l.opcion ?? "").toLowerCase()) ?? (it.opciones.length === 1 ? it.opciones[0] : null);
    if (!op) { problemas.push(`falta elegir el tamaño de ${it.nombre}`); continue; }
    let nombre = `${it.nombre}`, precio = op.precio;
    if (l.mitad_id) {
      const m = porId.get(Number(l.mitad_id));
      const mop = m?.opciones.find((o) => o.nombre === op.nombre);
      if (!m || !it.admite_mitad || !m.admite_mitad || !mop) { problemas.push(`${it.nombre} no se puede combinar así`); continue; }
      if (!m.disponible) { problemas.push(`${m.nombre} no tiene stock ahora`); continue; }
      nombre = `Mitad ${it.nombre} / mitad ${m.nombre}`;
      precio = Math.max(op.precio, mop.precio); // se cobra la mitad más cara
    }
    if (it.opciones.length > 1 || l.mitad_id) nombre += ` (${op.nombre})`;
    ok.push({ item_id: it.id, opcion: op.nombre, cantidad: cant, mitad_id: l.mitad_id ?? null, nota: (l.nota ?? "").slice(0, 200), nombre, precio_unit: precio, subtotal: precio * cant });
  }
  return { ok, problemas };
}
function totales(lineas: LineaOk[], d: Datos, cfg: Record<string, any>) {
  const subtotal = lineas.reduce((a, l) => a + l.subtotal, 0);
  const envio = d.tipo === "delivery" ? Number(cfg.envio_costo ?? 0) : 0;
  return { subtotal, envio, total: subtotal + envio };
}
function faltante(lineas: LineaOk[], d: Datos, cfg: Record<string, any>): string | null {
  if (!lineas.length) return "¿Qué te gustaría pedir?";
  if (!d.tipo) return cfg.delivery_activo ? "¿Lo pasás a buscar o te lo enviamos?" : "Hoy solo tenemos retiro en el local, ¿te sirve?";
  if (d.tipo === "delivery" && !cfg.delivery_activo) return "Ahora mismo el delivery está pausado 🙏 ¿Lo podés pasar a buscar?";
  if (!d.nombre) return "¿A nombre de quién va el pedido?";
  if (d.tipo === "delivery" && !d.direccion) return "¿A qué dirección te lo enviamos? (calle, número y entre calles si podés)";
  if (!d.pago) return "¿Cómo lo vas a pagar: efectivo o transferencia?";
  return null;
}
function resumen(lineas: LineaOk[], d: Datos, cfg: Record<string, any>) {
  const t = totales(lineas, d, cfg);
  let s = "📝 *Tu pedido*\n";
  for (const l of lineas) s += `${l.cantidad}x ${l.nombre} — ${$(l.subtotal)}${l.nota ? `\n   _${l.nota}_` : ""}\n`;
  s += `\nSubtotal: ${$(t.subtotal)}`;
  if (d.tipo === "delivery") s += `\nEnvío: ${$(t.envio)}`;
  s += `\n*Total: ${$(t.total)}*\n\n`;
  s += d.tipo === "delivery"
    ? `🛵 Delivery a ${d.direccion}${d.entre_calles ? ` (${d.entre_calles})` : ""}${d.referencia ? `\n   Ref: ${d.referencia}` : ""}\n`
    : `🏃 Retiro en el local (${cfg.direccion})\n`;
  s += `👤 A nombre de ${d.nombre}\n`;
  if (d.pago === "efectivo") s += d.paga_con && d.paga_con >= t.total ? `💵 Efectivo (pagás con ${$(d.paga_con)}, vuelto ${$(d.paga_con - t.total)})\n` : `💵 Efectivo — ¿con cuánto pagás? así te llevamos el vuelto\n`;
  else s += `🏦 Transferencia\n`;
  if (d.notas) s += `🗒️ ${d.notas}\n`;
  s += `⏱️ Demora estimada: ${d.tipo === "delivery" ? cfg.demora_delivery : cfg.demora_retiro} min\n\n¿Lo confirmamos? Respondé *sí* o decime qué cambio.`;
  return s;
}
function subtotalTexto(lineas: LineaOk[], d: Datos, cfg: Record<string, any>) {
  const t = totales(lineas, d, cfg);
  let s = "🧾 *Tu pedido hasta ahora*\n";
  for (const l of lineas) s += `${l.cantidad}x ${l.nombre} — ${$(l.subtotal)}${l.nota ? ` _(${l.nota})_` : ""}\n`;
  s += `*Subtotal: ${$(t.subtotal)}*`;
  if (d.tipo === "delivery") s += `\n+ envío ${$(t.envio)} = *${$(t.total)}*`;
  else if (!d.tipo && cfg.delivery_activo) s += `\n_(si es delivery se suman ${$(cfg.envio_costo)} de envío)_`;
  return s;
}

// ---------- Gemini ----------
function horaAR() {
  return new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", weekday: "long", hour: "2-digit", minute: "2-digit" });
}
function sistema(neg: Neg, items: Item[], ch: Chat, cliente: any, activos: any[], lineasOk: LineaOk[]) {
  const c = neg.config;
  return `Sos quien atiende el WhatsApp de pedidos de *${neg.nombre}* (${c.direccion}). Hablás en español rioplatense, de vos, cálido y ágil, como un buen encargado de mostrador. Mensajes cortos (máximo 5 líneas), emojis con moderación. Nunca digas que sos una IA salvo que te lo pregunten directo.

ESTADO DEL LOCAL AHORA (lo maneja el local desde su panel, respetalo siempre):
- Abierto para pedidos: ${c.abierto ? "SÍ" : "NO (respondé dudas, pero no tomes pedidos; decí el horario)"}
- Delivery: ${c.delivery_activo ? `activo · envío ${$(c.envio_costo)} · zona: ${c.zona_envio}` : "PAUSADO por mucha demanda: solo retiro en el local"}
- Demora actual: retiro ${c.demora_retiro} min · delivery ${c.demora_delivery} min
- Horarios: ${c.horarios}
- Pago: efectivo o transferencia (alias ${c.alias}, a nombre de ${c.titular_alias}). No hay Mercado Pago ni tarjeta por WhatsApp.
- ${c.notas ?? ""}
- Día y hora: ${horaAR()}

CARTA (precios en pesos; el id sirve para armar el carrito):
${cartaParaIA(items)}

CLIENTE: ${cliente ? `conocido · nombre ${cliente.nombre ?? "?"} · última dirección ${cliente.direccion ?? "-"}${cliente.entre_calles ? ` (${cliente.entre_calles})` : ""} · pedidos anteriores ${cliente.pedidos} · último pedido: ${(cliente.ultimo_pedido?.items ?? []).map((l: any) => `${l.cantidad}x ${l.nombre}`).join(", ") || "-"}. Saludalo por el nombre y, si viene a pedir, ofrecé repetir el último pedido o usar la misma dirección.` : "nuevo"}
${activos.length ? `PEDIDOS EN CURSO DE ESTE CLIENTE: ${activos.map((p) => `#${p.numero} (${p.estado}, hecho ${new Date(p.creado).toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit" })}, total ${$(p.total)})`).join("; ")}. Si pregunta por su pedido, contale el estado.` : ""}

CARRITO ACTUAL (validado por el sistema): ${lineasOk.length ? lineasOk.map((l) => `${l.cantidad}x ${l.nombre}${l.nota ? ` [${l.nota}]` : ""}`).join("; ") : "vacío"}
DATOS ACTUALES: ${JSON.stringify(ch.carrito.datos ?? {})}
${ch.esperando_confirmacion ? "YA LE MANDASTE EL RESUMEN Y ESTÁS ESPERANDO QUE CONFIRME. Si dice que sí (sí, dale, ok, confirmo, de una…) usá accion \"confirmar\". Si pide un cambio, aplicalo y volvé a pedir confirmación." : ""}

CÓMO TRABAJÁS:
1. Ayudá a elegir: recomendá, explicá tamaños (individual o de 8 porciones), mitad y mitad (se cobra la mitad más cara, mismo tamaño), gustos de empanadas (van en "nota", ej. "3 carne, 3 pollo").
2. Si piden algo SIN STOCK, decilo con amabilidad y ofrecé una alternativa parecida. Nunca lo agregues al carrito. Seguí atendiendo normal.
3. Si piden algo que no está en la carta, decí que no lo tienen y sugerí algo de la carta.
4. Para cerrar necesitás: productos, retiro o delivery, nombre, dirección (si es delivery; entre calles y referencia ayudan) y forma de pago (efectivo o transferencia). Pedí lo que falte de a una o dos cosas por mensaje, sin interrogatorio. NO preguntes con cuánto paga en efectivo: eso se pregunta solo en el resumen final, cuando ya vio el total.
4b. SUBTOTAL Y ALGO MÁS: cuando el cliente terminó de elegir la comida principal (dice "nada más", "eso", "listo", o ya pidió lo suyo), y también SIEMPRE que pregunte el precio del pedido, cuánto va o el total, poné "mostrar_subtotal": true. El sistema le manda el detalle con el subtotal ANTES de tu mensaje, así que en "respuesta" no escribas montos del pedido: preguntá si quiere sumar algo más o cerramos, con UNA sugerencia concreta de algo que no tenga (una bebida si no pidió, un flan casero o la torta del día de postre, o fainá para acompañar la pizza). Ofrecelo una sola vez por pedido y sin insistir.
5. Cuando tengas TODO, usá accion "pedir_confirmacion": el sistema le manda solo el resumen con el total, así que en "respuesta" poné solo una frase corta (ej. "¡Perfecto! Te paso el resumen 👇"). NUNCA escribas totales vos: los calcula el sistema.
6. Si pide la carta o el menú, poné "enviar_menu": true (el sistema manda la carta completa) y en respuesta algo corto.
7. Si quiere cancelar lo que estaba armando (todavía sin confirmar): accion "cancelar". Si es un pedido YA confirmado, seguí la regla 9.
8. Si manda un audio, entendelo y escribí qué dijo en "transcripcion".
9. PROBLEMAS → PERSONA: si el cliente tiene un problema con un pedido (llegó mal o incompleto, frío, se demoró mucho, cobro equivocado), se queja, pide hablar con una persona o el encargado, quiere cancelar o cambiar un pedido YA confirmado, o pregunta algo que no podés resolver con lo que sabés: completá "derivar" con el tipo y un resumen claro para el encargado (qué pasó y qué pide, con el número de pedido si lo sabés). En "respuesta" pedí disculpas breve y decí que ya le pasaste el mensaje al encargado y que le responde por este mismo chat en unos minutos. NO prometas reenvíos, descuentos, reintegros ni tiempos: eso lo decide el local.

Respondé SIEMPRE con este JSON y nada más:
{"transcripcion": string|null, "respuesta": string, "enviar_menu": boolean, "mostrar_subtotal": boolean,
 "derivar": null | {"tipo": "reclamo"|"hablar_con_persona"|"cancelar_pedido"|"otro", "resumen": string},
 "carrito": [{"item_id": number, "opcion": string, "cantidad": number, "mitad_id": number|null, "nota": string}],
 "datos": {"nombre": string|null, "tipo": "retiro"|"delivery"|null, "direccion": string|null, "entre_calles": string|null, "referencia": string|null, "pago": "efectivo"|"transferencia"|null, "paga_con": number|null, "notas": string|null},
 "accion": "seguir"|"pedir_confirmacion"|"confirmar"|"cancelar"}
"carrito" es SIEMPRE el carrito completo actualizado (no solo lo nuevo). "datos" también completo (conservá lo que ya sabías).`;
}

function ordenar(h: { r: string; t: string }[]) {
  const out: { role: string; parts: any[] }[] = [];
  for (const m of h) {
    const role = m.r === "u" ? "user" : "model";
    const t = m.r === "l" ? `[mensaje escrito por el encargado del local] ${m.t}` : m.t;
    if (!out.length && role === "model") continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + t;
    else out.push({ role, parts: [{ text: t }] });
  }
  return out;
}
async function ia(sys: string, hist: { r: string; t: string }[], audios: { b64: string; mime: string }[] = []) {
  const contents = ordenar(hist);
  if (audios.length) {
    const parts = audios.map((a) => ({ inlineData: { mimeType: a.mime, data: a.b64 } }));
    const last = contents[contents.length - 1];
    if (last?.role === "user") last.parts.push(...parts); else contents.push({ role: "user", parts: [{ text: "[audio]" }, ...parts] });
  }
  for (let intento = 0; intento < 3; intento++) {
    // Sin "pensar" responde en 1-3 s; si el modelo no lo acepta, se reintenta normal
    const gen: Record<string, unknown> = { temperature: 0.4, maxOutputTokens: 8192, responseMimeType: "application/json" };
    if (intento === 0) gen.thinkingConfig = { thinkingBudget: 0 };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: gen }),
    });
    if (!r.ok) { console.error("Gemini", r.status, (await r.text()).slice(0, 300)); continue; }
    const j = await r.json();
    const txt = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    try { return JSON.parse(txt.replace(/^```json\s*|```$/g, "").trim()); } catch { console.error("JSON IA", txt.slice(0, 300)); }
  }
  return null;
}

// ---------- Mensaje entrante ----------
async function bajarAudio(url: string, mime?: string) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { b64: btoa(bin), mime: (mime ?? "audio/ogg").split(";")[0] };
}

// Cola: si el cliente manda varios mensajes seguidos (texto + audio), se esperan 2 s y se responden juntos.
async function entrada(neg: Neg, b: any) {
  const chatId: string = b?.senderData?.chatId ?? "";
  if (!(neg.config.permitidos ?? []).includes(chatId)) return; // demo cerrada: solo números de prueba
  const { data: fila, error } = await db.from("resto_cola").insert({ negocio: neg.id, telefono: chatId, id_mensaje: b.idMessage ?? null, payload: b }).select("id").single();
  if (error || !fila) return; // repetido (Green a veces reenvía)
  await new Promise((r) => setTimeout(r, 2000));
  const { data: nuevo } = await db.from("resto_cola").select("id").eq("negocio", neg.id).eq("telefono", chatId).eq("procesado", false).gt("id", fila.id).limit(1);
  if (nuevo?.length) return; // llegó otro después: lo procesa ese
  const { data: lote } = await db.from("resto_cola").update({ procesado: true }).eq("negocio", neg.id).eq("telefono", chatId).eq("procesado", false).lte("id", fila.id).select("payload,id");
  if (!lote?.length) return;
  await procesar(neg, chatId, lote.sort((x, y) => x.id - y.id).map((x) => x.payload));
}

async function procesar(neg: Neg, chatId: string, mensajes: any[]) {
  const cfg = neg.config;
  const ch = await cargarChat(neg.id, chatId);

  // Charla vieja (más de 4 h sin actividad) → carrito nuevo
  if (ch.actualizado && Date.now() - new Date(ch.actualizado).getTime() > 4 * 3600_000) {
    ch.carrito = {}; ch.esperando_confirmacion = false; ch.historial = ch.historial.slice(-6);
  }

  // Un reclamo abierto: el bot no contesta, los mensajes van al panel para que responda el local
  if (ch.modo === "humano") {
    for (const b of mensajes) {
      const md = b.messageData ?? {};
      const t = md.textMessageData?.textMessage ?? md.extendedTextMessageData?.text ??
        (md.typeMessage === "audioMessage" ? "[🎤 audio]" : md.typeMessage === "imageMessage" ? "[📷 imagen]" : `[${md.typeMessage}]`);
      ch.historial.push({ r: "u", t });
    }
    const { data: al } = await db.from("resto_alertas").select("id,no_leidos").eq("negocio", neg.id).eq("telefono", chatId).eq("estado", "abierta").order("id", { ascending: false }).limit(1).maybeSingle();
    if (al) await db.from("resto_alertas").update({ no_leidos: al.no_leidos + mensajes.length, actualizado: new Date().toISOString() }).eq("id", al.id);
    return guardarChat(ch);
  }

  const textos: string[] = [], audios: { b64: string; mime: string }[] = [];
  for (const b of mensajes) {
  const md = b.messageData ?? {};
  let texto = "";
  const tipo = md.typeMessage;
  if (tipo === "textMessage") texto = md.textMessageData?.textMessage ?? "";
  else if (tipo === "extendedTextMessage" || tipo === "quotedMessage") texto = md.extendedTextMessageData?.text ?? "";
  else if (tipo === "audioMessage") {
    const a = await bajarAudio(md.fileMessageData?.downloadUrl, md.fileMessageData?.mimeType);
    if (a) { audios.push(a); texto = "[mandó un audio]"; }
  } else if (tipo === "imageMessage" || tipo === "documentMessage") {
    // Probablemente el comprobante de la transferencia
    const { data: ult } = await db.from("resto_pedidos").select("id,numero,pago").eq("negocio", neg.id).eq("telefono", chatId)
      .neq("estado", "cancelado").order("creado", { ascending: false }).limit(1).maybeSingle();
    if (ult?.pago === "transferencia") {
      await db.from("resto_pedidos").update({ comprobante_url: md.fileMessageData?.downloadUrl ?? "recibido", actualizado: new Date().toISOString() }).eq("id", ult.id);
      const m = `¡Gracias! 🙌 Recibimos el comprobante del pedido *#${ult.numero}*. Ya lo ve el local.`;
      ch.historial.push({ r: "u", t: "[mandó el comprobante]" }, { r: "b", t: m });
      await enviar(cfg, chatId, m); continue;
    }
    texto = `[mandó una ${tipo === "imageMessage" ? "imagen" : "archivo"}${md.fileMessageData?.caption ? `: ${md.fileMessageData.caption}` : ""}]`;
  } else if (tipo === "locationMessage") {
    const l = md.locationMessageData ?? {};
    texto = `[mandó su ubicación: ${l.nameLocation ?? ""} ${l.address ?? ""} (${l.latitude}, ${l.longitude})]`;
  }
  if (texto.trim()) textos.push(texto.trim());
  }
  if (!textos.length) { await guardarChat(ch); return; }
  const texto = textos.join("\n");
  const audio = audios.length ? audios : null;

  const items = await menu(neg.id);
  const { data: cliente } = await db.from("resto_clientes").select("*").eq("negocio", neg.id).eq("telefono", chatId).maybeSingle();
  const { data: activos } = await db.from("resto_pedidos").select("numero,estado,total,creado").eq("negocio", neg.id).eq("telefono", chatId)
    .in("estado", ["nuevo", "preparacion", "listo", "en_camino"]).gte("creado", new Date(Date.now() - 12 * 3600_000).toISOString());
  const actual = validar(ch.carrito.lineas ?? [], items).ok;

  ch.historial.push({ r: "u", t: texto });
  const out = await ia(sistema(neg, items, ch, cliente, activos ?? [], actual), ch.historial.slice(-24), audios);
  if (!out) { await enviar(cfg, chatId, "Perdón, se me trabó el sistema un segundo 😅 ¿Me lo repetís?"); await guardarChat(ch); return; }
  if (audio && out.transcripcion) ch.historial[ch.historial.length - 1].t = texto.replace(/\[mandó un audio\]/, `[audio] ${out.transcripcion}`);

  const datos: Datos = { ...(ch.carrito.datos ?? {}), ...Object.fromEntries(Object.entries(out.datos ?? {}).filter(([, v]) => v !== null && v !== "")) };
  const { ok: lineas, problemas } = validar(out.carrito ?? [], items);
  const cambio = JSON.stringify(lineas.map((l) => [l.item_id, l.opcion, l.cantidad, l.mitad_id, l.nota])) !== JSON.stringify(actual.map((l) => [l.item_id, l.opcion, l.cantidad, l.mitad_id, l.nota]));
  ch.carrito = { lineas: lineas.map(({ item_id, opcion, cantidad, mitad_id, nota }) => ({ item_id, opcion, cantidad, mitad_id, nota })), datos };

  let respuesta: string = (out.respuesta ?? "").trim();
  if (problemas.length) respuesta += `\n\n⚠️ Ojo: ${problemas.join("; ")}.`;

  // Problema que tiene que ver una persona → alerta al local y el bot se corre
  if (out.derivar && out.derivar.resumen) {
    const { data: ult } = await db.from("resto_pedidos").select("numero").eq("negocio", neg.id).eq("telefono", chatId)
      .gte("creado", new Date(Date.now() - 24 * 3600_000).toISOString()).order("creado", { ascending: false }).limit(1).maybeSingle();
    const tipo = ["reclamo", "hablar_con_persona", "cancelar_pedido", "otro"].includes(out.derivar.tipo) ? out.derivar.tipo : "otro";
    const nombre = datos.nombre ?? cliente?.nombre ?? null;
    await db.from("resto_alertas").insert({ negocio: neg.id, telefono: chatId, cliente_nombre: nombre, pedido_numero: ult?.numero ?? null, tipo, resumen: String(out.derivar.resumen).slice(0, 500), no_leidos: 1 });
    ch.modo = "humano"; ch.esperando_confirmacion = false;
    await mandar(cfg, ch, respuesta || "Perdón por el inconveniente 🙏 Ya le pasé tu mensaje al encargado y te responde por acá en unos minutos.");
    if (cfg.celular_reclamos) {
      const tit = { reclamo: "⚠️ *Reclamo*", hablar_con_persona: "🙋 *Quiere hablar con alguien*", cancelar_pedido: "❌ *Quiere cancelar un pedido*", otro: "💬 *Consulta para el local*" }[tipo];
      await enviar(cfg, `${String(cfg.celular_reclamos).replace(/\D/g, "")}@c.us`,
        `${tit} · ${neg.nombre}\n👤 ${nombre ?? "Cliente"} (+${chatId.split("@")[0]})${ult ? `\n🧾 Pedido #${ult.numero}` : ""}\n\n"${out.derivar.resumen}"\n\nEl bot dejó de responderle. Contestale desde el panel: ${cfg.panel_url ?? "kiondaia.com/unapizza"}`);
    }
    return guardarChat(ch);
  }

  if (out.enviar_menu) await enviar(cfg, chatId, `🍕 *Carta de ${neg.nombre}*\n${cartaTexto(items)}`);

  // Cancelar lo que se estaba armando
  if (out.accion === "cancelar") {
    ch.carrito = { datos: { nombre: datos.nombre, direccion: datos.direccion, entre_calles: datos.entre_calles, referencia: datos.referencia } };
    ch.esperando_confirmacion = false;
    await mandar(cfg, ch, respuesta || "Listo, lo cancelé. Cuando quieras armamos otro 👍");
    return guardarChat(ch);
  }

  // Confirmar → se crea la comanda
  if (out.accion === "confirmar" && ch.esperando_confirmacion && !cambio && cfg.abierto) {
    const falta = faltante(lineas, datos, cfg);
    if (!falta) {
      const num = await crearPedido(neg, chatId, lineas, datos, !!cliente);
      ch.carrito = { datos: { nombre: datos.nombre, direccion: datos.direccion, entre_calles: datos.entre_calles, referencia: datos.referencia } };
      ch.esperando_confirmacion = false;
      const t = totales(lineas, datos, cfg);
      let m = `✅ ¡Pedido confirmado! Es el *#${num}* 🍕\nTotal: *${$(t.total)}* · Demora estimada: ${datos.tipo === "delivery" ? cfg.demora_delivery : cfg.demora_retiro} min.\n`;
      if (datos.pago === "transferencia") m += `\n🏦 Transferí a *${cfg.alias}* (${cfg.titular_alias}) y mandá el comprobante por acá.\n`;
      else if (datos.paga_con && datos.paga_con > t.total) m += `💵 Pagás con ${$(datos.paga_con)} → te llevamos ${$(datos.paga_con - t.total)} de vuelto.\n`;
      m += `\nTe aviso por acá cuando ${datos.tipo === "delivery" ? "salga para tu casa" : "esté listo para retirar"}. ¡Gracias!`;
      await mandar(cfg, ch, m);
      return guardarChat(ch);
    }
  }

  // Pedir confirmación → el resumen y el total los arma el sistema
  if (out.accion === "pedir_confirmacion" || (out.accion === "confirmar" && (!ch.esperando_confirmacion || cambio))) {
    if (!cfg.abierto) {
      ch.esperando_confirmacion = false;
      await mandar(cfg, ch, (respuesta ? respuesta + "\n\n" : "") + `Ahora estamos cerrados 🙏 ${cfg.horarios}`);
      return guardarChat(ch);
    }
    const falta = faltante(lineas, datos, cfg);
    if (falta) { ch.esperando_confirmacion = false; await mandar(cfg, ch, respuesta ? `${respuesta}\n\n${falta}` : falta); return guardarChat(ch); }
    if (respuesta) await mandar(cfg, ch, respuesta);
    ch.esperando_confirmacion = true;
    await mandar(cfg, ch, resumen(lineas, datos, cfg));
    return guardarChat(ch);
  }

  if (cambio) ch.esperando_confirmacion = false;
  if (out.mostrar_subtotal && lineas.length) await mandar(cfg, ch, subtotalTexto(lineas, datos, cfg));
  await mandar(cfg, ch, respuesta || "¿En qué te puedo ayudar? 😊");
  await guardarChat(ch);
}
async function mandar(cfg: Record<string, any>, ch: Chat, m: string) {
  ch.historial.push({ r: "b", t: m });
  await enviar(cfg, ch.telefono, m);
}

async function crearPedido(neg: Neg, tel: string, lineas: LineaOk[], d: Datos, conocido: boolean) {
  const t = totales(lineas, d, neg.config);
  const { data: num } = await db.rpc("resto_nuevo_numero", { p_negocio: neg.id });
  const fila = {
    negocio: neg.id, numero: num, telefono: tel, cliente_nombre: d.nombre, items: lineas,
    subtotal: t.subtotal, envio: t.envio, total: t.total, tipo: d.tipo,
    direccion: d.tipo === "delivery" ? d.direccion : null, entre_calles: d.tipo === "delivery" ? d.entre_calles : null, referencia: d.tipo === "delivery" ? d.referencia : null,
    pago: d.pago, paga_con: d.pago === "efectivo" ? d.paga_con : null, notas: d.notas,
    demora_min: d.tipo === "delivery" ? neg.config.demora_delivery : neg.config.demora_retiro, cliente_conocido: conocido,
  };
  const { error } = await db.from("resto_pedidos").insert(fila);
  if (error) console.error("insert pedido", error);
  const { data: prev } = await db.from("resto_clientes").select("pedidos").eq("negocio", neg.id).eq("telefono", tel).maybeSingle();
  await db.from("resto_clientes").upsert({
    negocio: neg.id, telefono: tel, nombre: d.nombre,
    ...(d.tipo === "delivery" ? { direccion: d.direccion, entre_calles: d.entre_calles, referencia: d.referencia } : {}),
    pedidos: (prev?.pedidos ?? 0) + 1, ultimo_pedido: { numero: num, items: lineas, total: t.total }, actualizado: new Date().toISOString(),
  });
  return num;
}

// ---------- Panel ----------
const AVISOS: Record<string, (p: any, cfg: any) => string> = {
  preparacion: (p) => `👨‍🍳 Tu pedido *#${p.numero}* ya está en preparación.`,
  listo: (p, cfg) => p.tipo === "retiro" ? `✅ ¡Tu pedido *#${p.numero}* está listo! Podés pasar a buscarlo por ${cfg.direccion}.` : `✅ Tu pedido *#${p.numero}* está listo y sale enseguida.`,
  en_camino: (p) => `🛵 ¡Tu pedido *#${p.numero}* ya salió! En unos minutos está en tu casa.${p.pago === "efectivo" ? ` Total a pagar: ${$(p.total)}.` : ""}`,
  entregado: (p) => `¡Gracias por tu pedido *#${p.numero}*! Que lo disfrutes 🍕`,
  cancelado: (p) => `😔 Tu pedido *#${p.numero}* fue cancelado por el local. Si querés, escribinos y lo vemos.`,
};
function inicioDia() {
  // El "día" del local arranca a las 6 de la mañana (hora Argentina, UTC-3)
  const ar = new Date(Date.now() - 3 * 3600_000 - 6 * 3600_000);
  return new Date(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate(), 9)).toISOString();
}
function publico(cfg: Record<string, any>) {
  const { green_url, green_id, green_token_secret, webhook_key, panel_pin, permitidos, ...rest } = cfg;
  return rest;
}
async function panel(neg: Neg, body: any) {
  const cfg = neg.config;
  if (String(body.pin ?? "") !== String(cfg.panel_pin)) { await new Promise((r) => setTimeout(r, 800)); return { error: "PIN incorrecto" }; }
  const a = body.accion;
  if (a === "estado_pedido") {
    const est = String(body.estado);
    if (!AVISOS[est] && est !== "nuevo") return { error: "estado inválido" };
    const { data: p } = await db.from("resto_pedidos").update({ estado: est, actualizado: new Date().toISOString() }).eq("negocio", neg.id).eq("id", body.id).select().maybeSingle();
    if (p && AVISOS[est] && body.avisar !== false && !p.ejemplo && (cfg.permitidos ?? []).includes(p.telefono)) {
      const m = AVISOS[est](p, cfg);
      await enviar(cfg, p.telefono, m);
      const ch = await cargarChat(neg.id, p.telefono); ch.historial.push({ r: "b", t: m }); await guardarChat(ch);
    }
    return { ok: true };
  }
  if (a === "config") {
    const permitidas = ["abierto", "delivery_activo", "demora_retiro", "demora_delivery", "envio_costo", "celular_reclamos"];
    const nuevo = { ...cfg };
    for (const k of permitidas) if (k in (body.cambios ?? {})) nuevo[k] = body.cambios[k];
    await db.from("resto_negocios").update({ config: nuevo }).eq("id", neg.id);
    return { ok: true, config: publico(nuevo) };
  }
  if (a === "item") {
    const cambios: Record<string, unknown> = {};
    if ("disponible" in body) cambios.disponible = !!body.disponible;
    if (Array.isArray(body.opciones)) cambios.opciones = body.opciones.map((o: any) => ({ nombre: String(o.nombre), precio: Math.max(0, Number(o.precio) || 0) }));
    await db.from("resto_menu").update(cambios).eq("negocio", neg.id).eq("id", body.id);
    return { ok: true };
  }
  if (a === "chat") {
    const ch = await cargarChat(neg.id, String(body.telefono));
    await db.from("resto_alertas").update({ no_leidos: 0 }).eq("negocio", neg.id).eq("telefono", ch.telefono).eq("estado", "abierta");
    return { historial: ch.historial, modo: ch.modo ?? "bot" };
  }
  if (a === "responder") {
    const tel = String(body.telefono), txt = String(body.texto ?? "").trim().slice(0, 2000);
    if (!txt) return { error: "mensaje vacío" };
    const ch = await cargarChat(neg.id, tel);
    ch.historial.push({ r: "l", t: txt }); ch.modo = "humano";
    if (!tel.startsWith("ejemplo") && (cfg.permitidos ?? []).includes(tel)) await enviar(cfg, tel, txt);
    await guardarChat(ch);
    await db.from("resto_alertas").update({ no_leidos: 0, actualizado: new Date().toISOString() }).eq("negocio", neg.id).eq("telefono", tel).eq("estado", "abierta");
    return { ok: true };
  }
  if (a === "resolver") {
    const tel = String(body.telefono);
    await db.from("resto_alertas").update({ estado: "resuelta", no_leidos: 0, resuelto: new Date().toISOString() }).eq("negocio", neg.id).eq("telefono", tel).eq("estado", "abierta");
    const ch = await cargarChat(neg.id, tel); ch.modo = "bot"; ch.esperando_confirmacion = false; ch.carrito = { datos: ch.carrito.datos };
    ch.historial.push({ r: "b", t: "[El local resolvió el tema y el bot vuelve a atender]" });
    await guardarChat(ch);
    return { ok: true };
  }
  if (a === "ejemplos") { await cargarEjemplos(neg); return { ok: true }; }
  if (a === "borrar_ejemplos") {
    await db.from("resto_pedidos").delete().eq("negocio", neg.id).eq("ejemplo", true);
    await db.from("resto_clientes").delete().eq("negocio", neg.id).eq("ejemplo", true);
    await db.from("resto_alertas").delete().eq("negocio", neg.id).eq("ejemplo", true);
    await db.from("resto_chats").delete().eq("negocio", neg.id).like("telefono", "ejemplo-%");
    return { ok: true };
  }
  if (a === "clientes") {
    const { data } = await db.from("resto_clientes").select("*").eq("negocio", neg.id).order("actualizado", { ascending: false }).limit(200);
    return { clientes: data ?? [] };
  }
  // "datos" (por defecto): todo lo que necesita la pantalla
  const desde = inicioDia();
  const [{ data: pedidos }, items, { data: alertas }] = await Promise.all([
    db.from("resto_pedidos").select("*").eq("negocio", neg.id).gte("creado", desde).order("creado", { ascending: false }),
    menu(neg.id),
    db.from("resto_alertas").select("*").eq("negocio", neg.id).or(`estado.eq.abierta,creado.gte.${desde}`).order("creado", { ascending: false }).limit(100),
  ]);
  return { nombre: neg.nombre, config: publico(cfg), pedidos: pedidos ?? [], menu: items, alertas: alertas ?? [], desde };
}

// ---------- Pedidos de ejemplo (para mostrar el panel lleno) ----------
async function cargarEjemplos(neg: Neg) {
  await db.from("resto_pedidos").delete().eq("negocio", neg.id).eq("ejemplo", true);
  await db.from("resto_clientes").delete().eq("negocio", neg.id).eq("ejemplo", true);
  await db.from("resto_alertas").delete().eq("negocio", neg.id).eq("ejemplo", true);
  await db.from("resto_chats").delete().eq("negocio", neg.id).like("telefono", "ejemplo-%");
  const items = await menu(neg.id);
  const id = (n: string) => items.find((i) => i.nombre === n)!.id;
  const L = (n: string, op: string, cant = 1, mitad?: string, nota = ""): Linea => ({ item_id: id(n), opcion: op, cantidad: cant, mitad_id: mitad ? id(mitad) : null, nota });
  const ej: { min: number; est: string; nom: string; tel: string; d: Datos; l: Linea[]; conocido?: boolean; comp?: boolean }[] = [
    { min: 2, est: "nuevo", nom: "Martina Gómez", tel: "1", d: { tipo: "delivery", direccion: "Colectora Este 2150, Barrio El Cazador", entre_calles: "entre Mendoza y Colón", referencia: "Portón negro, tocar timbre 2", pago: "efectivo", paga_con: 80000 }, l: [L("Muzzarella", "8 porciones", 1, "Calabresa"), L("Empanada", "Media docena", 1, undefined, "3 carne, 2 pollo, 1 jamón y queso"), L("Coca-Cola", "1,75 L")] },
    { min: 5, est: "nuevo", nom: "Diego Fernández", tel: "2", d: { tipo: "retiro", pago: "transferencia" }, l: [L("Fugazzetta rellena", "Entera"), L("Fainá", "Porción", 2)], conocido: true, comp: true },
    { min: 14, est: "preparacion", nom: "Sofía Ruiz", tel: "3", d: { tipo: "delivery", direccion: "Av. Villanueva 1420, Escobar", entre_calles: "y Belgrano", pago: "transferencia", notas: "Sin aceitunas en la napolitana" }, l: [L("Napolitana", "8 porciones"), L("Heineken", "Litro", 2)], comp: true },
    { min: 19, est: "preparacion", nom: "Juan Pablo Ortiz", tel: "4", d: { tipo: "retiro", pago: "efectivo", paga_con: 50000 }, l: [L("Cuatro quesos con miel y nueces", "8 porciones")], conocido: true },
    { min: 31, est: "listo", nom: "Carla Benítez", tel: "5", d: { tipo: "retiro", pago: "efectivo" }, l: [L("Jamón crudo Las Dinas", "Individual"), L("Agua sin gas", "Botella")] },
    { min: 38, est: "en_camino", nom: "Federico Luna", tel: "6", d: { tipo: "delivery", direccion: "Los Ceibos 845, Maschwitz", referencia: "Casa con rejas verdes", pago: "efectivo", paga_con: 100000 }, l: [L("Panceta y verdeo", "8 porciones", 1, "Provolone"), L("Empanada", "Docena", 1, undefined, "6 bondiola, 6 carne"), L("Flan casero", "Con crema o dulce de leche", 2)], conocido: true },
    { min: 64, est: "entregado", nom: "Valentina Sosa", tel: "7", d: { tipo: "delivery", direccion: "Mendoza 1980, Maschwitz", pago: "transferencia" }, l: [L("Muzzarella", "8 porciones", 2), L("Coca-Cola", "1,75 L")], comp: true },
    { min: 82, est: "entregado", nom: "Martín Acosta", tel: "8", d: { tipo: "retiro", pago: "efectivo" }, l: [L("Pepperoni", "8 porciones"), L("Imperial", "Lata", 2)] },
    { min: 95, est: "entregado", nom: "Lucía Herrera", tel: "9", d: { tipo: "delivery", direccion: "Independencia 455, Garín", pago: "efectivo", paga_con: 40000 }, l: [L("Espinaca con salsa blanca", "Individual"), L("Empanada", "Unidad", 2, undefined, "verdura")] },
    { min: 70, est: "cancelado", nom: "Nicolás Pereyra", tel: "10", d: { tipo: "delivery", direccion: "Ruta 26 km 3, Barrio Los Robles", pago: "efectivo" }, l: [L("Palmitos", "8 porciones")] },
  ];
  let num = (await db.rpc("resto_nuevo_numero", { p_negocio: neg.id })).data ?? 1;
  const ord = [...ej].sort((a, b) => b.min - a.min);
  for (const e of ord) {
    const { ok } = validar(e.l, items);
    const t = totales(ok, e.d, neg.config);
    const tel = `ejemplo-${e.tel}`;
    const creado = new Date(Date.now() - e.min * 60_000).toISOString();
    await db.from("resto_pedidos").insert({
      negocio: neg.id, numero: num++, telefono: tel, cliente_nombre: e.nom, items: ok, subtotal: t.subtotal, envio: t.envio, total: t.total,
      tipo: e.d.tipo, direccion: e.d.direccion ?? null, entre_calles: e.d.entre_calles ?? null, referencia: e.d.referencia ?? null,
      pago: e.d.pago, paga_con: e.d.paga_con ?? null, notas: e.d.notas ?? null, estado: e.est,
      demora_min: e.d.tipo === "delivery" ? neg.config.demora_delivery : neg.config.demora_retiro,
      cliente_conocido: !!e.conocido, comprobante_url: e.comp ? "ejemplo" : null, ejemplo: true, creado, actualizado: creado,
    });
    await db.from("resto_clientes").upsert({
      negocio: neg.id, telefono: tel, nombre: e.nom, direccion: e.d.direccion ?? null, entre_calles: e.d.entre_calles ?? null, referencia: e.d.referencia ?? null,
      pedidos: e.conocido ? 3 + (e.min % 5) : 1, ultimo_pedido: { items: ok, total: t.total }, ejemplo: true, actualizado: creado,
    });
    if (e.tel === "7") {
      // Reclamo de ejemplo sobre el pedido de Valentina
      const hace = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
      await db.from("resto_alertas").insert({ negocio: neg.id, telefono: tel, cliente_nombre: e.nom, pedido_numero: num - 1, tipo: "reclamo", resumen: "Le llegaron las 2 muzzas pero faltó la Coca de 1,75 L. Pide que se la manden o que se la descuenten.", no_leidos: 2, ejemplo: true, creado: hace(9), actualizado: hace(6) });
      await db.from("resto_chats").upsert({ negocio: neg.id, telefono: tel, modo: "humano", carrito: {}, esperando_confirmacion: false, ids_procesados: [], actualizado: hace(6), historial: [
        { r: "b", t: `🛵 ¡Tu pedido *#${num - 1}* ya salió! En unos minutos está en tu casa.` },
        { r: "u", t: "Hola, me llegaron las pizzas pero no vino la coca 😕" },
        { r: "b", t: "¡Uh, perdón Valentina! 🙏 Ya le pasé tu mensaje al encargado y te responde por acá en unos minutos." },
        { r: "u", t: "Dale, gracias. Si no me la pueden mandar descuéntenmela del próximo" },
      ] });
    }
  }
}

// ---------- Servidor ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const neg = await negocio(url.searchParams.get("n") ?? "");
  if (!neg) return new Response("no", { status: 404, headers: CORS });

  if (url.searchParams.get("panel")) {
    let body: any = {}; try { body = await req.json(); } catch { /* vacío */ }
    const r = await panel(neg, body);
    return new Response(JSON.stringify(r), { headers: { ...CORS, "content-type": "application/json" }, status: (r as any).error ? 401 : 200 });
  }

  if (url.searchParams.get("k") !== neg.config.webhook_key) return new Response("no", { status: 403 });
  if (req.method === "GET") {
    if (url.searchParams.get("setup")) {
      const r = await green(neg.config, "setSettings", {
        webhookUrl: `${BASE}/functions/v1/resto-wa?n=${neg.id}&k=${neg.config.webhook_key}`,
        incomingWebhook: "yes", outgoingWebhook: "no", outgoingMessageWebhook: "no", outgoingAPIMessageWebhook: "no", stateWebhook: "no",
      });
      return new Response(`setup: ${r}`);
    }
    if (url.searchParams.get("estado")) {
      const c = neg.config, tk = Deno.env.get(c.green_token_secret) ?? "";
      const r = await fetch(`${c.green_url}/waInstance${c.green_id}/getStateInstance/${tk}`);
      return new Response(`${r.status} ${await r.text()} · token cargado: ${tk ? "sí" : "NO"}`);
    }
    if (url.searchParams.get("ultimos")) {
      const c = neg.config, tk = Deno.env.get(c.green_token_secret) ?? "";
      const r = await fetch(`${c.green_url}/waInstance${c.green_id}/lastOutgoingMessages/${tk}?minutes=120`);
      return new Response(await r.text());
    }
    return new Response("resto-wa vivo");
  }
  let b: any; try { b = await req.json(); } catch { return new Response("ok"); }
  if (b?.typeWebhook === "incomingMessageReceived" && String(b?.senderData?.chatId ?? "").endsWith("@c.us")) {
    // @ts-ignore EdgeRuntime existe en Supabase
    EdgeRuntime.waitUntil(entrada(neg, b).catch((e) => console.error("procesar", e)));
  }
  return new Response("ok");
});
