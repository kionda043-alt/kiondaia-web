/* kionda IA — asistente virtual de la web */
(() => {
  const API = "https://itnxcvnmmoqgeijerjqj.supabase.co/functions/v1/kionda-bot";
  const KEY = "sb_publishable_jJ7O9A5iqqLoeyWF1SYZZQ_LQpd4vLK";
  const SS = "k-bot";

  const TX = {
    es: {
      title: "Asistente kionda IA",
      sub: "Respuestas al instante, con IA",
      hello: "Hola, soy el asistente de kionda IA. Cuéntame sobre tu negocio y qué te gustaría mejorar o construir, y vemos juntos qué solución podría servirte.",
      ph: "Escribe tu mensaje…",
      send: "Enviar",
      open: "Abrir el asistente",
      close: "Cerrar",
      note: "Asistente con IA. Puede cometer errores.",
      chips: ["Quiero un bot para mi negocio", "Necesito una app a medida", "Quiero ordenar mi negocio", "Contenido para redes"],
      err: "No pude conectarme. Revisa tu conexión e intenta de nuevo.",
      done: "Conversación finalizada",
      again: "Nueva charla",
      tip: "¿Tienes un proyecto? Te ayudo",
    },
    en: {
      title: "kionda IA assistant",
      sub: "Instant answers, powered by AI",
      hello: "Hi, I'm the kionda IA assistant. Tell me about your business and what you'd like to improve or build, and we'll figure out which solution could work for you.",
      ph: "Type your message…",
      send: "Send",
      open: "Open the assistant",
      close: "Close",
      note: "AI assistant. It can make mistakes.",
      chips: ["I want a bot for my business", "I need a custom app", "I want to organize my business", "Social media content"],
      err: "I couldn't connect. Check your connection and try again.",
      done: "Conversation ended",
      again: "New chat",
      tip: "Got a project? I can help",
    },
  };
  const lang = () => (document.documentElement.lang === "en" ? "en" : "es");

  const LOGO = `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M34 16H66A22 22 0 0 1 88 38V48A22 22 0 0 1 66 70H40L23 84Q18 87 20 81L25 67A22 22 0 0 1 12 48V38A22 22 0 0 1 34 16Z" fill="#FF5A36"/><path d="M10 44C17 44 19 47 24 47C30 47 31 34 37 34C43 34 44 55 50 55C56 55 57 36 63 36C68 36 70 46 76 46C82 46 84 44 90 44" fill="none" stroke="#FFF4E6" stroke-width="6" stroke-linecap="round"/></svg>`;

  const css = `
.kb-launch{position:fixed;right:18px;bottom:18px;z-index:60;width:64px;height:64px;border-radius:50%;border:0;padding:0;background:var(--navy,#14112B);display:grid;place-items:center;cursor:pointer;box-shadow:0 14px 34px -10px rgba(20,17,43,.7);transform:scale(0);transition:transform .4s cubic-bezier(.34,1.56,.64,1)}
.kb-launch.show{transform:scale(1)}
.kb-launch svg{width:40px;height:40px;transition:transform .3s}
.kb-launch:hover svg{transform:rotate(-8deg) scale(1.08)}
.kb-launch::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--coral,#FF5A36);animation:kbRing 2.4s infinite}
@keyframes kbRing{from{transform:scale(1);opacity:.85}to{transform:scale(1.55);opacity:0}}
.kb-tip{position:fixed;right:92px;bottom:32px;z-index:60;background:#fff;color:var(--navy,#14112B);font:500 14px 'DM Sans',sans-serif;padding:10px 14px;border-radius:16px 16px 4px 16px;box-shadow:0 10px 30px -10px rgba(20,17,43,.4);opacity:0;transform:translateY(8px);transition:.35s;pointer-events:none;white-space:nowrap}
.kb-tip.show{opacity:1;transform:none}
.kb-panel{position:fixed;right:18px;bottom:96px;z-index:61;width:380px;max-width:calc(100vw - 24px);height:min(600px,calc(100vh - 120px));background:var(--cream,#FFF4E6);border-radius:26px;box-shadow:0 30px 70px -20px rgba(20,17,43,.55);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(20px) scale(.96);transform-origin:bottom right;pointer-events:none;transition:opacity .3s,transform .35s cubic-bezier(.34,1.4,.64,1)}
.kb-panel.open{opacity:1;transform:none;pointer-events:auto}
.kb-head{background:var(--navy,#14112B);color:var(--cream,#FFF4E6);padding:16px 16px 16px 18px;display:flex;align-items:center;gap:12px;position:relative;overflow:hidden}
.kb-head svg.lg{width:42px;height:42px;flex:none}
.kb-head b{font:700 17px 'Space Grotesk',sans-serif;letter-spacing:-.02em;display:block}
.kb-head span{font-size:13px;color:var(--muted-d,#B9B4CC);display:flex;align-items:center;gap:6px}
.kb-head span::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--lime,#C6FF3D);box-shadow:0 0 0 3px rgba(198,255,61,.2)}
.kb-head .wv{position:absolute;left:0;right:0;bottom:0;height:3px;background:linear-gradient(90deg,transparent,var(--coral,#FF5A36),var(--lime,#C6FF3D),transparent);background-size:200% 100%;animation:kbWave 3s linear infinite;opacity:0;transition:opacity .3s}
.kb-panel.busy .kb-head .wv{opacity:1}
@keyframes kbWave{to{background-position:-200% 0}}
.kb-x{margin-left:auto;background:rgba(255,244,230,.1);border:0;color:var(--cream,#FFF4E6);width:36px;height:36px;border-radius:50%;font-size:22px;line-height:1;cursor:pointer}
.kb-body{flex:1;overflow-y:auto;padding:18px 14px 8px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
.kb-m{max-width:84%;padding:11px 14px;border-radius:18px;font:400 15px/1.45 'DM Sans',sans-serif;white-space:pre-wrap;word-wrap:break-word;animation:kbIn .35s cubic-bezier(.34,1.4,.64,1)}
.kb-m.b{background:#fff;color:var(--navy,#14112B);border-bottom-left-radius:6px;align-self:flex-start;box-shadow:0 4px 14px -8px rgba(20,17,43,.25)}
.kb-m.u{background:var(--coral,#FF5A36);color:#fff;border-bottom-right-radius:6px;align-self:flex-end}
@keyframes kbIn{from{opacity:0;transform:translateY(8px) scale(.97)}}
.kb-dots{align-self:flex-start;background:#fff;border-radius:18px;border-bottom-left-radius:6px;padding:14px 16px;display:flex;gap:5px}
.kb-dots i{width:7px;height:7px;border-radius:50%;background:var(--coral,#FF5A36);animation:kbDot 1s infinite}
.kb-dots i:nth-child(2){animation-delay:.15s}.kb-dots i:nth-child(3){animation-delay:.3s}
@keyframes kbDot{0%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-5px);opacity:1}}
.kb-chips{display:flex;flex-wrap:wrap;gap:8px;padding:0 14px 10px}
.kb-chips button{border:1.5px solid rgba(20,17,43,.15);background:transparent;color:var(--navy,#14112B);font:500 13px 'DM Sans',sans-serif;padding:8px 12px;border-radius:999px;cursor:pointer;transition:.2s}
.kb-chips button:hover{border-color:var(--coral,#FF5A36);color:var(--coral,#FF5A36)}
.kb-form{display:flex;gap:8px;padding:10px 12px 6px;border-top:1px solid rgba(20,17,43,.08)}
.kb-form textarea{flex:1;resize:none;border:1.5px solid rgba(20,17,43,.15);border-radius:18px;padding:11px 14px;font:400 16px/1.35 'DM Sans',sans-serif;color:var(--navy,#14112B);background:#fff;outline:none;max-height:110px}
.kb-form textarea:focus{border-color:var(--coral,#FF5A36)}
.kb-form button{flex:none;width:46px;height:46px;align-self:flex-end;border:0;border-radius:50%;background:var(--coral,#FF5A36);color:#fff;cursor:pointer;display:grid;place-items:center;transition:transform .2s,opacity .2s}
.kb-form button:disabled{opacity:.4;cursor:default}
.kb-form button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.kb-note{font:400 11.5px 'DM Sans',sans-serif;color:var(--muted,#5B5670);text-align:center;padding:2px 12px 10px}
.kb-end{align-self:center;font:500 13px 'DM Sans',sans-serif;color:var(--muted,#5B5670);display:flex;gap:10px;align-items:center;padding:6px 0}
.kb-end button{border:0;background:var(--navy,#14112B);color:var(--cream,#FFF4E6);font:500 13px 'DM Sans',sans-serif;padding:7px 12px;border-radius:999px;cursor:pointer}
@media(max-width:600px){
 .kb-panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100dvh;border-radius:0}
 .kb-panel.open~.kb-launch,.kb-panel.open~.kb-tip{transform:scale(0);opacity:0}
 .kb-tip{right:88px;bottom:30px;font-size:13px}
}`;
  const st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);

  const panel = document.createElement("div");
  panel.className = "kb-panel";
  panel.setAttribute("role", "dialog");
  panel.innerHTML = `
    <div class="kb-head"><svg class="lg" viewBox="0 0 100 100">${LOGO.replace(/<\/?svg[^>]*>/g, "")}</svg>
      <div><b class="t"></b><span class="s"></span></div>
      <button class="kb-x" type="button">×</button><div class="wv"></div></div>
    <div class="kb-body" aria-live="polite"></div>
    <div class="kb-chips"></div>
    <form class="kb-form"><textarea rows="1" maxlength="1200"></textarea>
      <button type="submit"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></form>
    <div class="kb-note"></div>`;
  const launch = document.createElement("button");
  launch.className = "kb-launch";
  launch.type = "button";
  launch.innerHTML = LOGO;
  const tip = document.createElement("div");
  tip.className = "kb-tip";
  document.body.append(panel, launch, tip);

  const $ = (s) => panel.querySelector(s);
  const body = $(".kb-body"), chips = $(".kb-chips"), form = $(".kb-form"), ta = $("textarea"), btn = $(".kb-form button");

  let state = { id: null, msgs: [], done: false };
  try { const s = JSON.parse(sessionStorage.getItem(SS)); if (s && Array.isArray(s.msgs)) state = s; } catch (e) {}
  const save = () => { try { sessionStorage.setItem(SS, JSON.stringify(state)); } catch (e) {} };
  let busy = false;

  function bubble(text, who) {
    const d = document.createElement("div");
    d.className = "kb-m " + who;
    d.textContent = text;
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
  }
  function render() {
    const t = TX[lang()];
    $(".t").textContent = t.title; $(".s").textContent = t.sub;
    $(".kb-x").setAttribute("aria-label", t.close);
    $(".kb-note").textContent = t.note;
    ta.placeholder = t.ph; btn.setAttribute("aria-label", t.send);
    launch.setAttribute("aria-label", t.open); panel.setAttribute("aria-label", t.title);
    tip.textContent = t.tip;
    body.innerHTML = "";
    bubble(t.hello, "b");
    state.msgs.forEach((m) => bubble(m.text, m.who));
    chips.innerHTML = "";
    if (!state.msgs.length) t.chips.forEach((c) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = c;
      b.onclick = () => send(c); chips.appendChild(b);
    });
    if (state.done) endBar();
    form.style.display = state.done ? "none" : "";
  }
  function endBar() {
    const t = TX[lang()];
    const e = document.createElement("div"); e.className = "kb-end";
    e.innerHTML = `<span></span><button type="button"></button>`;
    e.querySelector("span").textContent = t.done;
    e.querySelector("button").textContent = t.again;
    e.querySelector("button").onclick = () => { state = { id: null, msgs: [], done: false }; save(); render(); ta.focus(); };
    body.appendChild(e); body.scrollTop = body.scrollHeight;
  }

  async function send(text) {
    text = (text || "").trim();
    if (!text || busy || state.done) return;
    busy = true; btn.disabled = true; panel.classList.add("busy");
    chips.innerHTML = "";
    state.msgs.push({ who: "u", text }); save();
    bubble(text, "u");
    ta.value = ""; ta.style.height = "";
    const dots = document.createElement("div");
    dots.className = "kb-dots"; dots.innerHTML = "<i></i><i></i><i></i>";
    body.appendChild(dots); body.scrollTop = body.scrollHeight;
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: KEY },
        body: JSON.stringify({ action: "chat", id: state.id, message: text, lang: lang() }),
      });
      const j = await r.json();
      dots.remove();
      if (j.id) state.id = j.id;
      if (j.reply) { state.msgs.push({ who: "b", text: j.reply }); bubble(j.reply, "b"); }
      else throw new Error("sin respuesta");
      if (j.done) { state.done = true; form.style.display = "none"; endBar(); }
      save();
    } catch (e) {
      dots.remove();
      state.msgs.pop(); save();
      body.lastChild && body.lastChild.remove();
      ta.value = text;
      bubble(TX[lang()].err, "b");
    }
    busy = false; btn.disabled = false; panel.classList.remove("busy");
    if (!state.done && matchMedia("(hover:hover)").matches) ta.focus();
  }

  function open(prefill) {
    panel.classList.add("open"); tip.classList.remove("show");
    try { sessionStorage.setItem(SS + "-tip", "1"); } catch (e) {}
    if (prefill && !state.done) send(prefill);
    else if (matchMedia("(hover:hover)").matches) setTimeout(() => ta.focus(), 300);
  }
  function close() { panel.classList.remove("open"); }

  launch.onclick = () => (panel.classList.contains("open") ? close() : open());
  $(".kb-x").onclick = close;
  form.onsubmit = (e) => { e.preventDefault(); send(ta.value); };
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(ta.value); } });
  ta.addEventListener("input", () => { ta.style.height = ""; ta.style.height = Math.min(ta.scrollHeight, 110) + "px"; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  // aparece al terminar la intro y saluda una vez por visita
  let shown = false;
  function show() {
    if (shown) return; shown = true;
    launch.classList.add("show");
    let seen = false; try { seen = sessionStorage.getItem(SS + "-tip"); } catch (e) {}
    if (!seen) setTimeout(() => { if (!panel.classList.contains("open")) { tip.classList.add("show"); setTimeout(() => tip.classList.remove("show"), 6000); } }, 4000);
  }
  // la web agrega "go" al body cuando termina la intro
  const ready = () => document.body.classList.contains("go") && setTimeout(show, 700);
  if (!ready()) new MutationObserver((_, o) => { if (ready()) o.disconnect(); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  setTimeout(show, 12000);

  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  render();
  // formulario de contacto de la web → mismo admin
  async function sendForm(data) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: KEY },
      body: JSON.stringify({ action: "form", lang: lang(), ...data }),
    });
    if (!r.ok) throw new Error("form " + r.status);
    return r.json();
  }
  window.kBot = { open, close, sendForm };
})();
