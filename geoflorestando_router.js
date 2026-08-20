// geoflorestando-router — Worker "de borda" que decide, por PATH, qual
// projeto Cloudflare Pages responde em geoflorestando.com:
//   /app  e  /app/*        -> Pages do sistema (o que hoje é app.geoflorestando.com)
//   qualquer outro caminho -> Pages institucional (landing page)
//
// Por que este desenho: o app (index.html) já usa só caminhos relativos
// ("./favicon.ico", "./manifest.json" etc.), não usa roteamento de URL no
// cliente (sem history.pushState/hash) e a autenticação é via token em
// localStorage (não usa cookie) — então não existe "base path" pra
// reconfigurar dentro do app. Só precisamos, na borda, direcionar /app/*
// pro mesmo conteúdo que já existe hoje, sem tocar no index.html/worker.js
// da API. Isso reduz drasticamente o risco de regressão.
//
// IMPORTANTE: preencher APP_ORIGIN e LANDING_ORIGIN abaixo (ou via
// variável de ambiente no wrangler.toml — ver geoflorestando_router.wrangler.toml)
// com a URL *.pages.dev de cada projeto Cloudflare Pages.

// Endereço que recebe as mensagens do formulário de contato da landing.
const CONTATO_DESTINO = "contato@geoflorestando.com";

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/contato — recebe o formulário da landing e envia por e-mail via
// Resend, no mesmo padrão já usado pelo worker.js do geosiga-api
// (env.RESEND_API_KEY, POST https://api.resend.com/emails). É um secret
// PRÓPRIO deste Worker — precisa ser configurado aqui também (não herda do
// geosiga-api), com `npx wrangler secret put RESEND_API_KEY`.
async function handleContato(request, env) {
  if (!env.RESEND_API_KEY) {
    return jsonResponse({ ok: false, erro: "Envio de e-mail não configurado no servidor." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }

  const nome = String(body?.nome || "").trim().slice(0, 200);
  const email = String(body?.email || "").trim().slice(0, 200);
  const mensagem = String(body?.mensagem || "").trim().slice(0, 5000);
  // Honeypot: campo escondido no formulário via CSS — só bots costumam
  // preenchê-lo. Se vier preenchido, finge sucesso sem enviar nada.
  const honeypot = String(body?.empresa || "").trim();

  if (honeypot) {
    return jsonResponse({ ok: true });
  }
  if (!nome || !email || !mensagem) {
    return jsonResponse({ ok: false, erro: "Preencha nome, e-mail e mensagem." }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ ok: false, erro: "E-mail inválido." }, 400);
  }

  const corpo = [
    `Nova mensagem pelo formulário de contato da landing (geoflorestando.com).`,
    ``,
    `Nome: ${nome}`,
    `E-mail: ${email}`,
    ``,
    mensagem,
  ].join("\n");

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "GeoFlorestando <alertas@geoflorestando.com>",
        to: [CONTATO_DESTINO],
        subject: `[GeoFlorestando][Contato] Mensagem de ${nome}`,
        text: corpo,
        reply_to: [email],
      }),
    });
    if (!resp.ok) {
      const detalhe = await resp.text().catch(() => "");
      console.error("Resend erro:", resp.status, detalhe);
      return jsonResponse({ ok: false, erro: "Falha ao enviar. Tente novamente em instantes." }, 502);
    }
  } catch (e) {
    console.error("Resend exceção:", e.message);
    return jsonResponse({ ok: false, erro: "Falha ao enviar. Tente novamente em instantes." }, 502);
  }

  return jsonResponse({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const APP_ORIGIN = env.APP_ORIGIN;         // ex: https://geosiga-app.pages.dev
    const LANDING_ORIGIN = env.LANDING_ORIGIN; // ex: https://geoflorestando-landing.pages.dev

    if (url.pathname === "/api/contato" && request.method === "POST") {
      return handleContato(request, env);
    }

    if (!APP_ORIGIN || !LANDING_ORIGIN) {
      return new Response(
        "geoflorestando-router: defina APP_ORIGIN e LANDING_ORIGIN no wrangler.toml (ou no dashboard, em Settings > Variables).",
        { status: 500 }
      );
    }

    // "/app" sem barra final precisa virar "/app/" antes de servir o
    // conteúdo. Motivo: o index.html só usa caminhos relativos ("./favicon.ico",
    // "./manifest.json"...). Sem a barra, o navegador resolve esses caminhos
    // relativos à RAIZ do domínio (não a "/app/"), e favicon/manifest/ícones
    // quebram — foi exatamente esse sintoma observado (sistema carregou, mas
    // o ícone da aba não). Com a barra, tudo resolve certo, sem precisar
    // mexer no index.html (que continua idêntico ao servido em
    // app.geoflorestando.com).
    if (url.pathname === "/app") {
      const redirectUrl = new URL(url.toString());
      redirectUrl.pathname = "/app/";
      return Response.redirect(redirectUrl.toString(), 301);
    }

    const isApp = url.pathname === "/app" || url.pathname.startsWith("/app/");

    let target;
    if (isApp) {
      // /app         -> /        (raiz do projeto Pages do sistema)
      // /app/        -> /
      // /app/foo.png -> /foo.png
      let strippedPath = url.pathname.slice("/app".length);
      if (strippedPath === "") strippedPath = "/";
      target = new URL(strippedPath + url.search, APP_ORIGIN);
    } else {
      target = new URL(url.pathname + url.search, LANDING_ORIGIN);
    }

    // Repassa a requisição original (método, headers, corpo) pro Pages de
    // destino — mantém o comportamento de refresh direto e deep-link.
    const proxied = new Request(target.toString(), request);
    const resp = await fetch(proxied);

    // Devolve a resposta como veio (assets, headers de cache, etc.).
    return resp;
  },
};
