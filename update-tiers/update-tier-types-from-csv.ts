#!/usr/bin/env node

import fs from 'fs';

import { program } from 'commander';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync'; // eslint-disable-line n/no-unpublished-import
import fetch from 'node-fetch';

dotenv.config();

const VALID_TYPES = new Set(['TICKET', 'SERVICE', 'PRODUCT', 'MEMBERSHIP']);
const DEFAULT_ENDPOINT = 'https://api.opencollective.com/graphql/v2';

const LOOKUP_QUERY = `
  query GetTier($legacyId: Int!) {
    tier(tier: { legacyId: $legacyId }) {
      id
      name
      type
    }
  }
`;

const EDIT_MUTATION = `
  mutation EditTierType($id: String!, $type: TierType!) {
    editTier(tier: { id: $id, type: $type }) {
      id
      legacyId
      name
      type
    }
  }
`;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const gql = async (endpoint: string, token: string, query: string, variables: object, retries = 3): Promise<any> => {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Personal-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    if (retries <= 0) throw e;
    const wait = 5000;
    console.log(`Network error (${e.message}). Retrying in ${wait / 1000}s...`);
    await sleep(wait);
    return gql(endpoint, token, query, variables, retries - 1);
  }
  if (res.status === 429) {
    if (retries <= 0) {
      throw new Error('Rate limited (HTTP 429) with no retries remaining');
    }
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10);
    console.log(`Rate limited. Waiting ${retryAfter}s before retrying...`);
    await sleep(retryAfter * 1000);
    return gql(endpoint, token, query, variables, retries - 1);
  }
  const json = (await res.json()) as { data?: any; errors?: any[] };
  if (json.errors?.length) {
    throw new Error(JSON.stringify(json.errors, null, 2));
  }
  if (!json.data) {
    throw new Error(`Unexpected response (HTTP ${res.status}): ${JSON.stringify(json, null, 2)}`);
  }
  return json.data;
};

const main = async () => {
  program
    .argument('<csvPath>', 'Path to CSV file with tierId and type columns')
    .option('--endpoint <url>', 'GraphQL endpoint', DEFAULT_ENDPOINT)
    .option('--run', 'Actually perform the updates (default is dry-run)', false)
    .option('--delay <ms>', 'Delay in milliseconds between API calls', '700');
  program.parse(process.argv);

  const [csvPath] = program.args;
  const { endpoint, run: doRun, delay: delayMs } = program.opts();
  const delay = parseInt(delayMs, 10);

  const token = process.env.PERSONAL_TOKEN;
  if (!token) {
    throw new Error('PERSONAL_TOKEN env var is required');
  }

  // Parse CSV
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows: { tierId: string; type: string }[] = parse(raw, {
    columns: true,
    skip_empty_lines: true, // eslint-disable-line camelcase
  });

  // Validate types
  const invalid = rows.filter(r => !VALID_TYPES.has(r.type));
  if (invalid.length) {
    throw new Error(`Invalid tier types in CSV: ${invalid.map(r => `${r.tierId}=${r.type}`).join(', ')}`);
  }

  console.log(`Loaded ${rows.length} rows from CSV. Dry-run: ${!doRun}`);

  // Look up each tier to verify existence and get public ID
  const plan: {
    legacyId: number;
    publicId: string;
    currentType: string;
    newType: string;
    name: string;
  }[] = [];
  const notFound: { tierId: string; type: string }[] = [];
  for (const row of rows) {
    const legacyId = parseInt(row.tierId, 10);
    let data: any;
    try {
      data = await gql(endpoint, token, LOOKUP_QUERY, { legacyId });
    } catch (e) {
      let isNotFound = false;
      try {
        const errors = JSON.parse(e.message);
        isNotFound = Array.isArray(errors) && errors.some(err => err.extensions?.code === 'NotFound');
      } catch {
        // not a GraphQL error array
      }
      if (isNotFound) {
        console.log(`  #${legacyId}: not found, skipping`);
        notFound.push(row);
        await sleep(delay);
        continue;
      }
      throw e;
    }
    if (!data.tier) {
      console.log(`  #${legacyId}: not found, skipping`);
      notFound.push(row);
      await sleep(delay);
      continue;
    }
    const { id: publicId, name, type: currentType } = data.tier;
    plan.push({ legacyId, publicId, currentType, newType: row.type, name });
    console.log(`  #${legacyId} "${name}": ${currentType} -> ${row.type}`);
    await sleep(delay);
  }

  if (!doRun) {
    console.log('\nDry-run complete. Re-run with --run to apply changes.');
    return;
  }

  // Apply mutations
  let success = 0,
    failed = 0;
  for (const item of plan) {
    try {
      await gql(endpoint, token, EDIT_MUTATION, { id: item.publicId, type: item.newType });
      console.log(`[ok]   Tier #${item.legacyId} "${item.name}": ${item.currentType} -> ${item.newType}`);
      success++;
    } catch (e) {
      console.error(`[fail] Tier #${item.legacyId} "${item.name}": ${e.message}`);
      failed++;
    }
    await sleep(delay);
  }

  console.log(`\nDone: ${success} updated, ${failed} failed.`);

  if (notFound.length > 0) {
    const notFoundPath = csvPath.replace(/\.csv$/i, '') + '-not-found.csv';
    const csvContent = ['tierId,type', ...notFound.map(r => `${r.tierId},${r.type}`)].join('\n') + '\n';
    fs.writeFileSync(notFoundPath, csvContent, 'utf8');
    console.log(`\n${notFound.length} tier(s) not found. Written to: ${notFoundPath}`);
  }
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
