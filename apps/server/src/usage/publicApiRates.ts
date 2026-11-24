import type { ModelRate } from "./usagePricing.ts";

export const publicApiRatesVerified = "2026-11-24";

const sources = {
  openai: "https://developers.openai.com/api/docs/pricing",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  google: "https://ai.google.dev/gemini-api/docs/pricing",
} as const;

// USD per million text tokens. Reasoning is billed as output and is already
// included in outputTokens. Cache writes use the recorded retention tier where available.
type Rates = readonly [
  input: number,
  cached: number,
  output: number,
  write?: number,
  write1h?: number,
];
interface ModelPrice {
  readonly source: keyof typeof sources;
  readonly standard: Rates;
  readonly fast?: number;
  readonly ultrafast?: number;
  readonly ultrafastUntil?: number;
  readonly flex?: number;
  readonly longContext?: boolean;
  readonly next?: { readonly at: number; readonly standard: Rates };
}

const december = Date.parse("2026-12-01T00:00:00-08:00");
const march = Date.parse("2027-03-01T00:00:00-08:00");
const googlePromotion = { at: december, standard: [4, 0.2, 20] } as const;

const prices: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { source: "anthropic", standard: [4, 0.2, 20, 5, 8], fast: 2 },
  "claude-fable-5-2": { source: "anthropic", standard: [8, 0.2, 40, 10, 16], fast: 2 },
  "claude-sonnet-5-5": { source: "anthropic", standard: [2, 0.1, 10, 2.5, 4] },
  "claude-sonnet-4-6": { source: "anthropic", standard: [3, 0.3, 15, 3.75, 6] },
  "gpt-6.2-astra": {
    source: "openai",
    standard: [8, 0.4, 40, 10],
    fast: 2,
    ultrafast: 3,
    ultrafastUntil: march,
    longContext: true,
  },
  "gpt-6.2-sol": {
    source: "openai",
    standard: [2, 0.1, 10, 2.5],
    fast: 2,
    ultrafast: 3,
    ultrafastUntil: march,
    longContext: true,
  },
  "gpt-6.1-sol": {
    source: "openai",
    standard: [2, 0.1, 10, 2.5],
    fast: 2,
    ultrafast: 6,
    flex: 0.5,
    longContext: true,
  },
  "gpt-6.1-terra": {
    source: "openai",
    standard: [1, 0.05, 5, 1.25],
    fast: 2,
    flex: 0.5,
    longContext: true,
  },
  "gemini-4-neon": { source: "google", standard: [3, 0.15, 15] },
  "gemini-4-carbon": { source: "google", standard: [2, 0.1, 10], next: googlePromotion },
  "gemini-4-argon": { source: "google", standard: [2, 0.1, 10], next: googlePromotion },
};

function rate(
  [input, cached, output, write, write1h]: Rates,
  multiple: number,
  long: boolean,
): ModelRate {
  const inputFactor = (multiple * (long ? 2 : 1)) / 1_000_000;
  return {
    inputCostPerToken: input * inputFactor,
    cacheReadCostPerToken: cached * inputFactor,
    outputCostPerToken: (output * multiple * (long ? 1.5 : 1)) / 1_000_000,
    cacheCreationCostPerToken: write === undefined ? null : write * inputFactor,
    cacheCreation1hCostPerToken: write1h === undefined ? null : write1h * inputFactor,
  };
}

function buildRate(price: ModelPrice, tokens: Rates, ultrafast = price.ultrafast): ModelRate {
  const tier = (multiple: number): ModelRate => ({
    ...rate(tokens, multiple, false),
    ...(price.longContext ? { above272kTokens: rate(tokens, multiple, true) } : {}),
  });
  return {
    ...tier(1),
    ...(price.fast === undefined ? {} : { priority: tier(price.fast) }),
    ...(price.flex === undefined ? {} : { flex: tier(price.flex) }),
    ...(ultrafast === undefined ? {} : { ultrafast: tier(ultrafast) }),
  };
}

export const publicApiRatesIdentity = JSON.stringify([publicApiRatesVerified, sources, prices]);

const models = new Map(
  Object.entries(prices).map(([model, price]) => [
    model,
    {
      standard: buildRate(price, price.standard),
      next: price.next
        ? { at: price.next.at, rate: buildRate(price, price.next.standard) }
        : price.ultrafastUntil
          ? { at: price.ultrafastUntil, rate: buildRate(price, price.standard, 6) }
          : undefined,
    },
  ]),
);

export function publicApiRate(model: string, timestampMs: number): ModelRate | undefined {
  const name = model
    .trim()
    .toLowerCase()
    .split("[", 1)[0]!
    .replace(/^(?:openai\/(?=gpt-)|anthropic\/(?=claude-)|(?:google|gemini)\/(?=gemini-))/, "")
    .replace(/^(claude-(?:opus|sonnet|fable)-\d+)\.(\d+)$/, "$1-$2");
  const price = models.get(name);
  return price?.next && timestampMs >= price.next.at ? price.next.rate : price?.standard;
}
