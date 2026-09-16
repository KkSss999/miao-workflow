#!/usr/bin/env bash
#
# 跑 Postgres conformance：拉一个临时容器 → 建表 → 跑测试 → 收掉。
#
# 用独立端口和独立容器名，不碰任何已有数据库 / volume：
#   - 容器带 --rm，退出即删
#   - 不挂 volume，数据随容器消失
#
# 想用自己的库：MWF_TEST_POSTGRES_URL=postgresql://... pnpm test
set -euo pipefail

NAME="${MWF_PG_NAME:-mwf-pg-test}"
PORT="${MWF_PG_PORT:-55432}"
IMAGE="${MWF_PG_IMAGE:-postgres:17-alpine}"
USER_NAME="mwf"
PASSWORD="mwf"
DATABASE="mwf"
URL="postgresql://${USER_NAME}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}"

cleanup() {
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
docker run -d --rm --name "${NAME}" \
  -p "127.0.0.1:${PORT}:5432" \
  -e "POSTGRES_USER=${USER_NAME}" \
  -e "POSTGRES_PASSWORD=${PASSWORD}" \
  -e "POSTGRES_DB=${DATABASE}" \
  "${IMAGE}" >/dev/null

ready=""
for _ in $(seq 1 30); do
  if docker exec "${NAME}" pg_isready -U "${USER_NAME}" -d "${DATABASE}" >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done

if [ -z "${ready}" ]; then
  echo "postgres 没在 30 秒内就绪，放弃" >&2
  exit 1
fi

echo "postgres ready → ${URL}"
MWF_TEST_POSTGRES_URL="${URL}" pnpm exec vitest run "$@"
