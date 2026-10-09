#!/usr/bin/env bash
# Creates a throwaway git repository with a feature branch that has every kind of
# problem /mr-review looks for: a planted key, SQL interpolation, an N+1 loop,
# TLS verification off, a console.log, a focused test, WIP commits, and a
# conflict with develop.
#
# usage: make-sample-repo.sh <new directory>
set -euo pipefail

dir="${1:?usage: make-sample-repo.sh <new directory>}"
if [ -e "$dir" ]; then
  echo "refusing to touch an existing path: $dir" >&2
  exit 1
fi

mkdir -p "$dir"
cd "$dir"
git init -q -b develop
git config user.email demo@example.com
git config user.name Demo
mkdir -p src

cat > package.json <<'JSON'
{ "name": "sample-app", "version": "1.0.0", "private": true, "scripts": { "test": "vitest" } }
JSON

cat > src/db.ts <<'TS'
import { Pool } from 'pg'

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params)
  return result.rows as T[]
}

export const DEFAULT_PAGE_SIZE = 50
TS

cat > src/users.ts <<'TS'
import { query } from './db'

export type User = { id: number; name: string; email: string }

export async function findUser(id: number): Promise<User | undefined> {
  const rows = await query<User>('SELECT id, name, email FROM users WHERE id = $1', [id])
  return rows[0]
}
TS

echo "# Sample app" > README.md
git add -A
git commit -qm "Initial app"

git checkout -qb feature/user-export
cat > src/export.ts <<'TS'
import { query } from './db'
import { findUser, User } from './users'
import https from 'https'

const EXPORT_API_KEY = "__FAKE_STRIPE_KEY__"

export async function exportUsers(nameFilter: string): Promise<User[]> {
  console.log('exporting users for', nameFilter)
  const users = await query<User>(`SELECT id, name, email FROM users WHERE name LIKE '%${nameFilter}%'`)
  const enriched: User[] = []
  for (const user of users) {
    const full = await findUser(user.id)
    if (full) enriched.push(full)
  }
  return enriched
}

export function pushToPartner(users: User[]): Promise<void> {
  const agent = new https.Agent({ rejectUnauthorized: false })
  const body = JSON.stringify(users)
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'partner.example.com', path: '/import', method: 'POST', agent,
      headers: { Authorization: `Bearer ${EXPORT_API_KEY}` } }, res => (res.statusCode === 200 ? resolve() : reject(new Error('failed'))))
    req.on('error', reject)
    req.end(body)
  })
}
TS
# The key-shaped value is assembled here so the script itself carries no secret-looking
# literal (GitHub push protection rejects one). The generated repo has it, on purpose.
fake_key_prefix="sk_live_"
fake_key_body="FAKE0000FAKE0000FAKE0000"
sed "s/__FAKE_STRIPE_KEY__/${fake_key_prefix}${fake_key_body}/" src/export.ts > src/export.ts.new
mv src/export.ts.new src/export.ts
git add -A
git commit -qm "wip"

sed 's/export const DEFAULT_PAGE_SIZE = 50/export const DEFAULT_PAGE_SIZE = 500 \/\/ exports need bigger pages/' src/db.ts > src/db.ts.new
mv src/db.ts.new src/db.ts
git add -A
git commit -qm "Add user export endpoint"

cat > src/export.test.ts <<'TS'
import { describe, it, expect } from 'vitest'
describe.only('exportUsers', () => {
  it('works', () => { expect(1).toBe(1) })
})
TS
git add -A
git commit -qm "fixup! Add user export endpoint"

git checkout -q develop
sed 's/export const DEFAULT_PAGE_SIZE = 50/export const DEFAULT_PAGE_SIZE = 100/' src/db.ts > src/db.ts.new
mv src/db.ts.new src/db.ts
git add -A
git commit -qm "Raise default page size"
echo "Docs." >> README.md
git add -A
git commit -qm "Docs"
git checkout -q feature/user-export

echo "sample repository ready in $dir (branch feature/user-export, target develop)"
