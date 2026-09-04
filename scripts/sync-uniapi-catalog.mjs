// 从 UniAPI pricing API 拉取模型数据，生成四份产物：
// 1. src-tauri/resources/uniapi_catalog.json —— UniAPI 精选模型目录（含 contextWindow/inputModalities，联网查证值）
// 2. src-tauri/resources/model_prices.json —— 用量成本估算价格表（上游基线 + UniAPI 覆盖/追加）。
//    覆盖 live 全部按 token 计价（quota_type 0）的模型：渠道变体（ali-/tx-/zj-/origin-）与
//    embedding/rerank 同样会产生用量记录，一并收录；quota_type 1 按次计价的模型无法用
//    token 价格表达，跳过
// 3. src-tauri/resources/claude_models/model-catalog.json —— Claude agent 上下文窗口/显示名目录（基线 + UniAPI 模型 merge）
// 4. src-tauri/resources/codex_models/model-catalog.json —— Codex agent 模型目录（基线 + UniAPI 模型 merge）。
//    已有条目按联网查证值覆盖 context/max_context_window 与 input_modalities；
//    缺失条目以 deepseek-v4-flash（上游为第三方 chat-completions 模型配置的保守模板）追加。
//    注意：app 启动时会从 CODEX_MODEL_CATALOG_URL 拉远程目录覆盖本地，该 URL 必须指向本 fork
// 运行：bun scripts/sync-uniapi-catalog.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://uniapi.ruijie.com.cn/api/pricing";
const TOKEN_PRICE_MULTIPLIER = 2;
// 价格哨兵锚点：glm-5.3 的 UniAPI 实付输入价（ratio 0.5479452 × 2），
// 用于校验倍率体系未变。gemini-3.5-flash 渠道下架后不再适用。
const SENTINEL_MODEL_ID = "glm-5.3";
const SENTINEL_EXPECTED_INPUT = 1.0958904;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "src-tauri", "resources", "uniapi_catalog.json");
const pricesPath = join(root, "src-tauri", "resources", "model_prices.json");
const pricesBasePath = join(root, "scripts", "model-prices.base.json");
const claudeCatalogBasePath = join(root, "scripts", "model-catalog.base.json");
const claudeCatalogPath = join(
	root,
	"src-tauri",
	"resources",
	"claude_models",
	"model-catalog.json",
);
const codexCatalogPath = join(
	root,
	"src-tauri",
	"resources",
	"codex_models",
	"model-catalog.json",
);

// 精选模型清单。同模型多渠道时保留最便宜渠道；
// 日期后缀版本（如 deepseek-v4-flash-0731）是独立模型，不在此去重范围。
const ACTIVE_MODEL_IDS = new Set([
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-haiku-4-5",
	"claude-opus-5",
	"claude-sonnet-5",
	"deepseek-v4-flash",
	"deepseek-v4-flash-maxthink",
	"deepseek-v4-flash-wot",
	"origin-deepseek-v4-flash-vision",
	"origin-deepseek-v4-pro",
	"doubao-seed-2-1-pro-260628",
	"doubao-seed-2-1-turbo-260628",
	"glm-5.2",
	"glm-5.3",
	"glm-5.3-flash",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"hy3",
	"hy4",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"kimi-k3",
	"MiniMax/MiniMax-M3",
	"qwen3.6-27b",
	"qwen3.6-35b-a3b",
	"qwen3.7-flash",
	"qwen3.7-flash-non-thinking",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-27b",
	"qwen3.8-flash",
	"qwen3.8-max",
]);

// 上下文窗口（token）。来源：各模型官方文档/发布页，2026-09 联网查证。
const CONTEXT_WINDOWS = {
	"claude-fable-5": 1_000_000,
	"claude-fable-5-1": 1_000_000,
	"claude-haiku-4-5": 200_000,
	"claude-opus-5": 1_000_000,
	"claude-sonnet-5": 1_000_000,
	"deepseek-v4-flash": 1_000_000,
	"deepseek-v4-flash-maxthink": 1_000_000,
	"deepseek-v4-flash-wot": 1_000_000,
	"origin-deepseek-v4-flash-vision": 1_000_000,
	"origin-deepseek-v4-pro": 1_000_000,
	"doubao-seed-2-1-pro-260628": 1_000_000,
	"doubao-seed-2-1-turbo-260628": 1_000_000,
	// gemini-3.5-flash：UniAPI 渠道已下架，不在 ACTIVE_MODEL_IDS；
	// 上游基线仍含该模型，保留联网查证的上下文值用于 claude catalog 覆盖。
	"gemini-3.5-flash": 1_048_576,
	"glm-5.2": 1_048_576,
	"glm-5.3": 1_048_576,
	"glm-5.3-flash": 1_048_576,
	"gpt-5.4": 1_050_000,
	"gpt-5.4-mini": 1_050_000,
	"gpt-5.5": 1_050_000,
	"gpt-5.6": 1_050_000,
	"gpt-5.6-luna": 1_050_000,
	"gpt-5.6-sol": 1_050_000,
	"gpt-5.6-terra": 1_050_000,
	hy3: 256_000,
	hy4: 1_048_576,
	"kimi-k2.6": 256_000,
	"kimi-k2.7-code": 256_000,
	"kimi-k3": 1_000_000,
	"MiniMax/MiniMax-M3": 1_000_000,
	"qwen3.6-27b": 262_144,
	"qwen3.6-35b-a3b": 262_144,
	"qwen3.7-flash": 1_000_000,
	"qwen3.7-flash-non-thinking": 1_000_000,
	"qwen3.7-max": 1_000_000,
	"qwen3.7-plus": 1_000_000,
	"qwen3.8-27b": 1_000_000,
	"qwen3.8-flash": 1_000_000,
	"qwen3.8-max": 1_000_000,
};

// 输入模态。来源：各模型官方文档/发布页，2026-09 联网查证。
const INPUT_MODALITIES = {
	"claude-fable-5": ["text", "image"],
	"claude-fable-5-1": ["text", "image"],
	"claude-haiku-4-5": ["text", "image"],
	"claude-opus-5": ["text", "image"],
	"claude-sonnet-5": ["text", "image"],
	"deepseek-v4-flash": ["text"],
	"deepseek-v4-flash-maxthink": ["text"],
	"deepseek-v4-flash-wot": ["text"],
	"origin-deepseek-v4-flash-vision": ["text", "image"],
	"origin-deepseek-v4-pro": ["text"],
	"doubao-seed-2-1-pro-260628": ["text", "image", "video"],
	"doubao-seed-2-1-turbo-260628": ["text", "image", "video"],
	"glm-5.2": ["text"],
	"glm-5.3": ["text"],
	"glm-5.3-flash": ["text", "image", "video"],
	"gpt-5.4": ["text", "image"],
	"gpt-5.4-mini": ["text", "image"],
	"gpt-5.5": ["text", "image"],
	"gpt-5.6-luna": ["text", "image"],
	"gpt-5.6-sol": ["text", "image"],
	"gpt-5.6-terra": ["text", "image"],
	hy3: ["text"],
	hy4: ["text"],
	"kimi-k2.6": ["text", "image", "video"],
	"kimi-k2.7-code": ["text", "image", "video"],
	"kimi-k3": ["text", "image"],
	"MiniMax/MiniMax-M3": ["text", "image", "video"],
	"qwen3.6-27b": ["text", "image", "video"],
	"qwen3.6-35b-a3b": ["text", "image", "video"],
	"qwen3.7-flash": ["text", "image", "video"],
	"qwen3.7-flash-non-thinking": ["text", "image", "video"],
	"qwen3.7-max": ["text", "image", "video"],
	"qwen3.7-plus": ["text", "image", "video"],
	"qwen3.8-27b": ["text", "image", "video"],
	"qwen3.8-flash": ["text", "image", "video"],
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

const allModels = payload.data
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
	.sort((left, right) => left.id.localeCompare(right.id));

// 精选目录模型：精选清单内的子集（上下文/模态均已联网查证）
const models = allModels.filter((model) => ACTIVE_MODEL_IDS.has(model.id));

const missing = [...ACTIVE_MODEL_IDS].filter(
	(id) => !models.some((model) => model.id === id),
);
if (missing.length > 0)
	throw new Error(`UniAPI pricing no longer provides: ${missing.join(", ")}`);

const sentinel = models.find((model) => model.id === SENTINEL_MODEL_ID);
if (!sentinel || sentinel.inputPer1M !== SENTINEL_EXPECTED_INPUT) {
	throw new Error(
		"UniAPI token price multiplier no longer matches the known glm-5.3 price",
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
// 覆盖 live 全部 quota_type 0 模型：用量统计按模型名精确匹配价格，
// 不在精选目录里的模型照样会被调用并产生用量记录。
for (const model of allModels) {
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
// merge 规则：基线（scripts/model-catalog.base.json，上游纯净版）条目保留原字段，
// UniAPI 模型补/覆盖 context_window 与 display_name；新条目追加到 models 数组末尾。
// 从 base 读取保证幂等：移出 ACTIVE_MODEL_IDS 的模型下次运行时自动从产物中消失。
let baseClaude;
try {
	baseClaude = JSON.parse(await readFile(claudeCatalogBasePath, "utf8"));
} catch (error) {
	throw new Error(
		`解析 scripts/model-catalog.base.json 失败: ${error.message}`,
	);
}
const displayNames = {
	"claude-fable-5": "Claude Fable 5",
	"claude-fable-5-1": "Claude Fable 5.1",
	"claude-haiku-4-5": "Claude Haiku 4.5",
	"claude-opus-5": "Claude Opus 5",
	"claude-sonnet-5": "Claude Sonnet 5",
	"deepseek-v4-flash": "DeepSeek V4 Flash",
	"deepseek-v4-flash-maxthink": "DeepSeek V4 Flash (Max Think)",
	"deepseek-v4-flash-wot": "DeepSeek V4 Flash (Non-Think)",
	"origin-deepseek-v4-flash-vision": "DeepSeek V4 Flash Vision",
	"origin-deepseek-v4-pro": "DeepSeek V4 Pro",
	"doubao-seed-2-1-pro-260628": "Doubao Seed 2.1 Pro",
	"doubao-seed-2-1-turbo-260628": "Doubao Seed 2.1 Turbo",
	"glm-5.2": "GLM-5.2",
	"glm-5.3": "GLM-5.3",
	"glm-5.3-flash": "GLM-5.3 Flash",
	"gpt-5.4": "GPT-5.4",
	"gpt-5.4-mini": "GPT-5.4 Mini",
	"gpt-5.5": "GPT-5.5",
	"gpt-5.6-luna": "GPT-5.6-Luna",
	"gpt-5.6-sol": "GPT-5.6-Sol",
	"gpt-5.6-terra": "GPT-5.6-Terra",
	hy3: "Hunyuan Hy3",
	hy4: "Hunyuan Hy4",
	"kimi-k2.6": "Kimi K2.6",
	"kimi-k2.7-code": "Kimi K2.7 Code",
	"kimi-k3": "Kimi K3",
	"MiniMax/MiniMax-M3": "MiniMax M3",
	"qwen3.6-27b": "Qwen3.6-27B",
	"qwen3.6-35b-a3b": "Qwen3.6-35B-A3B",
	"qwen3.7-flash": "Qwen3.7-Flash",
	"qwen3.7-flash-non-thinking": "Qwen3.7-Flash (Non-Thinking)",
	"qwen3.7-max": "Qwen3.7-Max",
	"qwen3.7-plus": "Qwen3.7-Plus",
	"qwen3.8-27b": "Qwen3.8-27B",
	"qwen3.8-flash": "Qwen3.8-Flash",
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

// 产物 4：codex_models/model-catalog.json。
// 以现有目录为基线（编译时 include_str 内置 + app 启动后从本 fork raw 地址拉取），
// UniAPI 精选模型合入：已有条目覆盖 context/input_modalities，缺失条目按 deepseek 模板追加。
let codexCatalog;
try {
	codexCatalog = JSON.parse(await readFile(codexCatalogPath, "utf8"));
} catch (error) {
	throw new Error(`解析 codex_models/model-catalog.json 失败: ${error.message}`);
}
const codexTemplate = codexCatalog.models.find(
	(entry) => entry.slug === "deepseek-v4-flash",
);
if (!codexTemplate) {
	throw new Error("codex 目录缺少 deepseek-v4-flash 模板条目");
}
const codexBySlug = new Map(
	codexCatalog.models.map((entry) => [entry.slug.toLowerCase(), entry]),
);
let codexAdded = 0;
let codexUpdated = 0;
for (const model of models) {
	const contextWindow = CONTEXT_WINDOWS[model.id];
	const modalities = INPUT_MODALITIES[model.id];
	const existing = codexBySlug.get(model.id.toLowerCase());
	if (existing) {
		existing.context_window = contextWindow;
		existing.max_context_window = contextWindow;
		existing.input_modalities = modalities;
		codexUpdated += 1;
		continue;
	}
	const entry = structuredClone(codexTemplate);
	entry.slug = model.id;
	entry.display_name = displayNames[model.id];
	entry.description = `${displayNames[model.id]} served via UniAPI with a ${contextWindow.toLocaleString("en-US")} token context window.`;
	entry.context_window = contextWindow;
	entry.max_context_window = contextWindow;
	entry.input_modalities = modalities;
	if (entry.model_messages?.instructions_template) {
		entry.model_messages.instructions_template =
			entry.model_messages.instructions_template.replace(
				"powered by a DeepSeek model",
				"powered by an open model",
		);
	}
	codexCatalog.models.push(entry);
	codexBySlug.set(model.id.toLowerCase(), entry);
	codexAdded += 1;
}

await Promise.all([
	writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`),
	writeFile(pricesPath, `${JSON.stringify(prices, null, 2)}\n`),
	writeFile(claudeCatalogPath, claudeCatalogJson),
	writeFile(codexCatalogPath, `${JSON.stringify(codexCatalog, null, 2)}\n`),
]);
console.log(
	`Wrote ${models.length} UniAPI models (${catalog.pricingVersion}); ` +
		`model_prices: ${Object.keys(prices.models).length} entries; ` +
		`claude catalog: ${claudeCatalog.models.length} entries; ` +
		`codex catalog: ${codexCatalog.models.length} entries (+${codexAdded} added, ${codexUpdated} updated)`,
);
