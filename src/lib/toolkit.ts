import { isSandbox, paypalConfigured, paypalCredentials } from "./config";
import { isRecord } from "./validators";

type ExecutableTool = {
  execute?: (args: unknown, options?: { toolCallId?: string; messages?: unknown[] }) => Promise<unknown> | unknown;
};

type ToolkitLike = {
  getTools: () => Record<string, ExecutableTool>;
};

let loaded: { toolkit: ToolkitLike } | { error: string } | undefined;
let installed: boolean | undefined;

export async function toolkitInstalled(): Promise<boolean> {
  if (installed !== undefined) return installed;
  try {
    await import("@paypal/agent-toolkit/ai-sdk");
    installed = true;
  } catch {
    installed = false;
  }
  return installed;
}

export async function getToolkit(): Promise<ToolkitLike | null> {
  if (!paypalConfigured()) return null;
  if (loaded && "toolkit" in loaded) return loaded.toolkit;
  if (loaded && "error" in loaded) return null;
  try {
    const mod = (await import("@paypal/agent-toolkit/ai-sdk")) as {
      PayPalAgentToolkit: new (config: {
        clientId: string;
        clientSecret: string;
        configuration: {
          actions: Record<string, Record<string, boolean>>;
          context: { sandbox: boolean };
        };
      }) => ToolkitLike;
    };
    const { clientId, clientSecret } = paypalCredentials();
    const toolkit = new mod.PayPalAgentToolkit({
      clientId,
      clientSecret,
      configuration: {
        actions: {
          invoices: {
            create: true,
            list: true,
            send: true,
            get: true,
            recordPayment: true,
          },
        },
        context: { sandbox: isSandbox() },
      },
    });
    loaded = { toolkit };
    installed = true;
    return toolkit;
  } catch (error) {
    loaded = { error: error instanceof Error ? error.message : String(error) };
    return null;
  }
}

export function interpretToolkitPayload(result: unknown): unknown {
  let value = result;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("PayPal Agent Toolkit returned an empty response.");
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      throw new Error(trimmed);
    }
  }
  if (!isRecord(value)) return value;
  if (isRecord(value.error) && typeof value.error.message === "string") {
    throw new Error(value.error.message);
  }
  if (typeof value.message === "string" && typeof value.code === "string" && value.code !== "OK" && !value.id) {
    throw new Error(value.message);
  }
  return value;
}

export async function callPayPalTool(method: string, args: Record<string, unknown>): Promise<unknown> {
  const toolkit = await getToolkit();
  if (!toolkit) throw new Error("PayPal Agent Toolkit is not available.");
  const tool = toolkit.getTools()[method];
  if (!tool?.execute) throw new Error(`PayPal Agent Toolkit tool ${method} is not enabled.`);
  const result = await tool.execute(args, { toolCallId: `splitnote-${method}`, messages: [] });
  return interpretToolkitPayload(result);
}
