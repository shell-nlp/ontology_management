#!/usr/bin/env node

/**
 * 把"外部 MCP 客户端走 OAuth 接入"这条路**手把手走一遍**，让你亲眼看到那个授权页。
 *
 * 为什么要有它：平台自己实现的那套 OAuth 光看文档很难建立概念 ——
 * 这个脚本扮演一个真实的客户端（自己注册、自己开本机回调端口、自己换令牌），
 * 中间那一步会把浏览器打开到授权页，你登录并点「允许」之后，它继续把剩下的几步跑完。
 *
 * 用法（在你自己的机器上，平台跑着就行）：
 *
 *     pnpm oauth:demo
 *     node scripts/oauth-demo.mjs --platform=http://localhost:3000
 *
 * 参数：
 * - `--platform=<地址>`：平台地址，默认 `http://localhost:3000`（也可以用环境变量 `OAUTH_DEMO_PLATFORM`）。
 * - `--port=<端口>`：本机回调端口，默认 7799。
 * - `--no-open`：不自动开浏览器，只把授权地址打出来（没有图形界面 / 想自己粘的时候用）。
 *
 * 它**只读**：只会调一次 `tools/list` 和一次 `list_ontologies` 给你看结果，不改任何数据。
 * 演示完这个客户端会留在平台的「OAuth 客户端」清单里，你可以留下继续用，也可以去
 * 「MCP 调试 → MCP 接入 → OAuth 客户端」里删掉它。
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (name, fallback) => argv.find((item) => item.startsWith("--" + name + "="))?.slice(name.length + 3) ?? fallback;
const platform = String(arg("platform", process.env.OAUTH_DEMO_PLATFORM ?? "http://localhost:3000")).replace(/\/+$/, "");
const port = Number(arg("port", "7799"));
const openBrowser = !argv.includes("--no-open");
const redirectUri = "http://localhost:" + port + "/callback";

const step = (n, text) => console.log("\n[" + n + "] " + text);
const say = (text) => console.log("    " + text);
const b64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function api(path, init) {
  const response = await fetch(platform + path, init);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: response.status, body };
}

/**
 * 打开浏览器。**Windows 这条要特别小心**：
 *
 * `cmd /c start "" <地址>` 里地址如果不加引号，`&` 会被 cmd 当成命令分隔符 ——
 * 浏览器只会收到第一个 `&` 之前的那半截（实测：只有 client_id，平台回"缺少 redirect_uri"）。
 * 所以这里把地址**用一对双引号包死**，并且用 `windowsVerbatimArguments` 拦住 Node 再加工这一行。
 * 另外 cmd 里 `%` 有变量展开的风险，实测 URL 里的 `%3A` 这类不会被吃掉，但仍保持引号包住。
 */
function openInBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", 'start "" "' + url + '"'], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
      return;
    }
    const [command, args] = process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    say("（没能自动打开浏览器，把上面那个地址手动粘到浏览器里就行。）");
  }
}

async function main() {
  console.log("平台：" + platform);
  console.log("本机回调：" + redirectUri);

  step(1, "先确认平台在跑、而且已经支持 OAuth");
  const meta = await api("/.well-known/oauth-protected-resource").catch(() => null);
  if (!meta || meta.status !== 200) {
    console.log("\n连不上平台的发现文档（" + platform + "/.well-known/oauth-protected-resource）。");
    console.log("请先确认平台在跑；如果平台是刚更新过的代码，重启一下 dev 再试。");
    process.exit(1);
  }
  say("受保护资源：" + meta.body.resource);
  say("授权服务器：" + meta.body.authorization_servers?.[0]);

  step(2, "客户端自助注册（真实客户端在这一步也是自己注册的）");
  const reg = await api("/api/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "本机演示客户端（oauth:demo）", redirect_uris: [redirectUri] }),
  });
  if (reg.status !== 201) {
    console.log("注册失败：" + JSON.stringify(reg.body));
    process.exit(1);
  }
  const clientId = reg.body.client_id;
  say("client_id = " + clientId);
  say("注意：**没有 client_secret** —— 公开客户端的身份靠「回调地址精确匹配 + PKCE」来把关。");

  step(3, "准备 PKCE 与 state，然后开一个本机端口等回调");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier, "ascii").digest());
  const state = "demo-" + randomBytes(4).toString("hex");
  say("code_verifier 留在本机（不发给任何人的那个），只把它的 SHA-256 发给平台。");

  const callback = new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, redirectUri);
      if (url.pathname !== "/callback") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset=utf-8><title>授权完成</title><body style=\"font:15px/1.7 system-ui;padding:40px\">"
        + "<h2>授权完成，可以关掉这个页面了</h2><p>回到终端看后面几步。</p></body>");
      server.close();
      resolve(url.searchParams);
    });
    server.listen(port, "127.0.0.1");
  });

  const authorizeUrl = platform + "/oauth/authorize?" + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "mcp.read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  step(4, "接下来该弹授权页了 —— 这一步在真实客户端里是它替你打开浏览器");
  say("授权地址：");
  console.log("\n    " + authorizeUrl + "\n");
  if (openBrowser) {
    say("正在打开浏览器…（如果没有自动弹出，就把上面这个地址粘到浏览器里）");
    openInBrowser(authorizeUrl);
  } else {
    say("（--no-open：请把这个地址手动粘到浏览器里）");
  }
  say("页面会先让你登录平台账号，然后问「允许这个客户端访问？」—— 点「允许」。");

  /*
   * 20 秒还没等到回调就先提醒一次（但不放弃）：最常见的原因是浏览器没弹出来，
   * 或者地址被中间环节截断了 —— 这时候把终端里那一整行复制到地址栏就能继续。
   */
  const reminder = setTimeout(() => {
    console.log("\n    —— 还没等到回调。如果浏览器没弹出来、或者页面报错（比如「缺少 redirect_uri」），");
    console.log("       把上面那一整行地址手动复制到浏览器地址栏，重新走一次。\n");
  }, 20000);

  const params = await Promise.race([
    callback,
    new Promise((_, reject) => setTimeout(() => reject(new Error("等超时了（5 分钟没等到回调）。")), 5 * 60 * 1000)),
  ]).catch((error) => {
    console.log("\n" + error.message);
    process.exit(1);
  }).finally(() => clearTimeout(reminder));

  if (params.get("error")) {
    console.log("\n授权没通过：" + params.get("error") + " " + (params.get("error_description") ?? ""));
    console.log("（点「拒绝」也会走到这里 —— 那是正常的，重新跑一次点「允许」就行。）");
    process.exit(1);
  }
  if (params.get("state") !== state) {
    console.log("\nstate 对不上，这次回调不认（这是防 CSRF 用的，正常不该发生）。");
    process.exit(1);
  }
  const code = params.get("code");
  say("回调拿到授权码了（它 60 秒过期、只能用一次）。");

  step(5, "拿授权码 + 刚才留在本机的 code_verifier 换令牌");
  const token = await api("/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  if (token.status !== 200) {
    console.log("换令牌失败：" + JSON.stringify(token.body));
    process.exit(1);
  }
  const access = token.body.access_token;
  say("拿到访问令牌（有效期 " + Math.round((token.body.expires_in ?? 0) / 60) + " 分钟）与刷新令牌（30 天，用一次换一条）。");
  try {
    const payload = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8"));
    say("这枚令牌代表的账号：" + (payload.email ?? payload.sub) + "（到期 " + new Date(payload.exp * 1000).toLocaleString("zh-CN", { hour12: false }) + "）");
  } catch { /* 解不开就不显示，不影响演示 */ }

  step(6, "用这枚令牌真的调一次 MCP（只读）");
  const call = await api("/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + access },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_ontologies", arguments: {} } }),
  });
  if (call.status !== 200) {
    console.log("调 MCP 失败：" + JSON.stringify(call.body));
    process.exit(1);
  }
  if (call.body?.result?.isError) {
    console.log("工具返回了错误：" + JSON.stringify(call.body.result.content ?? call.body.result));
    process.exit(1);
  }
  say("成功了 —— 这条令牌能查数据，而且用的是上面那个账号的权限（只读）。");
  say("返回内容：" + JSON.stringify(call.body.result.structuredContent).slice(0, 400));

  step(7, "再演示一次刷新（真实客户端过期了就靠这一步，不用再弹授权页）");
  const refreshed = await api("/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.body.refresh_token, client_id: clientId }).toString(),
  });
  if (refreshed.status === 200 && refreshed.body.access_token) {
    say("刷新成功：拿到新的一对令牌（旧的刷新令牌当场作废，被偷走也用不了第二次）。");
  } else {
    say("刷新没成功：" + JSON.stringify(refreshed.body));
  }

  console.log("\n演示结束。这个客户端（" + clientId + "）留在平台的「OAuth 客户端」清单里 ——");
  console.log("想留着继续用就留着；想清掉就去「MCP 调试 → MCP 接入 → OAuth 客户端」里删掉它。");
  process.exit(0);
}

main().catch((error) => {
  console.log("\n出错了：" + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
