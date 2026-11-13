// Kionda · Cerebro de WhatsApp (bot vendedor + demo del taller Doble As)
// Supabase Edge Function. Al crearla, desactivar "Verify JWT" (Meta no manda JWT).
// Secrets: WA_TOKEN, WA_PHONE_ID, WA_VERIFY, OWNER_PHONE, GEMINI_API_KEY (ya existe), GEMINI_MODEL (opcional)
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const WA_TOKEN = Deno.env.get("WA_TOKEN") ?? "";
const WA_PHONE_ID = Deno.env.get("WA_PHONE_ID") ?? "";
const WA_VERIFY = Deno.env.get("WA_VERIFY") ?? "kionda";
const OWNER = (Deno.env.get("OWNER_PHONE") ?? "").replace(/\D/g, "");
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const PANEL = "https://kiondaia.com/dobleas/";
const IMG = "https://kiondaia.com/dobleas/ejemplo-service.jpg";

// ---------- Botones (máx 3 por mensaje, títulos de hasta 20 letras) ----------
const B_VENDEDOR = [["PROBAR", "🏍️ Probar el bot"], ["PANEL", "📊 Ver el panel"], ["LUCAS", "🙋 Hablar con Lucas"]];
const B_DEMO = [["D_AVISO", "🔔 Ver un aviso"], ["D_SERVICE", "🧾 Imagen service"], ["SALIR", "↩️ Volver a Kionda"]];
const B_AVISO = [["D_TURNO", "📅 Sí, quiero turno"], ["D_SEMANA", "⏰ La semana que viene"], ["SALIR", "↩️ Volver a Kionda"]];

// ---------- Personalidades ----------
const VENDEDOR = `Sos el asistente de ventas de kionda IA, la agencia de Lucas (Buenos Aires) que arma bots y apps con inteligencia artificial para negocios.
Estás hablando por WhatsApp con Nicolás, dueño de Doble As Taller de Motos (Miranda 4514, Floresta). Lucas ya trabajó con él antes.
Objetivo: contarle el "Bot para talleres" y que lo pruebe o quiera hablar con Lucas.

Qué hace el producto:
- Bot de WhatsApp con el nombre y logo del taller. Responde consultas 24 h (horarios, dirección, servicios) y da turnos solo según los lugares que Nicolás defina por día.
- Recordatorios automáticos de service: cuando a un cliente le toca el cambio de aceite (por km o por tiempo, lo que llegue primero) le escribe y le ofrece turno. Así vuelven clientes que se olvidaban.
- Avisa al cliente cuando la moto está lista para retirar.
- Al cargar un service genera una imagen con el logo, los trabajos hechos y el próximo service, y se la manda al cliente.
- Presupuestos por WhatsApp que el cliente aprueba con un botón.
- Al día siguiente de entregar la moto le pide una reseña en Google.
- Panel desde el celu o la compu: clientes, historial de cada moto, motos en el taller, turnos, presupuestos y cuántos clientes volvieron gracias a los avisos. Demo: ${PANEL}

Reglas:
- Español rioplatense, cálido, de vos, sin lunfardo. Mensajes cortos (máximo 5 líneas), como un WhatsApp real.
- No inventes precios. Si pregunta, decí que arranca con un mes de prueba gratis y que Lucas le pasa la propuesta.
- Si quiere probarlo, invitalo a tocar "Probar el bot". Si quiere ver el panel, "Ver el panel". Si quiere hablar, "Hablar con Lucas".
- Si no sabés algo, decí que lo consultás con Lucas. No hables de temas que no tengan que ver.`;

const DEMO = `Sos el bot de WhatsApp de Doble As Taller de Motos (Miranda 4514, Floresta, CABA). Horario: lunes a viernes de 9 a 18 y sábados de 9 a 13.
Servicios: mantenimiento, service, reparación, modificación y traslado. Service completo para motos de hasta 150 cc desde $80.000 (mano de obra; los repuestos se presupuestan aparte).
ESTO ES UNA DEMO: quien te escribe está probando el bot como si fuera un cliente del taller. Su moto de ejemplo es una Honda CB 190R, patente A245KLM, último service hace 6 meses con 13.900 km.
Atendé como lo haría el taller: amable, claro, en español rioplatense de vos, mensajes cortos (máximo 4 líneas).
Turnos: ofrecé mañana o pasado a la mañana; cuando elija, confirmá el turno y decí que queda anotado en el panel del taller.
No inventes precios fuera de los que tenés: decí que el taller se lo confirma.`;

// ---------- WhatsApp ----------
async function wa(payload: Record<string, unknown>) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!r.ok) {
    const err = await r.text();
    // Argentina: a veces Meta pide el número sin el 9 (549… → 54…)
    const to = String(payload.to ?? "");
    if (to.startsWith("549") && err.includes("131030")) return wa({ ...payload, to: "54" + to.slice(3) });
    console.error("WA error", r.status, err);
  }
  return r.ok;
}
const texto = (to: string, body: string) => wa({ to, type: "text", text: { body, preview_url: true } });
const botones = (to: string, body: string, bs: string[][]) =>
  wa({
    to, type: "interactive",
    interactive: {
      type: "button", body: { text: body.slice(0, 1024) },
      action: { buttons: bs.map(([id, title]) => ({ type: "reply", reply: { id, title: title.slice(0, 20) } })) },
    },
  });
const imagen = (to: string, link: string, caption: string) => wa({ to, type: "image", image: { link, caption } });

// ---------- Gemini ----------
async function ia(sistema: string, historial: { r: string; t: string }[]) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sistema }] },
      contents: historial.map((m) => ({ role: m.r === "u" ? "user" : "model", parts: [{ text: m.t }] })),
      generationConfig: { temperature: 0.6, maxOutputTokens: 400 },
    }),
  });
  if (!r.ok) { console.error("Gemini", r.status, await r.text()); return "Perdón, tuve un problema. ¿Me lo repetís?"; }
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("").trim() || "¿Me lo repetís?";
}

// ---------- Lógica ----------
type Chat = { telefono: string; canal: string; modo: string; historial: { r: string; t: string }[]; interes?: string };

async function cargar(tel: string): Promise<Chat> {
  const { data } = await sb.from("chats").select("*").eq("telefono", tel).eq("canal", WA_PHONE_ID).maybeSingle();
  return data ?? { telefono: tel, canal: WA_PHONE_ID, modo: "vendedor", historial: [] };
}
async function guardar(c: Chat) {
  c.historial = c.historial.slice(-20);
  await sb.from("chats").upsert({ ...c, actualizado: new Date().toISOString() });
}
const anotar = (c: Chat, r: string, t: string) => c.historial.push({ r, t });

async function responder(tel: string, nombre: string, entrada: { texto?: string; boton?: string }) {
  const c = await cargar(tel);
  const b = entrada.boton;

  if (b === "PROBAR") {
    c.modo = "demo:dobleas";
    const m = "Listo, ahora soy el bot de Doble As 🏍️ Escribime como si fueras un cliente del taller (preguntá horarios, pedí un turno, lo que quieras) o tocá un botón para ver cómo funcionan los avisos.";
    anotar(c, "b", m); await botones(tel, m, B_DEMO);
  } else if (b === "SALIR") {
    c.modo = "vendedor";
    const m = "Volviste con el asistente de kionda IA 👋 ¿Qué te pareció? Si querés, te muestro el panel o te paso con Lucas.";
    anotar(c, "b", m); await botones(tel, m, B_VENDEDOR);
  } else if (b === "PANEL") {
    const m = `Este es el panel que usaría el taller (en modo demo, con datos de ejemplo):\n${PANEL}\nDesde ahí se ven los clientes, el historial de cada moto, los turnos y cuántos clientes volvieron por los avisos.`;
    anotar(c, "b", m); await texto(tel, m);
    await botones(tel, "¿Seguimos?", B_VENDEDOR);
  } else if (b === "LUCAS") {
    c.interes = "caliente";
    const m = "¡Genial! Ya le aviso a Lucas para que te escriba. 🙌";
    anotar(c, "b", m); await texto(tel, m);
    if (OWNER && OWNER !== tel) await texto(OWNER, `🔥 ${nombre || tel} quiere hablar con vos sobre el bot para talleres. WhatsApp: +${tel}`);
  } else if (b === "D_AVISO") {
    const m = "Así le llega el recordatorio a un cliente 👇\n\n¡Hola! Te escribimos de Doble As 🔧 Ya le toca el cambio de aceite a tu Honda CB 190R (último service: hace 6 meses, 13.900 km). ¿Querés que te reservemos un turno?";
    anotar(c, "b", m); await botones(tel, m, B_AVISO);
  } else if (b === "D_TURNO") {
    const m = "¡Dale! Tengo lugar mañana o pasado a la mañana. ¿Cuál te queda mejor?";
    anotar(c, "b", m); await texto(tel, m);
  } else if (b === "D_SEMANA") {
    const m = "Perfecto, te escribimos de nuevo la semana que viene 👍";
    anotar(c, "b", m); await botones(tel, m, B_DEMO);
  } else if (b === "D_SERVICE") {
    await imagen(tel, IMG, "Así recibe el cliente el resumen del service, con lo que se hizo y cuándo le toca el próximo 🧾");
    anotar(c, "b", "[imagen del service]");
    await botones(tel, "¿Querés ver algo más?", B_DEMO);
  } else {
    // Texto libre → IA según el modo
    anotar(c, "u", entrada.texto || b || "");
    const demo = c.modo.startsWith("demo");
    const r = await ia(demo ? DEMO : VENDEDOR, c.historial);
    anotar(c, "b", r);
    await botones(tel, r, demo ? B_DEMO : B_VENDEDOR);
  }
  await guardar(c);
}

// ---------- Servidor ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    // Verificación del webhook de Meta
    if (url.searchParams.get("hub.verify_token") === WA_VERIFY) return new Response(url.searchParams.get("hub.challenge") ?? "");
    return new Response("no", { status: 403 });
  }
  if (req.method !== "POST") return new Response("ok");
  try {
    const body = await req.json();

    // Acción manual: arrancar la charla con alguien (requiere plantilla aprobada fuera de las 24 h)
    if (body.action === "iniciar" && body.secret === WA_VERIFY) {
      await wa({ to: body.to, type: "template", template: { name: body.template ?? "hello_world", language: { code: body.lang ?? "en_US" } } });
      return new Response("enviado");
    }

    for (const e of body.entry ?? []) for (const ch of e.changes ?? []) {
      const v = ch.value ?? {};
      const nombre = v.contacts?.[0]?.profile?.name ?? "";
      for (const m of v.messages ?? []) {
        const tel = m.from as string;
        if (m.type === "text") await responder(tel, nombre, { texto: m.text.body });
        else if (m.type === "interactive") await responder(tel, nombre, { boton: m.interactive?.button_reply?.id, texto: m.interactive?.button_reply?.title });
        else if (m.type === "button") await responder(tel, nombre, { texto: m.button?.text });
        else await texto(tel, "Por ahora solo leo mensajes de texto 🙂");
      }
    }
  } catch (err) { console.error(err); }
  return new Response("ok"); // siempre 200 para que Meta no reintente
});
