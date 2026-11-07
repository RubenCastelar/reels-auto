// Backend gratuito (Cloudflare Worker) para automatizar respuestas a comentarios de Reels.
// Flujo: comentario con palabra clave -> mensaje privado con botón -> al pulsar, se comprueba
// que te sigue (is_user_follow_business) -> se envía el mensaje con el enlace.

const enc = new TextEncoder();

// ---------- utilidades ----------
const norm = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function keywordMatches(text, keyword) {
  const words = norm(text).split(/[^a-z0-9ñ]+/).filter(Boolean);
  const kw = norm(keyword).trim();
  if (!kw) return false;
  if (kw.includes(" ")) return norm(text).includes(kw);
  return words.includes(kw);
}

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });

// ---------- Graph API ----------
const base = (env) => `https://${env.GRAPH_HOST || "graph.instagram.com"}/${env.GRAPH_VERSION || "v23.0"}`;

async function graph(env, path, { method = "GET", body, params = {} } = {}) {
  const url = new URL(base(env) + path);
  url.searchParams.set("access_token", env.IG_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.log("Graph error", path, JSON.stringify(data));
  return { ok: res.ok, data };
}

const sendMsg = (env, recipient, message) =>
  graph(env, `/${env.IG_USER_ID}/messages`, { method: "POST", body: { recipient, message } });

function buttonMessage(text, buttonText, payload) {
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: text.slice(0, 640),
        buttons: [{ type: "postback", title: buttonText.slice(0, 20), payload }],
      },
    },
  };
}

// ---------- reglas ----------
async function getRules(env) {
  return (await env.RULES.get("rules", "json")) || [];
}
const saveRules = (env, rules) => env.RULES.put("rules", JSON.stringify(rules));

const finalText = (r) => (r.link ? `${r.message}\n\n${r.link}` : r.message);

async function bump(env, ruleId) {
  const rules = await getRules(env);
  const r = rules.find((x) => x.id === ruleId);
  if (r) {
    r.sent = (r.sent || 0) + 1;
    await saveRules(env, rules);
  }
}

// ---------- webhook ----------
async function handleComment(env, v) {
  if (!v?.id || !v.media?.id || !v.from?.id) return;
  if (v.from.id === env.IG_USER_ID) return; // ignora tus propios comentarios
  const seen = `c:${v.id}`;
  if (await env.RULES.get(seen)) return;

  const rules = await getRules(env);
  const rule = rules.find((r) => r.active && r.mediaId === v.media.id && keywordMatches(v.text, r.keyword));
  console.log("comment", v.media.id, JSON.stringify(v.text), rule ? "match " + rule.id : "sin regla");
  if (!rule) return;
  await env.RULES.put(seen, "1", { expirationTtl: 60 * 60 * 24 * 7 });

  if (rule.publicReply) {
    await graph(env, `/${v.id}/replies`, { method: "POST", body: { message: rule.publicReply } });
  }

  if (rule.requireFollow) {
    const intro = rule.introMessage || "¡Hola! Para enviarte lo prometido, primero sígueme y luego pulsa el botón 👇";
    const btn = buttonMessage(intro, rule.buttonText || "Ya te sigo ✅", `FOLLOW:${rule.id}`);
    let r = await sendMsg(env, { comment_id: v.id }, btn);
    if (!r.ok) {
      // plan B: texto plano; el usuario responde cualquier cosa
      r = await sendMsg(env, { comment_id: v.id }, { text: `${intro}\n\nCuando me sigas, respóndeme a este mensaje.` });
    }
    // Queda pendiente: el sondeo de conversaciones detecta su respuesta (los avisos de Meta no llegan de cuentas sin rol)
    if (r.ok) await setPending(env, v.from, rule.id);
  } else {
    await sendMsg(env, { comment_id: v.id }, { text: finalText(rule) });
    await bump(env, rule.id);
  }
}

// Pendientes: personas a las que se pidió seguir y que aún no han recibido el enlace
const pendKeys = (u) => [`pending:${u.id}`, u.username ? `pending:u:${u.username}` : null].filter(Boolean);
async function setPending(env, user, ruleId) {
  const val = JSON.stringify({ ruleId, t: Date.now(), username: user.username || "" });
  for (const k of pendKeys(user)) await env.RULES.put(k, val, { expirationTtl: 60 * 60 * 24 * 2 });
}
async function getPending(env, user) {
  for (const k of pendKeys(user)) {
    const v = await env.RULES.get(k);
    if (v) { try { return JSON.parse(v); } catch { return { ruleId: v, t: 0 }; } }
  }
  return null;
}
async function clearPending(env, user) {
  for (const k of pendKeys(user)) await env.RULES.delete(k);
}

async function deliverIfFollowing(env, senderId, ruleId, user = { id: senderId }) {
  const rules = await getRules(env);
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return;
  const p = await graph(env, `/${senderId}`, { params: { fields: "is_user_follow_business,username" } });
  console.log("seguimiento", senderId, JSON.stringify(p.data).slice(0, 200));
  if (p.ok && p.data.is_user_follow_business) {
    await sendMsg(env, { id: senderId }, { text: finalText(rule) });
    await clearPending(env, { id: senderId, username: p.data.username || user.username });
    await clearPending(env, user);
    await bump(env, rule.id);
  } else {
    const msg = rule.notFollowingMessage || "Todavía no veo que me sigas 🙈 Síguenos y escríbeme otra vez.";
    await sendMsg(env, { id: senderId }, { text: msg });
    await setPending(env, { id: senderId, username: p.data?.username || user.username }, rule.id); // espera su próxima respuesta
  }
}

// Cada minuto: lee las conversaciones y atiende a quien haya respondido tras pedirle que siguiera
async function pollConversations(env) {
  const r = await graph(env, `/${env.IG_USER_ID}/conversations`, {
    params: { platform: "instagram", fields: "updated_time,participants,messages.limit(5){message,from,created_time}", limit: "25" },
  });
  if (!r.ok) return;
  for (const c of r.data.data || []) {
    const other = (c.participants?.data || []).find((p) => p.id !== env.IG_USER_ID);
    if (!other) continue;
    const pend = await getPending(env, other);
    if (!pend) continue;
    const replied = (c.messages?.data || []).some((m) => m.from?.id !== env.IG_USER_ID && Date.parse(m.created_time) > pend.t);
    if (!replied) continue;
    await deliverIfFollowing(env, other.id, pend.ruleId, other).catch((e) => console.log("poll conv", e));
  }
}

async function handleMessaging(env, m) {
  if (m.message?.is_echo || m.sender?.id === env.IG_USER_ID) return;
  const senderId = m.sender?.id;
  const payload = m.postback?.payload;
  if (payload?.startsWith("FOLLOW:")) return deliverIfFollowing(env, senderId, payload.slice(7));
  // plan B por texto
  const text = norm(m.message?.text || "").trim();
  const pend = await getPending(env, { id: senderId });
  if (text && pend) return deliverIfFollowing(env, senderId, pend.ruleId);
}

async function handleWebhook(request, env, ctx) {
  const raw = await request.text();
  const sig = (request.headers.get("X-Hub-Signature-256") || "").replace("sha256=", "");
  const expected = await hmacHex(env.APP_SECRET, raw);
  const okSig = !!sig && safeEqual(sig, expected);
  // Diario de depuración: últimos avisos recibidos (sin secretos)
  try {
    const dbg = (await env.RULES.get("debug", "json")) || [];
    let kinds = "";
    try { const b = JSON.parse(raw); kinds = (b.entry || []).map((e) => [...(e.changes || []).map((c) => c.field), ...(e.messaging || []).map((m) => (m.postback ? "postback" : m.message ? "message" : "otro"))].join("+")).join(","); } catch {}
    dbg.push({ t: new Date().toISOString(), firmaOk: okSig, recibida: sig.slice(0, 8), calculada: expected.slice(0, 8), bytes: raw.length, tipo: kinds, secretLen: (env.APP_SECRET || "").length });
    await env.RULES.put("debug", JSON.stringify(dbg.slice(-20)));
  } catch {}
  if (!okSig) {
    console.log("FIRMA INVALIDA", "recibida:", sig.slice(0, 8) || "(vacía)", "calculada:", expected.slice(0, 8), "bytes:", raw.length, "secretLen:", (env.APP_SECRET || "").length);
    return new Response("bad signature", { status: 401 });
  }

  const body = JSON.parse(raw);
  console.log("webhook", JSON.stringify(body).slice(0, 800));
  ctx.waitUntil(
    (async () => {
      for (const entry of body.entry || []) {
        for (const ch of entry.changes || []) if (ch.field === "comments") await handleComment(env, ch.value).catch((e) => console.log(e));
        for (const m of entry.messaging || []) await handleMessaging(env, m).catch((e) => console.log(e));
      }
    })()
  );
  return new Response("ok");
}

// ---------- API del panel ----------
function authorized(request, env) {
  const h = request.headers.get("Authorization") || "";
  return env.ADMIN_PASSWORD && safeEqual(h, `Bearer ${env.ADMIN_PASSWORD}`);
}

async function handleApi(request, env, url) {
  if (!authorized(request, env)) return json({ error: "No autorizado" }, 401);

  if (url.pathname === "/api/rules" && request.method === "GET") return json(await getRules(env));

  if (url.pathname === "/api/rules" && request.method === "POST") {
    const r = await request.json();
    if (!r.mediaId || !r.keyword || !r.message) return json({ error: "Faltan campos: vídeo, palabra o mensaje" }, 400);
    const rules = await getRules(env);
    const prev = rules.find((x) => x.id === r.id);
    const rule = {
      createdAt: r.createdAt || prev?.createdAt || new Date().toISOString(),
      id: r.id || crypto.randomUUID().slice(0, 8),
      mediaId: String(r.mediaId),
      permalink: r.permalink || "",
      keyword: r.keyword.trim(),
      message: r.message,
      link: r.link || "",
      requireFollow: !!r.requireFollow,
      publicReply: r.publicReply || "",
      introMessage: r.introMessage || "",
      notFollowingMessage: r.notFollowingMessage || "",
      buttonText: r.buttonText || "Ya te sigo ✅",
      active: r.active !== false,
      sent: r.sent || 0,
    };
    const i = rules.findIndex((x) => x.id === rule.id);
    if (i >= 0) rules[i] = rule; else rules.push(rule);
    await saveRules(env, rules);
    return json(rule);
  }

  if (url.pathname.startsWith("/api/rules/") && request.method === "DELETE") {
    const id = url.pathname.split("/").pop();
    await saveRules(env, (await getRules(env)).filter((r) => r.id !== id));
    return json({ ok: true });
  }

  // Convierte la URL de un reel en su media_id buscando entre tus últimas publicaciones
  if (url.pathname === "/api/resolve" && request.method === "GET") {
    const target = url.searchParams.get("url") || "";
    const code = (target.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!code) return json({ error: "URL no válida" }, 400);
    let next = null;
    for (let page = 0; page < 6; page++) {
      const res = next
        ? await (await fetch(next)).json()
        : (await graph(env, `/${env.IG_USER_ID}/media`, { params: { fields: "id,permalink,caption,media_product_type", limit: "50" } })).data;
      const hit = (res.data || []).find((m) => (m.permalink || "").includes(`/${code}/`));
      if (hit) return json({ mediaId: hit.id, permalink: hit.permalink, caption: (hit.caption || "").slice(0, 80) });
      next = res.paging?.next;
      if (!next) break;
    }
    return json({ error: "No he encontrado ese vídeo en tu cuenta" }, 404);
  }

  // Lee las conversaciones recientes de Instagram (para comprobar que la API las devuelve)
  if (url.pathname === "/api/conversations" && request.method === "GET") {
    const r = await graph(env, `/${env.IG_USER_ID}/conversations`, {
      params: { platform: "instagram", fields: "id,updated_time,participants,messages.limit(4){message,from,created_time}", limit: "10" },
    });
    if (!r.ok) return json({ error: r.data?.error?.message || "Error de la API" }, 502);
    return json({ conversations: r.data.data || [] }); // sin paging: evita exponer el token
  }

  // Páginas de Facebook accesibles con el token (sin mostrar sus tokens)
  if (url.pathname === "/api/pages" && request.method === "GET") {
    const r = await graph(env, `/me/accounts`, { params: { fields: "id,name,instagram_business_account{id,username}" } });
    const pages = (r.data?.data || []).map((p) => ({ id: p.id, name: p.name, ig: p.instagram_business_account || null }));
    return json(r.ok ? { pages } : { error: r.data?.error?.message });
  }

  // Consulta qué dice Meta sobre si una persona te sigue
  if (url.pathname === "/api/follow" && request.method === "GET") {
    const id = url.searchParams.get("id");
    const r = await graph(env, `/${id}`, { params: { fields: "name,username,is_user_follow_business,is_business_follow_user,follower_count" } });
    return json(r.data);
  }

  // Marca a una persona como pendiente de confirmar que te sigue (útil para pruebas)
  if (url.pathname === "/api/pending" && request.method === "POST") {
    const b = await request.json();
    if (!b.id || !b.ruleId) return json({ error: "Faltan id o ruleId" }, 400);
    await setPending(env, { id: String(b.id), username: b.username || "" }, b.ruleId);
    return json({ ok: true });
  }

  if (url.pathname === "/api/debug" && request.method === "GET") {
    return json((await env.RULES.get("debug", "json")) || []);
  }

  // Lanza la consulta de comentarios ahora mismo (la misma que corre cada minuto)
  if (url.pathname === "/api/poll" && request.method === "POST") {
    await pollComments(env);
    await pollConversations(env);
    return json({ ok: true });
  }

  // Lee los comentarios de un vídeo (para comprobar que la API los devuelve)
  if (url.pathname === "/api/comments" && request.method === "GET") {
    const mediaId = url.searchParams.get("mediaId");
    const out = [];
    let r = await graph(env, `/${mediaId}/comments`, { params: { fields: "id,text,username,timestamp", limit: "50" } });
    if (!r.ok) return json({ error: r.data?.error?.message || "Error de la API" }, 502);
    for (let page = 0; page < 5; page++) {
      for (const c of r.data.data || []) out.push({ id: c.id, text: c.text, username: c.username, timestamp: c.timestamp });
      const next = r.data.paging?.next;
      if (!next) break;
      r = { ok: true, data: await (await fetch(next)).json() }; // el token nunca sale del Worker
    }
    out.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    return json({ total: out.length, comments: out.slice(0, 15) });
  }

  // Estado / activación de la suscripción de la cuenta de Instagram a los avisos (webhooks)
  if (url.pathname === "/api/subscribe") {
    if (request.method === "POST") {
      const r = await graph(env, `/${env.IG_USER_ID}/subscribed_apps`, {
        method: "POST",
        params: { subscribed_fields: "comments,messages,messaging_postbacks" },
      });
      return json(r.data, r.ok ? 200 : 502);
    }
    const r = await graph(env, `/${env.IG_USER_ID}/subscribed_apps`);
    return json(r.data, r.ok ? 200 : 502);
  }

  if (url.pathname === "/api/me" && request.method === "GET") {
    const r = await graph(env, `/${env.IG_USER_ID}`, { params: { fields: "username" } });
    return json(r.data, r.ok ? 200 : 502);
  }

  return json({ error: "No existe" }, 404);
}

// ---------- consulta periódica (alternativa a los avisos de Meta) ----------
// Cada minuto lee los comentarios nuevos de los vídeos con regla activa y los procesa.
async function pollComments(env) {
  const rules = (await getRules(env)).filter((r) => r.active && r.createdAt);
  const week = Date.now() - 6.5 * 24 * 3600 * 1000;
  for (const rule of rules) {
    const since = Math.max(Date.parse(rule.createdAt), week);
    const r = await graph(env, `/${rule.mediaId}/comments`, { params: { fields: "id,text,username,from,timestamp", limit: "50" } });
    if (!r.ok) { console.log("poll error", rule.id, JSON.stringify(r.data?.error?.message)); continue; }
    const fresh = (r.data.data || [])
      .filter((c) => Date.parse(c.timestamp) >= since)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const c of fresh) {
      const from = c.from?.id ? c.from : { id: c.username, username: c.username };
      await handleComment(env, { id: c.id, text: c.text, from, media: { id: rule.mediaId } }).catch((e) => console.log("poll handle", e));
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollComments(env).then(() => pollConversations(env)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (url.pathname === "/webhook") {
      if (request.method === "GET") {
        const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN;
        return ok ? new Response(url.searchParams.get("hub.challenge")) : new Response("forbidden", { status: 403 });
      }
      if (request.method === "POST") return handleWebhook(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return new Response("Reels Auto funcionando ✅");
  },
};
