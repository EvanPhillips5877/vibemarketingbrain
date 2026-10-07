import { OAuth2Client } from "google-auth-library";

// What the auth routes need from an identity provider. Google is the real
// one; tests inject a fake so the routes, allowlist and sessions are
// exercised without the network.
export interface Identity {
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface IdentityProvider {
  /** Where to send the browser to sign in. */
  startUrl(state: string, redirectUri: string): string;
  /** Turn the callback's code into a verified identity. Throws on any failure. */
  complete(code: string, redirectUri: string): Promise<Identity>;
}

export function googleIdentityProvider(clientId: string, clientSecret: string): IdentityProvider {
  return {
    startUrl(state, redirectUri) {
      const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
      return client.generateAuthUrl({
        access_type: "online",
        scope: ["openid", "email", "profile"],
        state,
        prompt: "select_account",
      });
    },
    async complete(code, redirectUri) {
      const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) throw new Error("Google returned no id_token");
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.email) throw new Error("Google id_token carries no email");
      return {
        email: payload.email,
        emailVerified: payload.email_verified === true,
        name: payload.name ?? null,
      };
    },
  };
}
