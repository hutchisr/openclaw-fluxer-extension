import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

let api: OpenClawPluginApi | null = null;

export function setFluxerApi(next: OpenClawPluginApi) {
  api = next;
}

export function getFluxerApi(): OpenClawPluginApi {
  if (!api) {
    throw new Error("Fluxer plugin API not initialized");
  }
  return api;
}
