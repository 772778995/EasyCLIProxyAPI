// 将内核 UniAPI provider 的模型清单与 UniAPI /v1/models 对齐：
// - 内核 provider 缺失的模型 → 补入（带精选目录里联网查证的 max-context-length）
// - provider 里有但 UniAPI 已下架的精选模型 → 移除（渠道变体 ali-/tx-/zj- 与用户手动加的模型不动）
// 通过管理 API 写入（与 app 的「API 接入」页面同一通道），内核热生效并持久化。
// 前置：内核正在运行（需要管理端口与密钥）。
// 运行：bun scripts/sync-uniapi-providers.mjs [--base-url http://127.0.0.1:8317] [--key KEY]
import { readFile } from "node:fs/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
	args.set(process.argv[i], process.argv[i + 1]);
}

const UNIAPI_BASE = "https://uniapi.ruijie.com.cn/v1";

// 定位内核管理端口与密钥：app 的 config.toml（Windows: %LOCALAPPDATA%/EasyCLIProxyAPI）
function guiConfigPath() {
	if (process.platform === "win32") {
		return `${process.env.LOCALAPPDATA}\\EasyCLIProxyAPI\\config.toml`;
	}
	if (process.platform === "darwin") {
		return `${process.env.HOME}/Library/Application Support/EasyCLIProxyAPI/config.toml`;
	}
	return `${process.env.HOME}/.config/EasyCLIProxyAPI/config.toml`;
}

async function readJson(path, label) {
	let content;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`读取 ${label} 失败: ${error.message}`);
	}
	try {
		return JSON.parse(content);
	} catch (error) {
		throw new Error(`解析 ${label} 失败: ${error.message}`);
	}
}

async function resolveManagement() {
	const baseUrl = args.get("--base-url");
	const key = args.get("--key");
	if (baseUrl && key) return { baseUrl, key };
	const toml = await readFile(guiConfigPath(), "utf8");
	const portMatch = toml.match(/^port\s*=\s*(\d+)/m);
	const keyMatch = toml.match(/^management-secret-key\s*=\s*"([^"]*)"/m);
	if (!portMatch || !keyMatch || !keyMatch[1]) {
		throw new Error(
			"无法从 config.toml 解析管理端口或密钥，请用 --base-url 与 --key 显式指定",
		);
	}
	return { baseUrl: `http://127.0.0.1:${portMatch[1]}`, key: keyMatch[1] };
}

// UniAPI 凭据（与探活脚本同一份资源文件），取第一个 key 拉模型列表
async function fetchUniApiModels() {
	const creds = await readJson(
		new URL("../src-tauri/resources/uniapi_credentials.json", import.meta.url).pathname
			.replace(/^\/([A-Za-z]:)/, "$1"),
		"uniapi_credentials.json",
	);
	if (!creds.credentials?.length) {
		throw new Error("uniapi_credentials.json 不包含任何凭据");
	}
	const response = await fetch(`${UNIAPI_BASE}/models`, {
		headers: { Authorization: `Bearer ${creds.credentials[0].apiKey}` },
		signal: AbortSignal.timeout(30000),
	});
	if (!response.ok) {
		throw new Error(`UniAPI /v1/models 请求失败: HTTP ${response.status}`);
	}
	const payload = await response.json();
	const ids = (payload.data ?? []).map((m) => String(m.id).trim()).filter(Boolean);
	if (!ids.length) throw new Error("UniAPI /v1/models 返回空列表");
	return ids;
}

async function main() {
	const { baseUrl, key } = await resolveManagement();
	const headers = {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
	};

	// 精选目录：上下文窗口来源 + 该纳入哪些模型的判断依据
	const catalog = await readJson(
		new URL("../src-tauri/resources/uniapi_catalog.json", import.meta.url).pathname
			.replace(/^\/([A-Za-z]:)/, "$1"),
		"uniapi_catalog.json",
	);
	const curated = new Map(catalog.models.map((m) => [m.id, m.contextWindow]));

	const uniapiModels = await fetchUniApiModels();
	const uniapiSet = new Set(uniapiModels);

	const response = await fetch(`${baseUrl}/v0/management/openai-compatibility`, {
		headers,
	});
	if (!response.ok) {
		throw new Error(`读取内核 provider 配置失败: HTTP ${response.status}`);
	}
	const providers = (await response.json())["openai-compatibility"];
	if (!Array.isArray(providers) || providers.length === 0) {
		throw new Error("内核没有配置任何 openai-compatibility provider");
	}

	// 只处理指向 UniAPI 的 provider
	const uniapiProviders = providers.filter((p) =>
		String(p["base-url"] ?? "").startsWith("https://uniapi.ruijie.com.cn"),
	);
	if (!uniapiProviders.length) {
		throw new Error("没有指向 UniAPI 的 provider，请先在 app 中接入");
	}

	let added = 0;
	let removed = 0;
	const touched = [];
	for (const provider of uniapiProviders) {
		const before = provider.models.length;
		const names = new Set(provider.models.map((m) => m.name));
		// 补：精选目录里 UniAPI 仍提供、provider 缺失的模型
		for (const [id, contextWindow] of curated) {
			if (!uniapiSet.has(id)) continue; // UniAPI 已下架，不补
			if (!names.has(id)) {
				provider.models.push({ name: id, alias: "", "max-context-length": contextWindow });
				names.add(id);
				added += 1;
			}
		}
		// 删：provider 有、精选目录有记录但 UniAPI 已下架的模型。
		// 不在精选目录里的模型（渠道变体、embedding 等）是用户手动加的，不动。
		provider.models = provider.models.filter((model) => {
			if (!curated.has(model.name)) return true;
			if (uniapiSet.has(model.name)) return true;
			removed += 1;
			return false;
		});
		provider.models.sort((a, b) => a.name.localeCompare(b.name));
		if (provider.models.length !== before) touched.push(provider.name);
	}
	if (!touched.length) {
		console.log(`UniAPI ${uniapiModels.length} 个模型，provider 已对齐，无需变更`);
		return;
	}

	const put = await fetch(`${baseUrl}/v0/management/openai-compatibility`, {
		method: "PUT",
		headers,
		body: JSON.stringify(providers),
	});
	const putBody = await put.text();
	if (!put.ok) {
		throw new Error(`写入内核 provider 配置失败: HTTP ${put.status} ${putBody}`);
	}

	// 验证：内核 /v1/models 现在暴露精选目录全部可用模型。
	// 代理 API key 从管理接口的 config 里取，不硬编码。
	const configResponse = await fetch(`${baseUrl}/v0/management/config`, { headers });
	const proxyApiKey = configResponse.ok
		? (await configResponse.json())["api-keys"]?.[0]
		: undefined;
	if (proxyApiKey) {
		const verify = await fetch(`${baseUrl}/v1/models`, {
			headers: { Authorization: `Bearer ${proxyApiKey}` },
		});
		if (verify.ok) {
			const verifyPayload = await verify.json();
			const exposed = new Set((verifyPayload.data ?? []).map((m) => m.id));
			const missing = [...curated.keys()].filter(
				(id) => uniapiSet.has(id) && !exposed.has(id),
			);
			if (missing.length) {
				throw new Error(`写入后内核仍未暴露: ${missing.join(", ")}`);
			}
		} else {
			console.warn(`验证请求失败（HTTP ${verify.status}），跳过暴露性校验，请在 app 中刷新确认`);
		}
	} else {
		console.warn("无法获取代理 API key，跳过暴露性校验，请在 app 中刷新确认");
	}

	console.log(
		`已同步 ${touched.length} 个 provider（${touched.join("、")}）：` +
			`+${added} / -${removed} 个模型；UniAPI 当前提供 ${uniapiModels.length} 个，精选 ${curated.size} 个全部就位`,
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
