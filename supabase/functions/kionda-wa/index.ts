// Kionda · Cerebro de WhatsApp vía Green-API (mismo número/instancia que Camorro)
// - Mensajes de GRUPOS → se reenvían tal cual a la función "camorro" (no cambia nada para la banda).
// - Chats PRIVADOS → solo responde a los números de la lista PERMITIDOS (bot vendedor + demo Doble As).
//   Cualquier otro chat privado se ignora: el bot NO le contesta a tus contactos.
// Opciones con ENCUESTAS (Green-API no tiene botones con QR).
// Lee la config de Green desde camorro_config (green_url, green_id, green_token, webhook_key).
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const BASE = Deno.env.get("SUPABASE_URL")!;
const PANEL = "https://kiondaia.com/dobleas/";
const IMG = "https://kiondaia.com/dobleas/ejemplo-service.jpg";

// Únicos chats privados a los que responde el bot
const PERMITIDOS: Record<string, string> = {
  "5491122968175@c.us": "Nicolás (Doble As)",
};

type Cfg = Record<string, string>;
async function config(): Promise<Cfg> {
  const { data } = await db.from("camorro_config").select("clave,valor");
  return Object.fromEntries((data ?? []).map((r) => [r.clave, r.valor]));
}

// ---------- Green-API ----------
async function green(c: Cfg, metodo: string, body: unknown) {
  const r = await fetch(`${c.green_url}/waInstance${c.green_id}/${metodo}/${c.green_token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) console.error("green", metodo, r.status, t.slice(0, 300));
  return t;
}
const texto = (c: Cfg, chatId: string, message: string) => green(c, "sendMessage", { chatId, message });
const encuesta = (c: Cfg, chatId: string, message: string, ops: string[]) =>
  green(c, "sendPoll", { chatId, message, options: ops.map((optionName) => ({ optionName })), multipleAnswers: false });
const imagen = (c: Cfg, chatId: string, urlFile: string, caption: string) =>
  green(c, "sendFileByUrl", { chatId, urlFile, fileName: "service.jpg", caption });

// ---------- Opciones ----------
const O = {
  probar: "🏍️ Probar el bot del taller",
  panel: "📊 Ver el panel",
  lucas: "🙋 Hablar con Lucas",
  aviso: "🔔 Ver un aviso de service",
  service: "🧾 Ver la imagen del service",
  salir: "↩️ Volver con Kionda",
  turno: "📅 Sí, quiero turno",
  semana: "⏰ Avisame la semana que viene",
};
const OP_VENDEDOR = [O.probar, O.panel, O.lucas];
const OP_DEMO = [O.aviso, O.service, O.salir];
const OP_AVISO = [O.turno, O.semana, O.salir];

// ---------- Personalidades ----------
const VENDEDOR = `Sos el asistente de ventas de kionda IA, la agencia de Lucas (Buenos Aires) que arma bots y apps con inteligencia artificial para negocios.
Estás hablando por WhatsApp con Nicolás, dueño de Doble As Taller de Motos (Miranda 4514, Floresta). Lucas ya trabajó con él antes. Escribís desde el WhatsApp de Lucas, y Nicolás sabe que sos un bot.
Objetivo: contarle el "Bot para talleres" y que lo pruebe o quiera hablar con Lucas.

Qué hace el producto:
- Bot de WhatsApp con el nombre y logo del taller. Responde consultas 24 h (horarios, dirección, servicios) y da turnos solo según los lugares que Nicolás defina por día.
- Recordatorios automáticos de service: cuando a un cliente le toca el cambio de aceite (por km o por tiempo, lo que llegue primero) le escribe y le ofrece turno. Así vuelven clientes que se olvidaban.
- Avisa al cliente cuando la moto está lista para retirar.
- Al cargar un service genera una imagen con el logo, los trabajos hechos y el próximo service, y se la manda al cliente.
- Presupuestos por WhatsApp que el cliente aprueba con un toque.
- Al día siguiente de entregar la moto le pide una reseña en Google.
- Panel desde el celu o la compu: clientes, historial de cada moto, motos en el taller, turnos, presupuestos y cuántos clientes volvieron gracias a los avisos. Demo: ${PANEL}

Reglas:
- Español rioplatense, cálido, de vos, sin lunfardo. Mensajes cortos (máximo 5 líneas), como un WhatsApp real.
- No inventes precios. Si pregunta, decí que arranca con un mes de prueba gratis y que Lucas le pasa la propuesta.
- Las opciones (probar, ver el panel, hablar con Lucas) van en una encuesta que se manda sola después de tu mensaje: no las enumeres, como mucho invitá a tocar una.
- Si no sabés algo, decí que lo consultás con Lucas. No hables de temas que no tengan que ver.`;

const DEMO = `Sos el bot de WhatsApp de Doble As Taller de Motos (Miranda 4514, Floresta, CABA). Horario: lunes a viernes de 9 a 18 y sábados de 9 a 13.
Servicios: mantenimiento, service, reparación, modificación y traslado.
ESTO ES UNA DEMO: quien te escribe está probando el bot como si fuera un cliente del taller. Su moto de ejemplo es una Honda CB 190R, patente A245KLM, último service hace 6 meses con 13.900 km.
Atendé como lo haría el taller: amable, claro, en español rioplatense de vos, mensajes cortos (máximo 4 líneas).
Turnos: ofrecé mañana o pasado a la mañana; cuando elija, confirmá el turno y decí que queda anotado en el panel del taller.
No des precios: decí que el taller se lo confirma.`;

// ---------- Gemini ----------
function ordenar(h: { r: string; t: string }[]) {
  const out: { role: string; parts: { text: string }[] }[] = [];
  for (const m of h) {
    const role = m.r === "u" ? "user" : "model";
    if (!out.length && role === "model") continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + m.t;
    else out.push({ role, parts: [{ text: m.t }] });
  }
  return out;
}
async function ia(sistema: string, historial: { r: string; t: string }[]) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sistema }] },
      contents: ordenar(historial),
      generationConfig: { temperature: 0.6, maxOutputTokens: 600 },
    }),
  });
  if (!r.ok) { console.error("Gemini", r.status, (await r.text()).slice(0, 300)); return "Perdón, tuve un problemita. ¿Me lo repetís?"; }
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("").trim() || "¿Me lo repetís?";
}

// ---------- Memoria de la charla ----------
type Chat = { telefono: string; canal: string; modo: string; historial: { r: string; t: string }[]; nombre?: string; interes?: string };
const CANAL = "green";
async function cargar(tel: string): Promise<Chat> {
  const { data } = await db.from("chats").select("*").eq("telefono", tel).eq("canal", CANAL).maybeSingle();
  return data ?? { telefono: tel, canal: CANAL, modo: "vendedor", historial: [] };
}
async function guardar(ch: Chat) {
  ch.historial = ch.historial.slice(-24);
  await db.from("chats").upsert({ ...ch, actualizado: new Date().toISOString() });
}

// ---------- Conversación ----------
const APERTURA = `¡Hola Nicolás! 👋 Soy el asistente virtual de Lucas, de kionda IA (sí, soy un bot 🤖).
Lucas armó un sistema pensado para Doble As: un bot de WhatsApp que les avisa a tus clientes cuando les toca el cambio de aceite, da turnos solo, avisa cuando la moto está lista y te manda todo a un panel.
¿Querés ver cómo funciona? Elegí una opción 👇`;

async function iniciar(c: Cfg, chatId: string) {
  const ch = await cargar(chatId);
  ch.modo = "vendedor";
  ch.historial.push({ r: "b", t: APERTURA });
  await texto(c, chatId, APERTURA);
  await encuesta(c, chatId, "¿Qué querés hacer?", OP_VENDEDOR);
  await guardar(ch);
}

async function opcion(c: Cfg, ch: Chat, op: string) {
  const id = ch.telefono;
  const decir = async (m: string) => { ch.historial.push({ r: "b", t: m }); await texto(c, id, m); };
  ch.historial.push({ r: "u", t: `[eligió: ${op}]` });
  if (op === O.probar) {
    ch.modo = "demo";
    await decir("Listo, ahora soy el bot de Doble As 🏍️ Escribime como si fueras un cliente del taller (preguntá el horario, pedí un turno, lo que quieras) o elegí una opción para ver cómo funcionan los avisos.");
    await encuesta(c, id, "Probá:", OP_DEMO);
  } else if (op === O.salir) {
    ch.modo = "vendedor";
    await decir("Volviste con el asistente de kionda IA 👋 ¿Qué te pareció?");
    await encuesta(c, id, "¿Seguimos?", OP_VENDEDOR);
  } else if (op === O.panel) {
    await decir(`Este es el panel que usarías en el taller (modo demo, con datos de ejemplo):\n${PANEL}\nAhí ves los clientes, el historial de cada moto, los turnos y cuántos clientes volvieron por los avisos. Se usa desde el celu o la compu.`);
    await encuesta(c, id, "¿Seguimos?", OP_VENDEDOR);
  } else if (op === O.lucas) {
    ch.modo = "humano";
    ch.interes = "caliente";
    await decir("¡Genial! Ya le aviso a Lucas y te escribe él por acá. 🙌");
  } else if (op === O.aviso) {
    await decir("Así le llega el recordatorio a un cliente 👇");
    await encuesta(c, id, "¡Hola! Te escribimos de Doble As 🔧 Ya le toca el cambio de aceite a tu Honda CB 190R (último service hace 6 meses, 13.900 km). ¿Te reservamos un turno?", OP_AVISO);
  } else if (op === O.turno) {
    await decir("¡Dale! Tengo lugar mañana o pasado a la mañana. ¿Cuál te queda mejor? (escribime la respuesta)");
  } else if (op === O.semana) {
    await decir("Perfecto, te escribimos de nuevo la semana que viene 👍");
    await encuesta(c, id, "¿Querés ver algo más?", OP_DEMO);
  } else if (op === O.service) {
    await imagen(c, id, IMG, "Así recibe el cliente el resumen del service: lo que se hizo y cuándo le toca el próximo 🧾");
    ch.historial.push({ r: "b", t: "[mandó la imagen del service]" });
    await encuesta(c, id, "¿Querés ver algo más?", OP_DEMO);
  }
}

async function libre(c: Cfg, ch: Chat, msg: string) {
  ch.historial.push({ r: "u", t: msg });
  const demo = ch.modo === "demo";
  const r = await ia(demo ? DEMO : VENDEDOR, ch.historial);
  ch.historial.push({ r: "b", t: r });
  await texto(c, ch.telefono, r);
  await encuesta(c, ch.telefono, demo ? "Probá:" : "¿Qué querés hacer?", demo ? OP_DEMO : OP_VENDEDOR);
}

function votoDe(md: any, quien: string): string | null {
  const p = md?.pollMessageData;
  if (!p?.options) return null;
  const elegida = p.options.find((o: any) => (o.optionVoters ?? []).some((v: string) => v === quien || v.split("@")[0] === quien.split("@")[0]));
  return elegida?.optionName ?? null;
}

async function privado(c: Cfg, b: any) {
  const sd = b.senderData ?? {};
  const chatId: string = sd.chatId ?? "";
  if (!PERMITIDOS[chatId]) return;
  const ch = await cargar(chatId);
  ch.nombre = ch.nombre ?? PERMITIDOS[chatId];
  if (ch.modo === "humano") { await guardar(ch); return; } // Lucas se hace cargo: el bot no contesta
  const md = b.messageData ?? {};
  if (md.typeMessage === "pollUpdateMessage") {
    const op = votoDe(md, sd.sender ?? chatId);
    if (op) await opcion(c, ch, op);
  } else {
    const t = (md.textMessageData?.textMessage ?? md.extendedTextMessageData?.text ?? "").trim();
    if (t) await libre(c, ch, t);
  }
  await guardar(ch);
}

// ---------- Servidor ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const c = await config();
  const k = url.searchParams.get("k");
  if (!c.webhook_key || k !== c.webhook_key) return new Response("no", { status: 403 });

  if (req.method === "GET") {
    if (url.searchParams.get("setup")) {
      const r = await green(c, "setSettings", { webhookUrl: `${BASE}/functions/v1/kionda-wa?k=${c.webhook_key}`, incomingWebhook: "yes", pollMessageWebhook: "yes" });
      return new Response(`setup: ${r}`);
    }
    const a = url.searchParams.get("iniciar");
    if (a && PERMITIDOS[a]) { await iniciar(c, a); return new Response("iniciado"); }
    const h = url.searchParams.get("reactivar");
    if (h) { await db.from("chats").update({ modo: "vendedor" }).eq("telefono", h).eq("canal", CANAL); return new Response("reactivado"); }
    return new Response("kionda-wa vivo");
  }

  let raw = "";
  try { raw = await req.text(); } catch { return new Response("ok"); }
  let b: any; try { b = JSON.parse(raw); } catch { return new Response("ok"); }
  const chatId: string = b?.senderData?.chatId ?? "";

  // Grupos (y todo lo que no sea un chat privado) → a Camorro, tal cual llegó
  if (!chatId.endsWith("@c.us")) {
    // @ts-ignore EdgeRuntime existe en Supabase
    EdgeRuntime.waitUntil(fetch(`${BASE}/functions/v1/camorro?k=${c.webhook_key}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw }).catch((e) => console.error("fwd camorro", e)));
    return new Response("ok");
  }
  if (b.typeWebhook === "incomingMessageReceived") {
    // @ts-ignore
    EdgeRuntime.waitUntil(privado(c, b).catch((e) => console.error("privado", e)));
  }
  return new Response("ok");
});
