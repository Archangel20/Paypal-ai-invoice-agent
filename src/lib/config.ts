export function paypalCredentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: process.env.PAYPAL_CLIENT_ID?.trim() || "",
    clientSecret: (process.env.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_SECRET || "").trim(),
  };
}

export function paypalConfigured(): boolean {
  const { clientId, clientSecret } = paypalCredentials();
  return Boolean(clientId && clientSecret);
}

export function isSandbox(): boolean {
  const env = (process.env.PAYPAL_ENV || "sandbox").trim().toLowerCase();
  return env !== "live" && env !== "production";
}

export function paypalEnvLabel(): string {
  return isSandbox() ? "sandbox" : "live";
}

export function paypalBaseUrl(): string {
  return isSandbox() ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
}

export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE !== "false";
}

export function llmConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function modelName(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

export function llmProviderLabel(): string {
  return process.env.OPENAI_BASE_URL?.trim() ? "openai-compatible" : "openai";
}
