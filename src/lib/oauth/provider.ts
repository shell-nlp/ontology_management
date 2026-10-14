import { createAccessToken, userFromAccessToken } from "@/lib/platform/auth";
import type { PlatformUserView } from "@/lib/platform/platform-db";

/**
 * 授权服务器这一层的**接口**（用户口径：换存储 / 换中间件要方便，别让上层直接依赖具体实现）。
 *
 * 现在只有本地实现：我们自己签发、自己校验访问令牌。
 * 将来要接企业统一认证 / Keycloak，只需要再写一个实现：
 * 1. `authorizationServer(origin)` 返回外部 AS 的地址（写进 protected-resource 元数据，客户端照着去授权）；
 * 2. `verifyAccessToken` 拉它的 JWKS 验签，再把令牌里的身份**映射到平台账号**
 *    （按邮箱或 sub 找 `findSessionUser`），映射不出来的令牌一律当无效。
 * 上层（MCP 端点、元数据路由）一行都不用动。
 */
export type OAuthProvider = {
  kind: "LOCAL" | "EXTERNAL";
  /** 客户端该去哪个授权服务器拿令牌：本地实现就是自己。 */
  authorizationServer(origin: string): string;
  /** 签一枚访问令牌（只有本地实现会用到；接外部 AS 时这条不用实现）。 */
  issueAccessToken(input: { userId: string; email: string; clientId: string }): Promise<string>;
  /** 验一枚访问令牌 → 平台账号；验不过一律 null。 */
  verifyAccessToken(token: string): Promise<PlatformUserView | null>;
};

const localProvider: OAuthProvider = {
  kind: "LOCAL",
  authorizationServer: (origin) => origin,
  issueAccessToken: createAccessToken,
  verifyAccessToken: userFromAccessToken,
};

/** 当前生效的实现。现在是常量，将来按配置（比如 OAUTH_ISSUER_URL）在这里选。 */
export function oauthProvider(): OAuthProvider {
  return localProvider;
}
