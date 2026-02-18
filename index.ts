import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { fluxerPlugin } from "./src/channel.js";
import { setFluxerApi } from "./src/runtime.js";

const plugin = {
  id: "fluxer",
  name: "Fluxer",
  description: "Fluxer channel plugin (Discord-compatible)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFluxerApi(api);
    api.registerChannel({ plugin: fluxerPlugin });
  },
};

export default plugin;
