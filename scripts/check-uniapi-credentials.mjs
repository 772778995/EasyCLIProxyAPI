// 探活 UniAPI 凭据：GET /v1/models，401/403 视为失效；再查 /dashboard/billing/subscription，
// hard_limit_usd 即剩余额度，<= 0 视为无余额。输出只含名字、状态和余额，不打印 key。
import { readFile, writeFile } from "node:fs/promises";

const credsPath = new URL(
	"../src-tauri/resources/uniapi_credentials.json",
	import.meta.url,
);
let d;
try {
	d = JSON.parse(await readFile(credsPath, "utf8"));
} catch (error) {
	throw new Error(`解析 uniapi_credentials.json 失败: ${error.message}`);
}
const base = d.baseUrl.replace(/\/+$/, "");
const results = [];
for (const [index, c] of d.credentials.entries()) {
	let status = "error";
	let balance = null;
	try {
		const res = await fetch(`${base}/models`, {
			headers: { Authorization: `Bearer ${c.apiKey}` },
			signal: AbortSignal.timeout(15000),
		});
		status = `${res.status}`;
	} catch (error) {
		status = `network-error:${error.name}`;
	}
	if (status === "200") {
		try {
			const res = await fetch(`${base}/dashboard/billing/subscription`, {
				headers: { Authorization: `Bearer ${c.apiKey}` },
				signal: AbortSignal.timeout(15000),
			});
			if (res.status === 401 || res.status === 403) {
				status = `${res.status}`;
			} else if (res.ok) {
				const j = await res.json();
				const v = Number(j.hard_limit_usd);
				if (Number.isFinite(v)) balance = v;
			}
		} catch {
			// 余额查询网络失败不影响失效判定，balance 保持 null 待下次复查
		}
	}
	results.push({ index, name: c.name, group: c.group, status, balance });
	console.log(`${index}\t${status}\t${balance ?? "-"}\t${c.name}`);
}
const invalid = results.filter(
	(r) =>
		r.status === "401" ||
		r.status === "403" ||
		(r.balance !== null && r.balance <= 0),
);
console.log(
	`\ntotal: ${results.length}, invalid(401/403/无余额): ${invalid.length}`,
);
await writeFile(
	new URL(
		"../scripts/credential-check-result.json",
		import.meta.url,
	).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
	JSON.stringify(results, null, 2),
);
