// 从 UniAPI pricing API 拉取模型数据，生成三份产物：
// 1. src-tauri/resources/uniapi_catalog.json —— UniAPI 精选模型目录（含 contextWindow/inputModalities，联网查证值）
// 2. src-tauri/resources/model_prices.json —— 用量成本估算价格表（上游基线 57 条 + UniAPI 覆盖/追加，schemaVersion 1）
// 3. src-tauri/resources/claude_models/model-catalog.json —— Claude agent 上下文窗口/显示名目录（基线 + UniAPI 模型 merge）
// 运行：bun scripts/sync-uniapi-catalog.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://uniapi.ruijie.com.cn/api/pricing";
const TOKEN_PRICE_MULTIPLIER = 2;
const EXPECTED_GEMINI_INPUT = 1.5;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "src-tauri", "resources", "uniapi_catalog.json");
const pricesPath = join(root, "src-tauri", "resources", "model_prices.json");
const pricesBasePath = join(root, "scripts", "model-prices.base.json");
const claudeCatalogPath = join(
	root,
	"src-tauri",
	"resources",
	"claude_models",
	"model-catalog.json",
);

// 精选模型清单。同模型多渠道时保留最便宜渠道；
// 日期后缀版本（如 deepseek-v4-flash-0731）是独立模型，不在此去重范围。
const ACTIVE_MODEL_IDS = new Set([
	"claude-fable-5",
	"claude-haiku-4-5",
	"claude-opus-5",
	"claude-sonnet-5",
	"deepseek-v4-flash",
	"deepseek-v4-flash-maxthink",
	"deepseek-v4-flash-wot",
	"origin-deepseek-v4-flash-vison",
	"origin-deepseek-v4-pro",
	"doubao-seed-2-1-pro-260628",
	"doubao-seed-2-1-turbo-260628",
	"gemini-3.5-flash",
	"glm-5.1",
	"glm-5.2",
	"glm-5.3",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"hy3",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"kimi-k3",
	"MiniMax/MiniMax-M3",
	"qwen3.8-max",
]);

// 上下文窗口（token）。来源：各模型官方文档/发布页，2026-08 联网查证。
const CONTEXT_WINDOWS = {
	"claude-fable-5": 1_000_000,
	"claude-haiku-4-5": 200_000,
	"claude-opus-5": 1_000_000,
	"claude-sonnet-5": 1_000_000,
	"deepseek-v4-flash": 1_000_000,
	"deepseek-v4-flash-maxthink": 1_000_000,
	"deepseek-v4-flash-wot": 1_000_000,
	"origin-deepseek-v4-flash-vison": 1_000_000,
	"origin-deepseek-v4-pro": 1_000_000,
	"doubao-seed-2-1-pro-260628": 1_000_000,
	"doubao-seed-2-1-turbo-260628": 1_000_000,
	"gemini-3.5-flash": 1_048_576,
	"glm-5.1": 200_000,
	"glm-5.2": 1_048_576,
	"glm-5.3": 1_048_576,
	"gpt-5.6-luna": 372_000,
	"gpt-5.6-sol": 372_000,
	"gpt-5.6-terra": 372_000,
	hy3: 256_000,
	"kimi-k2.6": 256_000,
	"kimi-k2.7-code": 256_000,
	"kimi-k3": 1_000_000,
	"MiniMax/MiniMax-M3": 1_000_000,
	"qwen3.8-max": 1_000_000,
};

// 输入模态。来源：各模型官方文档/发布页，2026-08 联网查证。
const INPUT_MODALITIES = {
	"claude-fable-5": ["text", "image"],
	"claude-haiku-4-5": ["text", "image"],
	"claude-opus-5": ["text", "image"],
	"claude-sonnet-5": ["text", "image"],
	"deepseek-v4-flash": ["text"],
	"deepseek-v4-flash-maxthink": ["text"],
	"deepseek-v4-flash-wot": ["text"],
	"origin-deepseek-v4-flash-vison": ["text", "image"],
	"origin-deepseek-v4-pro": ["text"],
	"doubao-seed-2-1-pro-260628": ["text", "image", "video"],
	"doubao-seed-2-1-turbo-260628": ["text", "image", "video"],
	"gemini-3.5-flash": ["text", "image", "audio", "video"],
	"glm-5.1": ["text"],
	"glm-5.2": ["text"],
	"glm-5.3": ["text"],
	"gpt-5.6-luna": ["text", "image"],
	"gpt-5.6-sol": ["text", "image"],
	"gpt-5.6-terra": ["text", "image"],
	hy3: ["text"],
	"kimi-k2.6": ["text", "image", "video"],
	"kimi-k2.7-code": ["text", "image", "video"],
	"kimi-k3": ["text", "image"],
	"MiniMax/MiniMax-M3": ["text", "image", "video"],
	"qwen3.8-max": ["text", "image", "video"],
};

const response = await fetch(SOURCE_URL, {
	headers: {
		Accept: "application/json",
		"User-Agent": "EasyCLIProxyAPI catalog sync",
	},
});
if (!response.ok)
	throw new Error(`UniAPI pricing request failed: HTTP ${response.status}`);
const payload = await response.json();
if (
	!payload?.success ||
	!Array.isArray(payload.data) ||
	payload.data.length === 0
) {
	throw new Error("UniAPI pricing response does not contain a valid catalog");
}

const vendors = new Map(
	(payload.vendors ?? []).map((vendor) => [Number(vendor.id), vendor]),
);
const finiteNonNegative = (value, field, model) => {
	if (value === null || value === undefined) return null;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 0) {
		throw new Error(`${model}.${field} must be a finite non-negative number`);
	}
	return numeric;
};
const rounded = (value) => (value === null ? null : Number(value.toFixed(9)));

const models = payload.data
	.map((raw) => {
		const model = String(raw.model_name ?? "").trim();
		if (!model) throw new Error("UniAPI pricing contains an empty model name");
		const quotaType = Number(raw.quota_type ?? 0);
		if (![0, 1].includes(quotaType))
			throw new Error(`${model}.quota_type is unsupported`);
		const modelRatio =
			finiteNonNegative(raw.model_ratio, "model_ratio", model) ?? 0;
		const modelPrice =
			finiteNonNegative(raw.model_price, "model_price", model) ?? 0;
		const completionRatio =
			finiteNonNegative(raw.completion_ratio, "completion_ratio", model) ?? 0;
		const cacheRatio = finiteNonNegative(raw.cache_ratio, "cache_ratio", model);
		const createCacheRatio = finiteNonNegative(
			raw.create_cache_ratio,
			"create_cache_ratio",
			model,
		);
		const vendor = vendors.get(Number(raw.vendor_id));
		const endpoints = [
			...new Set(
				(raw.supported_endpoint_types ?? []).map(String).filter(Boolean),
			),
		].sort();
		const vendorName = String(vendor?.name ?? `Vendor ${raw.vendor_id}`).trim();
		return {
			id: model,
			vendor: vendorName,
			description: String(raw.description ?? "").trim(),
			tags: String(raw.tags ?? "")
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean),
			supportedEndpoints: endpoints,
			quotaType,
			inputPer1M:
				quotaType === 0 ? rounded(modelRatio * TOKEN_PRICE_MULTIPLIER) : null,
			outputPer1M:
				quotaType === 0
					? rounded(modelRatio * TOKEN_PRICE_MULTIPLIER * completionRatio)
					: null,
			cacheReadPer1M:
				quotaType === 0 && cacheRatio !== null
					? rounded(modelRatio * TOKEN_PRICE_MULTIPLIER * cacheRatio)
					: null,
			cacheCreationPer1M:
				quotaType === 0 && createCacheRatio !== null
					? rounded(modelRatio * TOKEN_PRICE_MULTIPLIER * createCacheRatio)
					: null,
			fixedPrice: quotaType === 1 ? modelPrice : null,
		};
	})
	.filter((model) => ACTIVE_MODEL_IDS.has(model.id))
	.sort((left, right) => left.id.localeCompare(right.id));

const missing = [...ACTIVE_MODEL_IDS].filter(
	(id) => !models.some((model) => model.id === id),
);
if (missing.length > 0)
	throw new Error(`UniAPI pricing no longer provides: ${missing.join(", ")}`);

const gemini = models.find((model) => model.id === "gemini-3.5-flash");
if (!gemini || gemini.inputPer1M !== EXPECTED_GEMINI_INPUT) {
	throw new Error(
		"UniAPI token price multiplier no longer matches the known Gemini price",
	);
}
for (const model of models) {
	if (!(model.id in CONTEXT_WINDOWS))
		throw new Error(`Missing CONTEXT_WINDOWS entry for ${model.id}`);
	if (!(model.id in INPUT_MODALITIES))
		throw new Error(`Missing INPUT_MODALITIES entry for ${model.id}`);
}

// 产物 1：UniAPI 目录（上下文/模态为联网查证值，价格为 UniAPI 实付价）
const catalog = {
	schemaVersion: 1,
	source: SOURCE_URL,
	pricingVersion: String(payload.pricing_version ?? "").trim(),
	tokenPriceMultiplier: TOKEN_PRICE_MULTIPLIER,
	currency: "USD",
	tokenUnit: 1_000_000,
	models: models.map((model) => ({
		...model,
		contextWindow: CONTEXT_WINDOWS[model.id],
		inputModalities: INPUT_MODALITIES[model.id],
	})),
};

// 产物 2：model_prices.json（schemaVersion 1）。上游基线为底，UniAPI 同名覆盖、独有追加。
let basePrices;
try {
	basePrices = JSON.parse(await readFile(pricesBasePath, "utf8"));
} catch (error) {
	throw new Error(`解析 scripts/model-prices.base.json 失败: ${error.message}`);
}
if (basePrices.schemaVersion !== 1) {
	throw new Error(
		`model-prices.base.json schemaVersion must be 1, got ${basePrices.schemaVersion}`,
	);
}
const prices = {
	schemaVersion: 1,
	updatedAt: new Date().toISOString().slice(0, 10),
	models: { ...basePrices.models },
};
for (const model of models) {
	if (model.quotaType !== 0) continue;
	const entry = {
		inputPer1M: model.inputPer1M,
		outputPer1M: model.outputPer1M,
	};
	if (model.cacheReadPer1M !== null)
		entry.cacheReadPer1M = model.cacheReadPer1M;
	if (model.cacheCreationPer1M !== null)
		entry.cacheCreationPer1M = model.cacheCreationPer1M;
	prices.models[model.id] = entry;
}
prices.models = Object.fromEntries(
	Object.entries(prices.models).sort(([left], [right]) =>
		left.localeCompare(right),
	),
);

// 产物 3：claude_models/model-catalog.json。
// merge 规则：基线条目保留原字段，UniAPI 模型补/覆盖 context_window 与 display_name；
// 新条目追加到 models 数组末尾。
let baseClaude;
try {
	baseClaude = JSON.parse(await readFile(claudeCatalogPath, "utf8"));
} catch (error) {
	throw new Error(
		`解析 claude_models/model-catalog.json 失败: ${error.message}`,
	);
}
const displayNames = {
	"claude-fable-5": "Claude Fable 5",
	"claude-haiku-4-5": "Claude Haiku 4.5",
	"claude-opus-5": "Claude Opus 5",
	"claude-sonnet-5": "Claude Sonnet 5",
	"deepseek-v4-flash": "DeepSeek V4 Flash",
	"deepseek-v4-flash-maxthink": "DeepSeek V4 Flash (Max Think)",
	"deepseek-v4-flash-wot": "DeepSeek V4 Flash (Non-Think)",
	"origin-deepseek-v4-flash-vison": "DeepSeek V4 Flash Vision",
	"origin-deepseek-v4-pro": "DeepSeek V4 Pro",
	"doubao-seed-2-1-pro-260628": "Doubao Seed 2.1 Pro",
	"doubao-seed-2-1-turbo-260628": "Doubao Seed 2.1 Turbo",
	"gemini-3.5-flash": "Gemini 3.5 Flash",
	"glm-5.1": "GLM-5.1",
	"glm-5.2": "GLM-5.2",
	"glm-5.3": "GLM-5.3",
	"gpt-5.6-luna": "GPT-5.6-Luna",
	"gpt-5.6-sol": "GPT-5.6-Sol",
	"gpt-5.6-terra": "GPT-5.6-Terra",
	hy3: "Hunyuan Hy3",
	"kimi-k2.6": "Kimi K2.6",
	"kimi-k2.7-code": "Kimi K2.7 Code",
	"kimi-k3": "Kimi K3",
	"MiniMax/MiniMax-M3": "MiniMax M3",
	"qwen3.8-max": "Qwen3.8-Max",
};
const claudeCatalog = {
	fallback_model: baseClaude.fallback_model,
	models: baseClaude.models.map((entry) => {
		const override = CONTEXT_WINDOWS[entry.slug];
		if (override === undefined) return entry;
		return { ...entry, context_window: override };
	}),
};
const existingSlugs = new Set(
	claudeCatalog.models.map((entry) => entry.slug.toLowerCase()),
);
for (const [id, contextWindow] of Object.entries(CONTEXT_WINDOWS)) {
	if (existingSlugs.has(id.toLowerCase())) continue;
	claudeCatalog.models.push({
		slug: id,
		display_name: displayNames[id],
		context_window: contextWindow,
	});
}

const fallbackJson = JSON.stringify(baseClaude.fallback_model, null, 2)
	.split("\n")
	.map((line, index) => (index === 0 ? line : `  ${line}`))
	.join("\n");
const formatEntry = (entry) => {
	const fields = Object.entries(entry)
		.map(([key, value]) => `"${key}": ${JSON.stringify(value)}`)
		.join(", ");
	return `{ ${fields} }`;
};
const claudeCatalogJson = [
	"{",
	`  "fallback_model": ${fallbackJson},`,
	'  "models": [',
	...claudeCatalog.models.map(
		(entry, index) =>
			`    ${formatEntry(entry)}${index < claudeCatalog.models.length - 1 ? "," : ""}`,
	),
	"  ]",
	"}",
	"",
].join("\n");

await Promise.all([
	writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`),
	writeFile(pricesPath, `${JSON.stringify(prices, null, 2)}\n`),
	writeFile(claudeCatalogPath, claudeCatalogJson),
]);
console.log(
	`Wrote ${models.length} UniAPI models (${catalog.pricingVersion}); ` +
		`model_prices: ${Object.keys(prices.models).length} entries; ` +
		`claude catalog: ${claudeCatalog.models.length} entries`,
);
