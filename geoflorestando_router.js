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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const APP_ORIGIN = env.APP_ORIGIN;         // ex: https://geosiga-app.pages.dev
    const LANDING_ORIGIN = env.LANDING_ORIGIN; // ex: https://geoflorestando-landing.pages.dev

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