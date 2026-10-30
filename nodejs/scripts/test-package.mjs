/*
 * Copyright 2026 Snowflake Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm, readFile, cp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), "sar-package-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this check through npm run test:package");
function run(command, args, cwd = temporary, timeout = 180_000) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
}
try {
  const packed = JSON.parse(
    run(
      process.execPath,
      [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      root,
    ),
  )[0];
  if (packed.unpackedSize > 1_500_000)
    throw new Error("Package exceeds the reviewed 1.5 MB uncompressed budget");
  for (const expected of [
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.d.cts",
    "dist/auth.js",
    "dist/connections.js",
    "dist/queries.js",
    "dist/account-http.js",
    "dist/secret-client.js",
    "dist/driver.js",
    "dist/browser.js",
    "README.md",
    "LICENSE",
    "NOTICE",
  ]) {
    if (!packed.files.some((file) => file.path === expected))
      throw new Error(`Missing package file: ${expected}`);
  }
  for (const file of packed.files) {
    if (
      !/^(dist\/|src\/|package\.json$|README\.md$|CHANGELOG\.md$|LICENSE$|NOTICE$)/.test(file.path)
    )
      throw new Error(`File outside package allowlist: ${file.path}`);
    if (/node_modules|\.env|\.test\.|\.snowflake|\.git\//.test(file.path))
      throw new Error(`Unexpected packed file: ${file.path}`);
    if (file.path.endsWith(".map")) {
      const map = JSON.parse(await readFile(path.join(root, file.path), "utf8"));
      if (
        [map.sourceRoot ?? "", ...map.sources].some(
          (source) =>
            path.posix.isAbsolute(source) ||
            path.win32.isAbsolute(source) ||
            source.startsWith("file:"),
        )
      )
        throw new Error("Source map contains a local absolute path");
    }
  }
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@snowflake/sar-sdk": `file:../${packed.filename}` },
      devDependencies: { "@types/node": "22.15.18" },
    }),
  );
  // Installing the consumer's dependency tree can take several minutes on Windows runners.
  run(
    process.execPath,
    [npmCli, "install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    consumer,
    600_000,
  );
  const cjs = `const assert = require('node:assert/strict');
const before = new Set(Object.keys(require.cache));
const { createSarClient, SarError, isSarError } = require('@snowflake/sar-sdk');
const { fromToml, fromPlatform, createConnectionOptions } = require('@snowflake/sar-sdk/auth');
const client = createSarClient({connectionOptions:createConnectionOptions({account:'synthetic',authenticator:'OAUTH',token:'synthetic'})});
assert.equal(typeof fromToml, 'function');
assert.equal(typeof fromPlatform, 'function');
assert.equal(typeof client.fetch, 'function');
assert.equal(typeof client.asCaller({token:'synthetic'}).fetch, 'function');
for (const name of ['submitDetached','pollQuery','streamQuery','getQueryStatus','cancelQuery']) {
 assert.equal(typeof client[name], 'function');
 assert.equal(typeof client.asCaller({token:'synthetic'})[name], 'function');
}
assert.equal('rest' in client, false);
assert.equal(isSarError(new SarError('CLIENT_CLOSED','closed')), true);
assert.equal(Object.keys(require.cache).filter(name => !before.has(name)).some(name => /[\\\\/]snowflake-sdk[\\\\/]/.test(name)), false);
client.close().then(() => console.log('CommonJS: lazy package passed'));
`;
  await writeFile(path.join(consumer, "smoke.cjs"), cjs);
  process.stdout.write(run(process.execPath, ["smoke.cjs"], consumer));
  await writeFile(
    path.join(consumer, "smoke.mjs"),
    `import {createSarClient} from '@snowflake/sar-sdk'; import {fromToml,fromPlatform,createConnectionOptions} from '@snowflake/sar-sdk/auth'; const client=createSarClient({connectionOptions:createConnectionOptions({account:'synthetic',authenticator:'OAUTH',token:'synthetic'})}); if(typeof client.fetch!=='function'||typeof client.asCaller({token:'synthetic'}).fetch!=='function'||'rest' in client)throw Error('invalid fetch API'); await client.close(); if(typeof fromToml!=='function'||typeof fromPlatform!=='function')throw Error('missing export'); console.log('ESM: package passed');`,
  );
  process.stdout.write(run(process.execPath, ["smoke.mjs"], consumer));
  await writeFile(
    path.join(consumer, "composition.cjs"),
    `
const assert = require('node:assert/strict');
const {createConnectionOptions} = require('@snowflake/sar-sdk/auth');
const {createConnectionManager} = require('@snowflake/sar-sdk/connections');
const {createQueryClient} = require('@snowflake/sar-sdk/query');
const {createFetchClient} = require('@snowflake/sar-sdk/http');
const {createSecrets} = require('@snowflake/sar-sdk/secrets');
const auth=createConnectionOptions({account:'synthetic',authenticator:'OAUTH',token:'synthetic'});
const manager=createConnectionManager(auth);
const queries=createQueryClient(manager);
const http=createFetchClient(auth);
const secrets=createSecrets();
assert.equal(typeof manager.withConnection,'function');
assert.equal('query' in manager,false);
assert.equal('asCaller' in createQueryClient(manager.asCaller({token:'synthetic'})),false);
assert.equal(Object.keys(require.cache).some(name=>/[\\\\/]snowflake-sdk[\\\\/]/.test(name)),false);
void Promise.all([queries.close(),manager.close(),http.close(),secrets.close()]);
`,
  );
  process.stdout.write(run(process.execPath, ["composition.cjs"], consumer));
  for (const [entry, forbidden] of [
    ["connections", "undici"],
    ["auth", "undici"],
    ["secrets", "smol-toml"],
    ["query", "smol-toml"],
  ]) {
    process.stdout.write(
      run(
        process.execPath,
        [
          "-e",
          `require('@snowflake/sar-sdk/${entry}'); if(Object.keys(require.cache).some(name=>name.includes('/${forbidden}/')||name.includes('\\\\${forbidden}\\\\'))) throw Error('unrelated dependency loaded');`,
        ],
        consumer,
      ),
    );
  }
  await writeFile(
    path.join(consumer, "interop.mjs"),
    `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import * as esm from '@snowflake/sar-sdk'; import '@snowflake/sar-sdk/driver'; const require=createRequire(import.meta.url); const cjs=require('@snowflake/sar-sdk'); assert(cjs.isSarError(new esm.SarError('CLIENT_CLOSED','closed'))); assert(esm.isSarError(new cjs.SarError('CLIENT_CLOSED','closed'))); require('@snowflake/sar-sdk/driver'); assert.throws(()=>require('@snowflake/sar-sdk/src/sar-client'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'}); console.log('Mixed ESM/CommonJS guards and export encapsulation passed');`,
  );
  process.stdout.write(run(process.execPath, ["interop.mjs"], consumer));
  await writeFile(
    path.join(consumer, "composition-interop.mjs"),
    `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createConnectionOptions} from '@snowflake/sar-sdk/auth';
import {createConnectionManager} from '@snowflake/sar-sdk/connections';
import {createQueryClient} from '@snowflake/sar-sdk/query';
const require=createRequire(import.meta.url);
const cjsAuth=require('@snowflake/sar-sdk/auth');
const cjsConnections=require('@snowflake/sar-sdk/connections');
const cjsQueries=require('@snowflake/sar-sdk/query');
for(const [authFactory,managerFactory,queryFactory] of [[createConnectionOptions,cjsConnections.createConnectionManager,createQueryClient],[cjsAuth.createConnectionOptions,createConnectionManager,cjsQueries.createQueryClient]]) {
 const auth=authFactory({account:'synthetic',authenticator:'OAUTH',token:'synthetic'});
 const manager=managerFactory(auth);
 const query=queryFactory(manager);
 const caller=queryFactory(manager.asCaller({token:'synthetic'}));
 const reference={version:1,queryId:'01000000-0000-0000-0000-00000000abcd',submittedAt:'2026-09-29T00:00:00.000Z',identity:{organization:'ORG',account:'ACCOUNT',user:'USER',role:'ROLE'},mode:'owner',results:{format:'json',rowMode:'object',maxRows:100,maxBytes:1024}};
 // Validate mixed-module detached scopes without acquiring real credentials.
 await assert.rejects(query.pollQuery(reference,{signal:AbortSignal.abort()}),{code:'ABORTED'});
 await assert.rejects(caller.pollQuery({...reference,mode:'caller'},{signal:AbortSignal.abort()}),{code:'ABORTED'});
 await assert.rejects(query.pollQuery(reference,{waitMs:0}),{code:'INVALID_OPTIONS'});
 await caller.close(); await query.close(); await manager.close();
 // A callerAsOwner factory makes caller views owner scopes in the other module format too.
 const ownerAuth=authFactory({account:'synthetic',authenticator:'OAUTH',token:'synthetic'},{callerAsOwner:true});
 const ownerManager=managerFactory(ownerAuth);
 const ownerCaller=queryFactory(ownerManager.asCaller({token:'synthetic'}));
 await assert.rejects(ownerCaller.pollQuery(reference,{signal:AbortSignal.abort()}),{code:'ABORTED'});
 await assert.rejects(ownerCaller.pollQuery({...reference,mode:'caller'},{signal:AbortSignal.abort()}),{code:'QUERY_IDENTITY_MISMATCH'});
 await ownerCaller.close(); await ownerManager.close();
}
console.log('Mixed ESM/CommonJS component composition passed');
`,
  );
  process.stdout.write(run(process.execPath, ["composition-interop.mjs"], consumer));
  await writeFile(
    path.join(consumer, "native-options.mjs"),
    `
import assert from 'node:assert/strict';
import snowflake from 'snowflake-sdk';
import {createConnectionOptions} from '@snowflake/sar-sdk/auth';
const options=createConnectionOptions({account:'synthetic',authenticator:'OAUTH',token:'synthetic'});
const native=options.getOwnerOptions();
const connection=snowflake.createConnection(native);
assert.equal(typeof connection.execute,'function');
const pool=snowflake.createPool(options.getOwnerOptions(),{min:0,max:1,autostart:false});
await pool.drain(); await pool.clear();
console.log('Native driver connection and non-started pool accept generated options');
`,
  );
  process.stdout.write(run(process.execPath, ["native-options.mjs"], consumer));
  await writeFile(
    path.join(consumer, "browser.mjs"),
    `import assert from 'node:assert/strict'; for (const name of ['@snowflake/sar-sdk','@snowflake/sar-sdk/auth','@snowflake/sar-sdk/driver','@snowflake/sar-sdk/connections','@snowflake/sar-sdk/query','@snowflake/sar-sdk/http','@snowflake/sar-sdk/secrets']) { await assert.rejects(import(name)); } console.log('Browser entries reject execution');`,
  );
  process.stdout.write(run(process.execPath, ["--conditions=browser", "browser.mjs"], consumer));
  await writeFile(
    path.join(consumer, "usage.mts"),
    `import {createSarClient, type QueryResult} from '@snowflake/sar-sdk'; import type {Connection} from '@snowflake/sar-sdk/driver'; const client=createSarClient(); const result: Promise<QueryResult<{ID:string}>> = client.query<{ID:string}>('SELECT ID'); void result; void (null as Connection | null); const id: Promise<string> = client.asCaller({headers:new Headers()}).withConnection(async connection => connection.getId()); void id; const response: Promise<Response> = client.fetch('/api/v2/test'); const callerResponse: Promise<Response> = client.asCaller({headers:new Headers()}).fetch('/api/v2/test'); void response; void callerResponse;
// @ts-expect-error The former rest namespace is not an alias.
void client.rest;
// @ts-expect-error Caller identity comes from asCaller(), not withConnection options.
void client.withConnection({asCaller:true,headers:new Headers()}, async connection => connection.getId());
const reference: Promise<import('@snowflake/sar-sdk/query').QueryReference> = client.submitDetached('SELECT 1', {executionTimeoutMs:1000});
const poll: Promise<import('@snowflake/sar-sdk').QueryPollResult<{ID:string}>> = reference.then(ref => client.pollQuery<{ID:string}>(ref,{lookupTimeoutMs:1000,consumeTimeoutMs:1000})); void poll;
const streamed: Promise<import('@snowflake/sar-sdk/query').QueryStreamResult<{ID:string}>> = reference.then(ref => client.streamQuery<{ID:string}>(ref,{consumeTimeoutMs:1000})); void streamed;
// @ts-expect-error Detached lookups do not wait for execution.
reference.then(ref => client.pollQuery(ref,{waitMs:0}));`,
  );
  await writeFile(
    path.join(consumer, "usage.cts"),
    `import sdk = require('@snowflake/sar-sdk'); const client: sdk.SarClient = sdk.createSarClient(); const id: Promise<string> = client.asCaller({headers:new Headers()}).withConnection(async connection => connection.getId()); void id; const response: Promise<Response> = client.fetch('/api/v2/test'); const callerResponse: Promise<Response> = client.asCaller({token:'synthetic'}).fetch('/api/v2/test'); void response; void callerResponse;
// @ts-expect-error The former rest namespace is not an alias.
void client.rest;
// @ts-expect-error Caller identity comes from asCaller(), not withConnection options.
void client.withConnection({asCaller:true,headers:new Headers()}, async connection => connection.getId());
const reference: Promise<sdk.QueryReference> = client.submitDetached('SELECT 1');
const poll: Promise<sdk.QueryPollResult> = reference.then(ref => client.pollQuery(ref)); void poll;
const streamed: Promise<sdk.QueryStreamResult> = reference.then(ref => client.streamQuery(ref)); void streamed;
// @ts-expect-error Detached polling intervals belong to the browser.
reference.then(ref => client.pollQuery(ref,{pollIntervalMs:1000}));`,
  );
  await cp(path.join(root, "examples"), path.join(consumer, "examples"), { recursive: true });
  const examples = (await readdir(path.join(consumer, "examples")))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join("examples", name));
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  for (const resolution of ["NodeNext", "Bundler"]) {
    const files = resolution === "NodeNext" ? ["usage.mts", "usage.cts"] : ["usage.mts"];
    run(
      process.execPath,
      [
        compiler,
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--target",
        "ES2022",
        "--module",
        resolution === "NodeNext" ? "NodeNext" : "ESNext",
        "--moduleResolution",
        resolution,
        ...files,
        ...examples,
      ],
      consumer,
    );
    console.log(`${resolution}: packed declarations and public examples passed`);
  }
  process.stdout.write(
    run(
      process.execPath,
      [
        path.join(root, "node_modules/publint/src/cli.js"),
        path.join(consumer, "node_modules/@snowflake/sar-sdk"),
      ],
      consumer,
    ),
  );
  console.log(`Packed ${packed.files.length} files; clean consumer checks passed`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
