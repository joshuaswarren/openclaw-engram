api.on("before_agent_start", async () => {});
api.on("agent_end", async () => {});
registerCli(api as unknown as Foo, orchestrator);
api.registerService({ id: "openclaw-engram", start: async () => {}, stop: () => {} });
