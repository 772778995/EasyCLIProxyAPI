// 探活 UniAPI 凭据：GET /v1/models，401/403 视为失效。输出只含名字和状态，不打印 key。
import { readFile, writeFile } from 'node:fs/promises';

const credsPath = new URL('../src-tauri/resources/uniapi_credentials.json', import.meta.url);
const d = JSON.parse(await readFile(credsPath, 'utf8'));
const base = d.baseUrl.replace(/\/+$/, '');
const results = [];
for (const [index, c] of d.credentials.entries()) {
  let status = 'error';
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${c.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    status = `${res.status}`;
  } catch (error) {
    status = `network-error:${error.name}`;
  }
  results.push({ index, name: c.name, group: c.group, status });
  console.log(`${index}\t${status}\t${c.name}`);
}
const invalid = results.filter((r) => r.status === '401' || r.status === '403');
console.log(`\ntotal: ${results.length}, invalid(401/403): ${invalid.length}`);
await writeFile(new URL('../scripts/credential-check-result.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), JSON.stringify(results, null, 2));
