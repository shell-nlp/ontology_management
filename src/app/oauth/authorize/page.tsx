import { Suspense } from "react";
import { OAuthConsent } from "@/components/oauth-consent";

/**
 * 外部 MCP 客户端把人送过来的**授权同意页**（OAuth 授权码流程的中间那一步）。
 *
 * 地址形如 `/oauth/authorize?client_id=…&redirect_uri=…&code_challenge=…`；
 * 用户在页面上登录 + 点「允许」之后，浏览器才会带着授权码跳回客户端。
 * 这里不做任何安全判断 —— 判断全在 `/api/oauth/authorize`（服务端）。
 */
export const dynamic = "force-dynamic";

export default function OAuthAuthorizePage() {
  return (
    <Suspense fallback={null}>
      <OAuthConsent />
    </Suspense>
  );
}
