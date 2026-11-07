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
    const r = await sendMsg(env, { comment_id: v.id }, btn);
    if (!r.ok) {
      // plan B: texto plano; el usuario responde "SI"
      await sendMsg(env, { comment_id: v.id }, { text: `${intro}\n\nCuando me sigas, responde "SI".` });
      await env.RULES.put(`pending:${v.from.id}`, rule.id, { expirationTtl: 60 * 60 * 24 });
    }
  } else {
    await sendMsg(env, { comment_id: v.id }, { text: finalText(rule) });
    await bump(env, rule.id);
  }
}

async function deliverIfFollowing(env, senderId, ruleId) {
  const rules = await getRules(env);
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return;
  const p = await graph(env, `/${senderId}`, { params: { fields: "is_user_follow_business,username" } });
  if (p.ok && p.data.is_user_follow_business) {
    await sendMsg(env, { id: senderId }, { text: finalText(rule) });
    await env.RULES.delete(`pending:${senderId}`);
    await bump(env, rule.id);
  } else {
    const msg = rule.notFollowingMessage || "Todavía no veo que me sigas 🙈 Síguenos y pulsa el botón otra vez.";
    await sendMsg(env, { id: senderId }, buttonMessage(msg, rule.buttonText || "Ya te sigo ✅", `FOLLOW:${rule.id}`));
  }
}

async function handleMessaging(env, m) {
  if (m.message?.is_echo || m.sender?.id === env.IG_USER_ID) return;
  const senderId = m.sender?.id;
  const payload = m.postback?.payload;
  if (payload?.startsWith("FOLLOW:")) return deliverIfFollowing(env, senderId, payload.slice(7));
  // plan B por texto
  const text = norm(m.message?.text || "").trim();
  if (text === "si" || text === "sí") {
    const ruleId = await env.RULES.get(`pending:${senderId}`);
    if (ruleId) return deliverIfFollowing(env, senderId, ruleId);
  }
}

async function handleWebhook(request, env, ctx) {
  const raw = await request.text();
  const sig = (request.headers.get("X-Hub-Signature-256") || "").replace("sha256=", "");
  const expected = await hmacHex(env.APP_SECRET, raw);
  if (!sig || !safeEqual(sig, expected)) return new Response("bad signature", { status: 401 });

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
    const rule = {
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

export default {
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
