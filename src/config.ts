import "dotenv/config";

export const config = {
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  tavilyKey: process.env.TAVILY_API_KEY ?? "",
  /** Answering model: strong enough to compare sources and admit uncertainty. */
  model: process.env.MODEL || "claude-sonnet-5-5",
  /** Background memory notes: cheap and fast, never on the critical path. */
  fastModel: process.env.FAST_MODEL || "claude-haiku-5-5",
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || "data/memory.db",
};

export function missingKeys(): string[] {
  return [!config.anthropicKey && "ANTHROPIC_API_KEY", !config.tavilyKey && "TAVILY_API_KEY"].filter(Boolean) as string[];
}
