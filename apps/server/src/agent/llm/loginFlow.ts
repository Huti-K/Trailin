import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { LoginFlowStatus } from "@trailin/shared";
import { errorMessage } from "../../core/utils/util.js";
import { credentialStore } from "./credentialStore.js";
import { modelRegistry } from "./registry.js";

interface Flow {
  providerId: string;
  providerName: string;
  status: LoginFlowStatus;
  pendingInput?: (value: string) => void;
  pendingSelect?: (optionId: string) => void;
  abort: AbortController;
}

let flow: Flow | null = null;

export function getLoginStatus(): LoginFlowStatus {
  if (!flow) return { providerId: null, done: true };
  return { ...flow.status };
}

export function startLogin(
  providerId: string,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): LoginFlowStatus {
  if (flow && !flow.status.done) {
    if (flow.providerId === providerId) return { ...flow.status };
    throw new Error(`A login for "${flow.providerName}" is already in progress. Cancel it first.`);
  }

  const oauth = modelRegistry.getProvider(providerId)?.auth.oauth;
  if (!oauth) {
    throw new Error(`Provider "${providerId}" has no subscription login. Use an API key instead.`);
  }

  const abort = new AbortController();
  const f: Flow = {
    providerId,
    providerName: oauth.name,
    abort,
    status: {
      providerId,
      providerName: oauth.name,
      done: false,
    },
  };
  flow = f;

  const waitForInput = (): Promise<string> =>
    new Promise<string>((resolveInput, rejectInput) => {
      f.pendingInput = resolveInput;
      abort.signal.addEventListener("abort", () => rejectInput(new Error("cancelled")), {
        once: true,
      });
    });

  const handlePrompt = (prompt: AuthPrompt): Promise<string> => {
    if (prompt.type === "select") {
      return new Promise<string>((resolveSelect, rejectSelect) => {
        f.status.select = {
          message: prompt.message,
          options: prompt.options.map(({ id, label }) => ({ id, label })),
        };
        f.pendingSelect = resolveSelect;
        abort.signal.addEventListener("abort", () => rejectSelect(new Error("cancelled")), {
          once: true,
        });
      });
    }
    f.status.prompt = { message: prompt.message, placeholder: prompt.placeholder };
    return waitForInput();
  };

  const handleEvent = (event: AuthEvent): void => {
    switch (event.type) {
      case "auth_url":
        f.status.authUrl = event.url;
        f.status.instructions = event.instructions;
        break;
      case "device_code":
        f.status.deviceCode = {
          userCode: event.userCode,
          verificationUri: event.verificationUri,
        };
        break;
      case "info":
      case "progress":
        log.info(`[llm-auth:${providerId}] ${event.message}`);
        break;
    }
  };

  oauth
    .login({ signal: abort.signal, prompt: handlePrompt, notify: handleEvent })
    .then(async (credential) => {
      await credentialStore.modify(providerId, async () => credential);
      f.status.done = true;
      log.info(`[llm-auth:${providerId}] signed in via ${oauth.name}`);
    })
    .catch((error) => {
      f.status.done = true;
      f.status.error = abort.signal.aborted ? "Login cancelled." : errorMessage(error);
      log.warn(`[llm-auth:${providerId}] login failed: ${f.status.error}`);
    });

  return { ...f.status };
}

export function provideLoginInput(value: string): void {
  if (!flow || flow.status.done || !flow.pendingInput) {
    throw new Error("No login prompt is waiting for input.");
  }
  const resolveInput = flow.pendingInput;
  flow.pendingInput = undefined;
  flow.status.prompt = undefined;
  resolveInput(value);
}

export function provideLoginSelection(optionId: string): void {
  if (!flow || flow.status.done || !flow.pendingSelect) {
    throw new Error("No login selection is pending.");
  }
  const resolveSelect = flow.pendingSelect;
  flow.pendingSelect = undefined;
  flow.status.select = undefined;
  resolveSelect(optionId);
}

export function cancelLogin(): void {
  if (flow && !flow.status.done) {
    flow.abort.abort();
    flow.pendingInput = undefined;
    flow.pendingSelect = undefined;
  }
}
