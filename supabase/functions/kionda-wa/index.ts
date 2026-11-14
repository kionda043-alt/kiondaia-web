// Kionda · Cerebro de WhatsApp vía Green-API (mismo número/instancia que Camorro)
// - Mensajes de GRUPOS → se reenvían tal cual a la función "camorro" (no cambia nada para la banda).
// - Chats PRIVADOS → solo responde a los números de PERMITIDOS: bot vendedor con RECORRIDO GUIADO.
//   Recorrido: aviso → turno → imagen del service → panel → propuesta (cierre con pregunta concreta).
//   Cada paso cuenta el beneficio y ofrece "Seguir". Si escriben, responde la IA y vuelve al recorrido.
// Opciones con ENCUESTAS (con QR no hay botones). Config de Green en camorro_config.
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

// ---------- Opciones de las encuestas ----------
const O = {
  ver: "▶️ Mostrame cómo funciona",
  lucas: "🙋 Hablar con Lucas",
  sTurno: "➡️ Seguir: turnos",
  sImagen: "➡️ Seguir: resumen del service",
  sPanel: "➡️ Seguir: tu panel",
  sPropuesta: "➡️ Ver la propuesta",
  probar: "💬 Probarlo yo",
  volver: "➡️ Seguir el recorrido",
  si: "✅ Sí, quiero probarlo",
  dudas: "💬 Tengo una duda",
};

// ---------- Recorrido guiado ----------
type Paso = { id: string; enviar: (c: Cfg, id: string) => Promise<void>; opciones: string[]; resumen: string };
const PASOS: Paso[] = [
  {
    id: "aviso",
    resumen: "Le mostré el recordatorio automático de cambio de aceite.",
    opciones: [O.sTurno, O.lucas],
    enviar: async (c, id) => {
      await texto(c, id, "1️⃣ *Avisos automáticos de service*\nEl sistema sabe cuándo le toca el cambio de aceite a cada moto (por kilómetros o por tiempo) y le escribe solo al cliente unos días antes. Así vuelven los que se olvidaban, sin que tengas que acordarte vos.\n\nAsí le llega al cliente 👇");
      await texto(c, id, "_¡Hola Martín! Te escribimos de Doble As 🔧 Ya le toca el cambio de aceite a tu Honda CB 190R (último service hace 6 meses, 13.900 km). ¿Te reservamos un turno?_\n[ Sí, quiero turno ] [ Avisame la semana que viene ]");
    },
  },
  {
    id: "turno",
    resumen: "Le mostré cómo el bot da turnos solo.",
    opciones: [O.sImagen, O.probar, O.lucas],
    enviar: async (c, id) => {
      await texto(c, id, "2️⃣ *Turnos solos, las 24 horas*\nSi el cliente quiere turno, el bot le ofrece los días con lugar (vos definís cuántas motos recibís por día) y lo anota. También responde horarios, dirección y consultas cuando estás con las manos en la moto.\n\nEjemplo:\n👤 _¿Tenés lugar el jueves?_\n🤖 _Sí, el jueves a la mañana tengo lugar. ¿Te lo reservo para tu CB 190R?_\n👤 _Dale_\n🤖 _Listo, quedó anotado el jueves a la mañana 👍_\n\nSi querés, tocá *Probarlo yo* y escribile como si fueras un cliente.");
    },
  },
  {
    id: "imagen",
    resumen: "Le mandé la imagen de resumen del service.",
    opciones: [O.sPanel, O.lucas],
    enviar: async (c, id) => {
      await texto(c, id, "3️⃣ *Resumen del service con tu logo*\nCuando cargás un service, se arma solo esta imagen y le llega al cliente: lo que se hizo y cuándo le toca el próximo. Queda muy profesional y el cliente ya sabe cuándo volver.");
      await imagen(c, id, IMG, "Ejemplo del resumen que recibe el cliente 🧾");
    },
  },
  {
    id: "panel",
    resumen: "Le pasé el link del panel.",
    opciones: [O.sPropuesta, O.lucas],
    enviar: async (c, id) => {
      await texto(c, id, `4️⃣ *Tu panel, desde el celu o la compu*\nAhí ves todo: tus clientes y el historial de cada moto, las motos que están en el taller, los turnos, los presupuestos y cuántos clientes volvieron gracias a los avisos. Con un toque le avisás al cliente que la moto está lista.\n\nAbrilo y tocá lo que quieras (es una demo con datos de ejemplo):\n${PANEL}`);
    },
  },
  {
    id: "propuesta",
    resumen: "Le hice la propuesta de 30 días gratis.",
    opciones: [O.si, O.dudas, O.lucas],
    enviar: async (c, id) => {
      await texto(c, id, "5️⃣ *La propuesta*\nTe lo instalo *gratis durante 30 días* en el WhatsApp del taller, con tu logo y tus horarios. Seguís usando tu número como siempre; el bot solo te ayuda. Si en un mes no te sirve, se saca y listo.");
    },
  },
];
const PREGUNTA: Record<string, string> = {
  aviso: "¿Seguimos?", turno: "¿Seguimos?", imagen: "¿Seguimos?", panel: "¿Seguimos?",
  propuesta: "¿Arrancamos con la prueba gratis?",
};
const idx = (modo: string) => PASOS.findIndex((p) => modo === "paso:" + p.id);

// ---------- Personalidades ----------
const VENDEDOR = `Sos el asistente de ventas de kionda IA, la agencia de Lucas (Buenos Aires) que arma bots y apps con inteligencia artificial para negocios.
Estás hablando por WhatsApp con Nicolás, dueño de Doble As Taller de Motos (Miranda 4514, Floresta). Lucas ya trabajó con él antes. Escribís desde el WhatsApp de Lucas y Nicolás sabe que sos un bot.

Lo que ofrece kionda IA para el taller:
- Avisos automáticos de service (cambio de aceite por km o por tiempo, lo que llegue primero): vuelven clientes que se olvidaban.
- Bot que da turnos solo según los lugares que Nicolás defina por día, y responde horarios, dirección y consultas las 24 h.
- Aviso de "tu moto está lista", presupuestos que el cliente aprueba con un toque y pedido de reseña en Google.
- Imagen de resumen de cada service con el logo del taller.
- Panel desde el celu o la compu con clientes, historial de cada moto, turnos, presupuestos y cuántos clientes volvieron por los avisos. Demo: ${PANEL}
- Propuesta: 30 días de prueba gratis en el WhatsApp del taller; sigue usando su número como siempre. Después del mes, Lucas le pasa el precio del abono.

Reglas:
- Español rioplatense, cálido, de vos, sin lunfardo. Mensajes cortos (máximo 5 líneas).
- Respondé la duda concreta con el beneficio para el taller, sin vueltas. No inventes precios: el abono lo arregla Lucas después de la prueba.
- Las opciones van en una encuesta que se manda sola después de tu mensaje: no las enumeres.
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
      generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
    }),
  });
  if (!r.ok) { console.error("Gemini", r.status, (await r.text()).slice(0, 300)); return "Perdón, tuve un problemita. ¿Me lo repetís?"; }
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("").trim() || "¿Me lo repetís?";
}

// ---------- Memoria de la charla ----------
// modo: "inicio" | "paso:<id>" | "demo:<id>" (vuelve a ese paso) | "dudas" | "humano"
type Chat = { telefono: string; canal: string; modo: string; historial: { r: string; t: string }[]; nombre?: string; interes?: string; resumen?: string; actualizado?: string };
const CANAL = "green";
async function cargar(tel: string): Promise<Chat> {
  const { data } = await db.from("chats").select("*").eq("telefono", tel).eq("canal", CANAL).maybeSingle();
  return data ?? { telefono: tel, canal: CANAL, modo: "inicio", historial: [] };
}
async function guardar(ch: Chat) {
  ch.historial = ch.historial.slice(-30);
  await db.from("chats").upsert({ ...ch, actualizado: new Date().toISOString() });
}

// ---------- Conversación ----------
const APERTURA = `¡Hola Nicolás! 👋 Soy el asistente virtual de Lucas, de kionda IA (sí, soy un bot 🤖).
Lucas armó un sistema para Doble As que hace volver a tus clientes: les avisa solo cuando les toca el cambio de aceite, da turnos por WhatsApp y te ordena todo en un panel.
Te lo muestro en 5 pasos cortos, ¿dale?`;

async function iniciar(c: Cfg, chatId: string) {
  const ch = await cargar(chatId);
  ch.modo = "inicio";
  ch.historial.push({ r: "b", t: APERTURA });
  await texto(c, chatId, APERTURA);
  await encuesta(c, chatId, "Elegí una opción 👇", [O.ver, O.lucas]);
  await guardar(ch);
}

async function irAPaso(c: Cfg, ch: Chat, i: number) {
  const p = PASOS[i];
  ch.modo = "paso:" + p.id;
  await p.enviar(c, ch.telefono);
  ch.historial.push({ r: "b", t: `[Paso ${i + 1}] ${p.resumen}` });
  await encuesta(c, ch.telefono, PREGUNTA[p.id], p.opciones);
}

async function aLucas(c: Cfg, ch: Chat, m: string) {
  ch.modo = "humano";
  ch.interes = "caliente";
  ch.historial.push({ r: "b", t: m });
  await texto(c, ch.telefono, m);
}

// Opciones de encuestas viejas (versión anterior del bot) → su equivalente en el recorrido
const VIEJAS: Record<string, string> = {
  "🏍️ Probar el bot del taller": O.ver, "↩️ Volver con Kionda": O.ver, "🔔 Ver un aviso de service": O.ver,
  "📊 Ver el panel": O.sPanel, "🧾 Ver la imagen del service": O.sImagen,
  "📅 Sí, quiero turno": O.sTurno, "⏰ Avisame la semana que viene": O.sTurno,
};

async function opcion(c: Cfg, ch: Chat, op: string) {
  op = VIEJAS[op] ?? op;
  const id = ch.telefono;
  ch.historial.push({ r: "u", t: `[eligió: ${op}]` });
  const actual = idx(ch.modo.startsWith("demo:") ? "paso:" + ch.modo.slice(5) : ch.modo);
  if (op === O.ver) return irAPaso(c, ch, 0);
  if (op === O.sTurno) return irAPaso(c, ch, 1);
  if (op === O.sImagen) return irAPaso(c, ch, 2);
  if (op === O.sPanel) return irAPaso(c, ch, 3);
  if (op === O.sPropuesta) return irAPaso(c, ch, 4);
  if (op === O.lucas) return aLucas(c, ch, "¡Dale! Ya le aviso a Lucas y te escribe él por acá. 🙌");
  if (op === O.si) {
    ch.resumen = "Aceptó la prueba gratis de 30 días.";
    return aLucas(c, ch, "¡Buenísimo! 🎉 Lucas te escribe por acá para coordinar la instalación: necesita tu logo, horarios y cuántas motos recibís por día. ¡Gracias, Nicolás!");
  }
  if (op === O.dudas) {
    ch.modo = "dudas";
    const m = "Dale, escribime tu duda y te respondo 👇";
    ch.historial.push({ r: "b", t: m });
    return void (await texto(c, id, m));
  }
  if (op === O.probar) {
    ch.modo = "demo:" + (PASOS[actual]?.id ?? "turno");
    const m = "Listo, ahora soy el bot de Doble As 🏍️ Escribime como si fueras un cliente: pedí un turno, preguntá el horario, lo que quieras. Cuando quieras volver, tocá *Seguir el recorrido*.";
    ch.historial.push({ r: "b", t: m });
    await texto(c, id, m);
    return void (await encuesta(c, id, "Cuando termines:", [O.volver]));
  }
  if (op === O.volver) {
    const vuelta = Math.max(0, actual);
    return irAPaso(c, ch, Math.min(vuelta + 1, PASOS.length - 1));
  }
}

async function libre(c: Cfg, ch: Chat, msg: string) {
  ch.historial.push({ r: "u", t: msg });
  const id = ch.telefono;
  if (ch.modo.startsWith("demo:")) {
    const r = await ia(DEMO, ch.historial.slice(-12));
    ch.historial.push({ r: "b", t: r });
    await texto(c, id, r);
    return void (await encuesta(c, id, "¿Seguimos con el recorrido?", [O.volver]));
  }
  const r = await ia(VENDEDOR, ch.historial);
  ch.historial.push({ r: "b", t: r });
  await texto(c, id, r);
  // Después de responder, ofrece retomar desde donde estaba
  if (ch.modo === "dudas") { ch.modo = "paso:propuesta"; return void (await encuesta(c, id, "¿Arrancamos con la prueba gratis?", [O.si, O.dudas, O.lucas])); }
  const i = idx(ch.modo);
  if (i >= 0) return void (await encuesta(c, id, PREGUNTA[PASOS[i].id], PASOS[i].opciones));
  await encuesta(c, id, "¿Te muestro cómo funciona?", [O.ver, O.lucas]);
}

function votoDe(md: any, quien: string): string | null {
  const p = md?.pollMessageData;
  const lista = p?.votes ?? p?.options;
  if (!lista) return null;
  const elegida = lista.find((o: any) => (o.optionVoters ?? []).some((v: string) => v === quien || v.split("@")[0] === quien.split("@")[0]));
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
    // Green a veces manda el mismo voto dos veces: si es igual al último y fue hace menos de 90 s, se ignora
    const ult = [...ch.historial].reverse().find((m) => m.r === "u");
    const reciente = ch.actualizado && Date.now() - new Date(ch.actualizado).getTime() < 90_000;
    if (op && !(reciente && ult?.t === `[eligió: ${op}]`)) await opcion(c, ch, op);
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
    const elegir = url.searchParams.get("opcion"), quien = url.searchParams.get("chat");
    if (elegir && quien && PERMITIDOS[quien]) {
      const ch = await cargar(quien);
      const op = (O as Record<string, string>)[elegir];
      if (op) { await opcion(c, ch, op); await guardar(ch); return new Response("opcion ok"); }
    }
    const h = url.searchParams.get("reactivar");
    if (h) { await db.from("chats").update({ modo: "inicio" }).eq("telefono", h).eq("canal", CANAL); return new Response("reactivado"); }
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
