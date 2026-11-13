// kionda IA · "Prueba un bot" (kiondaia.com/probar)
// Bot de ejemplo de un negocio genérico ("Tu negocio") con 3 modos: turno, aviso, consulta.
// - action "chat": la página manda el historial (no se guarda la charla). Límite por IP en demo_uso.
// - action "lead": guarda nombre + WhatsApp en leads (source "probar").
import { createClient } from "jsr:@supabase/supabase-js@2";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const ALLOWED = ["https://kiondaia.com", "https://www.kiondaia.com", "https://kionda043-alt.github.io"];
const MAX_POR_HORA = 60; // mensajes por IP por hora
const MAX_TURNOS = 14; // mensajes del usuario por charla

const NEGOCIO = `NEGOCIO DE EJEMPLO ("Tu negocio"):
- Horario: lunes a viernes de 9 a 19 h; sábados de 10 a 14 h; domingos cerrado.
- Dirección: Av. Ejemplo 1234, Buenos Aires. Hay estacionamiento en la cuadra.
- Servicios y precios:
  · Atención express (15 min): $8.000
  · Atención estándar (30 min): $15.000
  · Servicio completo (1 h): $35.000
  · Presupuestos a medida: sin cargo
- Medios de pago: efectivo, transferencia y tarjetas (hasta 3 cuotas sin interés).
- Turnos libres de ejemplo: mañana 10:00, 11:30 y 16:00; pasado mañana 9:30, 13:00 y 17:30; el sábado 10:30 y 12:00.
- Cancelaciones: avisando con 24 h de anticipación, sin cargo.`;

const BASE = (lang: string) => `Eres el asistente virtual de WhatsApp de "Tu negocio", un negocio de ejemplo creado por kionda IA para mostrar cómo funciona un bot con inteligencia artificial.
${NEGOCIO}

CÓMO HABLAR
- Responde en ${lang === "en" ? "inglés" : "español neutro (tuteo, sin \"vos\" ni lunfardo)"}, cálido y profesional, como un buen negocio por WhatsApp.
- Mensajes cortos: 1 a 3 frases. Puedes usar algún emoji, sin exagerar. Texto plano, sin markdown.
- Usa solo los datos del negocio de ejemplo. Si te preguntan algo que no está, di que lo consultas con el equipo.
- Si preguntan de qué rubro es el negocio, explica que es un ejemplo genérico y que kionda IA lo adapta a cualquier rubro con los datos, el logo y los servicios de cada negocio.
- Si preguntan por kionda IA, cuánto cuesta un bot así o cómo contratarlo, responde en una frase que kionda IA lo arma a medida y que pueden dejar su WhatsApp abajo para que los contacten. No des precios del servicio de kionda IA.
- Si piden algo ajeno (tareas, código, temas generales), di en una frase que eres el asistente de "Tu negocio" y vuelve al tema.
- No pidas datos personales reales: es una demo. Si hace falta un nombre para un turno, invítalo a usar cualquiera.

BOTONES
- En "chips" propone de 0 a 3 respuestas cortas (máximo 4 palabras cada una) que la persona podría tocar a continuación. Vacío si no hacen falta.`;

const MODOS: Record<string, string> = {
  turno: `MODO: PEDIR UN TURNO. La persona quiere reservar. Pregunta qué servicio quiere, ofrece los turnos libres de ejemplo y confirma con un resumen (servicio, día, hora, precio). Al confirmar, di que le llegará un recordatorio el día anterior.`,
  aviso: `MODO: AVISO. Tú enviaste primero un recordatorio de turno (mañana 10:30, servicio completo). Responde a lo que la persona conteste: si confirma, agradece; si quiere cambiar, ofrece otros horarios libres; si cancela, cancela con amabilidad y ofrece reprogramar.`,
  consulta: `MODO: CONSULTA. La persona tiene dudas (horarios, precios, dirección, medios de pago, servicios). Responde con los datos del negocio y, si corresponde, ofrece sacar un turno.`,
};

const SCHEMA = {
  type: "OBJECT",
  properties: { reply: { type: "STRING" }, chips: { type: "ARRAY", items: { type: "STRING" } } },
  required: ["reply", "chips"],
};

function cors(origin: string | null) {
  const ok = origin && (ALLOWED.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED[0],
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
async function hashIp(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "sin-ip";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("kionda:" + ip));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const clean = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function ordenar(h: { role: string; text: string }[]) {
  const out: { role: string; parts: { text: string }[] }[] = [];
  for (const m of h) {
    const role = m.role === "user" ? "user" : "model";
    if (!out.length && role === "model") { out.push({ role: "user", parts: [{ text: "(La persona abrió el chat)" }] }); }
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + m.text;
    else out.push({ role, parts: [{ text: m.text }] });
  }
  return out;
}

Deno.serve(async (req) => {
  const h = { ...cors(req.headers.get("origin")), "content-type": "application/json" };
  const out = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: h });
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return out({ error: "method" }, 405);
  let p: Record<string, unknown>;
  try { p = await req.json(); } catch { return out({ error: "json" }, 400); }
  const lang = p.lang === "en" ? "en" : "es";
  const ip = await hashIp(req);

  if (p.action === "lead") {
    const name = clean(p.name, 120), contact = clean(p.contact, 160), business = clean(p.business, 160);
    if (!name || !contact) return out({ error: "missing" }, 400);
    const { count } = await db.from("leads").select("id", { count: "exact", head: true })
      .eq("ip_hash", ip).gte("created_at", new Date(Date.now() - 3600e3).toISOString());
    if ((count ?? 0) >= 5) return out({ error: "busy" }, 429);
    const modos = Array.isArray(p.modos) ? (p.modos as unknown[]).map(String).filter((m) => m in MODOS).join(", ") : "";
    const { error } = await db.from("leads").insert({
      source: "probar", lang, name, contact, business: business || null, wants_quote: true, score: "caliente",
      need: "Quiere un bot como el de la demo, con su logo y sus datos.",
      summary: `Probó el bot de ejemplo en kiondaia.com/probar${modos ? ` (modos: ${modos})` : ""} y dejó sus datos para que lo contacten.${business ? ` Negocio: ${business}.` : ""}`,
      ip_hash: ip,
    });
    if (error) { console.error(error); return out({ error: "db" }, 500); }
    return out({ ok: true });
  }

  if (p.action !== "chat") return out({ error: "action" }, 400);
  const modo = typeof p.modo === "string" && p.modo in MODOS ? p.modo : "consulta";
  const hist = (Array.isArray(p.history) ? p.history : []).slice(-30)
    .map((m: any) => ({ role: m?.role === "user" ? "user" : "model", text: clean(m?.text, 800) }))
    .filter((m: { text: string }) => m.text);
  if (!hist.length || hist[hist.length - 1].role !== "user") return out({ error: "empty" }, 400);
  if (hist.filter((m: { role: string }) => m.role === "user").length > MAX_TURNOS) {
    return out({ reply: lang === "en" ? "That's the end of the demo 🙌 Leave your WhatsApp below and we'll build one for your business." : "Hasta acá llega la demo 🙌 Deja tu WhatsApp abajo y armamos uno para tu negocio.", chips: [], fin: true });
  }
  const { count } = await db.from("demo_uso").select("id", { count: "exact", head: true })
    .eq("ip_hash", ip).gte("creado", new Date(Date.now() - 3600e3).toISOString());
  if ((count ?? 0) >= MAX_POR_HORA) return out({ reply: lang === "en" ? "Too many messages for now, try again later." : "Muchos mensajes por ahora, prueba de nuevo en un rato.", chips: [] });
  await db.from("demo_uso").insert({ ip_hash: ip });

  // Gemini a veces corta la respuesta (se queda sin tokens): reintenta una vez y, si igual viene rota, rescata el texto
  async function preguntar() {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: BASE(lang) + "\n\n" + MODOS[modo] }] },
        contents: ordenar(hist),
        generationConfig: { temperature: 0.6, maxOutputTokens: 4096, responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
    });
    if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const txt = (j.candidates?.[0]?.content?.parts ?? []).map((x: { text?: string }) => x.text ?? "").join("");
    try { return JSON.parse(txt); } catch {
      const m = txt.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (m && m[1].length > 40) return { reply: JSON.parse(`"${m[1]}"`) + "", chips: [], _parcial: true };
      throw new Error("json cortado: " + txt.slice(0, 200));
    }
  }
  try {
    let ai = await preguntar().catch((e) => { console.error(e); return null; });
    if (!ai || ai._parcial) ai = (await preguntar().catch((e) => { console.error(e); return null; })) ?? ai;
    if (!ai) throw new Error("sin respuesta");
    const chips = (Array.isArray(ai.chips) ? ai.chips : []).map((c: unknown) => clean(c, 40)).filter(Boolean).slice(0, 3);
    return out({ reply: clean(ai.reply, 1200) || "…", chips });
  } catch (e) {
    console.error(e);
    return out({ reply: lang === "en" ? "I had a problem answering, could you try again?" : "Tuve un problema para responder, ¿puedes intentar de nuevo?", chips: [] });
  }
});
