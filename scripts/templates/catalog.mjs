// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Writes templates/catalog.json from each template's template.json and the files a project
// created from it gets. With --check, fails instead when the catalog is out of date.
//
// Usage, from anywhere in the repository: node scripts/templates/catalog.mjs [--check]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const TEMPLATES_DIR = "templates";
const CATALOG_PATH = `${TEMPLATES_DIR}/catalog.json`;
const METADATA_FILE = "template.json";
const CATALOG_VERSION = 1;

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const RUNTIMES = ["node", "python"];
// Account capabilities, named as `snow app setup --capabilities` reports them.
const CAPABILITIES = ["serverless", "python", "python-serverless", "streamlit-serverless"];
const SURFACES = ["cli", "workspaces"];

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isListOf = (allowed) => (value) =>
  Array.isArray(value) &&
  new Set(value).size === value.length &&
  value.every((item) => allowed.includes(item));

// The catalog lists the fields in this order.
const METADATA_FIELDS = {
  title: isText,
  summary: isText,
  when_to_use: isText,
  when_not_to_use: isText,
  runtime: (value) => RUNTIMES.includes(value),
  framework: isText,
  requires: isListOf(CAPABILITIES),
  surfaces: (value) => isListOf(SURFACES)(value) && value.length > 0,
  default: (value) => typeof value === "boolean",
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function readMetadata(dir) {
  const path = `${dir}/${METADATA_FILE}`;
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
  } catch (error) {
    fail(`${path}: ${error.message}`);
  }
  const unknown = Object.keys(metadata).filter((key) => !(key in METADATA_FIELDS));
  if (unknown.length > 0) {
    fail(`${path}: unknown field(s) ${unknown.join(", ")}.`);
  }
  for (const [key, isValid] of Object.entries(METADATA_FIELDS)) {
    if (!isValid(metadata[key])) {
      fail(`${path}: "${key}" is missing or invalid.`);
    }
  }
  return Object.fromEntries(Object.keys(METADATA_FIELDS).map((key) => [key, metadata[key]]));
}

// The files a commit would hold under dir: tracked files that still exist, and untracked files
// that aren't ignored. Paths are relative to dir and sorted.
function listFiles(dir) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir],
    { cwd: ROOT, encoding: "utf8" },
  );
  const paths = [];
  for (const path of output.split("\0")) {
    if (path === "") {
      continue;
    }
    let stats;
    try {
      stats = lstatSync(join(ROOT, path));
    } catch {
      continue; // Deleted but not yet staged.
    }
    if (stats.isSymbolicLink()) {
      fail(`${path}: templates can't contain symbolic links.`);
    }
    paths.push(path.slice(dir.length + 1));
  }
  return paths.filter((path) => path !== METADATA_FILE).sort();
}

function describeTemplate(id) {
  const dir = `${TEMPLATES_DIR}/${id}`;
  const metadata = readMetadata(dir);
  const files = listFiles(dir).map((path) => {
    const content = readFileSync(join(ROOT, dir, path));
    return { path, size: content.length, sha256: sha256(content) };
  });
  if (!files.some((file) => file.path === "app.yml")) {
    fail(`${dir}: a template needs an app.yml.`);
  }
  // The digest hashes the file list as sha256sum prints it, so a checkout can reproduce it.
  const listing = files.map((file) => `${file.sha256}  ${file.path}\n`).join("");
  return { id, path: dir, ...metadata, digest: `sha256:${sha256(listing)}`, files };
}

function buildCatalog() {
  const ids = readdirSync(join(ROOT, TEMPLATES_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const id of ids) {
    if (!ID_PATTERN.test(id)) {
      fail(`${TEMPLATES_DIR}/${id}: a template directory name must match ${ID_PATTERN}.`);
    }
  }
  const templates = ids.map(describeTemplate);
  const defaults = templates.filter((template) => template.default).map((template) => template.id);
  if (defaults.length !== 1) {
    fail(
      `Exactly one template must set "default": true, not ${defaults.length} (${defaults.join(", ")}).`,
    );
  }
  return { catalog_version: CATALOG_VERSION, templates };
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) {
  fail("Usage: node scripts/templates/catalog.mjs [--check]");
}
const catalog = `${JSON.stringify(buildCatalog(), null, 2)}\n`;
const target = join(ROOT, CATALOG_PATH);
if (args.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // A missing catalog is out of date too.
  }
  if (current !== catalog) {
    fail(
      `${CATALOG_PATH} is out of date. Run \`node scripts/templates/catalog.mjs\` and commit the result.`,
    );
  }
  console.log(`${CATALOG_PATH} is up to date.`);
} else {
  writeFileSync(target, catalog);
  console.log(`Wrote ${CATALOG_PATH}.`);
}
