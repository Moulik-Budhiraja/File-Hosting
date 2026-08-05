#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  if [[ "${REQUIRE_DOCKER:-0}" == "1" ]]; then
    echo "Docker Compose is required but unavailable." >&2
    exit 1
  fi
  echo "Docker Compose unavailable; local runtime check explicitly not executed. CI sets REQUIRE_DOCKER=1."
  exit 0
fi

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/file-hosting-compose-release.XXXXXX")"
created_proxy_network=0
export COMPOSE_PROJECT_NAME="file-hosting-release-${RANDOM}-$$"
export FS_TOKEN="compose-release-synthetic-token-with-enough-entropy"
export FS_PUBLIC_URL="http://127.0.0.1:39741"
export FS_PORT="39741"
export FS_MIN_FREE_BYTES="0"
export FS_FILES_DIR="$temporary_root/files"
export FS_SQLITE_DIR="$temporary_root/sqlite"
mkdir -p "$FS_FILES_DIR" "$FS_SQLITE_DIR"
chmod 700 "$FS_FILES_DIR" "$FS_SQLITE_DIR"
trap 'status=$?; if [[ $status -ne 0 ]]; then docker compose ps >&2 || true; docker compose logs --no-color --tail=200 server >&2 || true; fi; docker compose down --remove-orphans --volumes >/dev/null 2>&1 || true; if [[ "$created_proxy_network" == "1" ]]; then docker network rm nginx-proxy_default >/dev/null 2>&1 || true; fi; rm -rf "$temporary_root"; exit $status' EXIT

if ! docker network inspect nginx-proxy_default >/dev/null 2>&1; then
  docker network create nginx-proxy_default >/dev/null
  created_proxy_network=1
fi
docker compose build
docker compose run --rm --no-deps --entrypoint node server runtime/verify-linux-sandbox.js
docker compose up -d

for _ in $(seq 1 90); do
  if docker compose exec -T server node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 1
done
docker compose exec -T server node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)throw new Error('health');return r.json()}).then(v=>{if(v.status!=='ok')throw new Error('status')}).catch(()=>process.exit(1))"
docker compose exec -T server node -e 'const s=require("node:fs").readFileSync("/proc/self/status","utf8");const e=s.match(/^CapEff:\s*([0-9a-f]+)$/mi)?.[1];const b=s.match(/^CapBnd:\s*([0-9a-f]+)$/mi)?.[1];const x=Number(s.match(/^Seccomp:\s*(\d+)$/mi)?.[1]);if(!e||!/^0+$/.test(e)||!b||BigInt(`0x${b}`)!==0x2c10c0n||x!==0)process.exit(1)'
docker compose exec -T server sh -c '[ "$(stat -c %a /usr/bin/bwrap)" = 4755 ]'
docker compose exec -T server sh -c '[ "$(cat /proc/self/attr/current)" = unconfined ]'
docker compose exec -T server node -e 'const h={authorization:"Bea"+"rer "+process.env.FS_TOKEN,"content-type":"text/markdown"};fetch("http://127.0.0.1:3000/api/files?name=compose-rich-link.md&visibility=public",{method:"POST",headers:h,body:"# Compose rich link\n\nActual container runtime."}).then(async r=>{if(r.status!==201)throw new Error(`upload ${r.status}`);const f=await r.json();const page=await fetch(`http://127.0.0.1:3000/${f.id}`);const html=await page.text();if(!html.includes("compose-rich-link.md")||!html.includes(`/og/${f.id}.png`))throw new Error("metadata");const card=await fetch(`http://127.0.0.1:3000/og/${f.id}.png`);const bytes=Buffer.from(await card.arrayBuffer());if(card.status!==200||card.headers.get("content-type")!=="image/png"||bytes.subarray(1,4).toString()!=="PNG")throw new Error("card");}).catch(e=>{console.error(e.message);process.exit(1)})'
docker compose ps
