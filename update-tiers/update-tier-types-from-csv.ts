#!/usr/bin/env node

import fs from 'fs';

import { program } from 'commander';
import { parse } from 'csv-parse/sync'; // eslint-disable-line n/no-unpublished-import
import fetch from 'node-fetch';

const VALID_TYPES = new Set(['TICKET', 'SERVICE', 'PRODUCT', 'MEMBERSHIP']);
const DEFAULT_ENDPOINT = 'https://api.opencollective.com/graphql/v2';

const LOOKUP_QUERY = `
  query GetTier($legacyId: Int!) {
    tier(tier: { legacyId: $legacyId }) {
      id
      name
      type
      collective { slug }
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

const gql = async (endpoint: string, token: string, query: string, variables: object) => {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Personal-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: any; errors?: any[] };
  if (json.errors?.length) {
    throw new Error(JSON.stringify(json.errors));
  }
  return json.data;
};

const main = async () => {
  program
    .argument('<csvPath>', 'Path to CSV file with tierId and type columns')
    .option('--endpoint <url>', 'GraphQL endpoint', DEFAULT_ENDPOINT)
    .option('--run', 'Actually perform the updates (default is dry-run)', false);
  program.parse(process.argv);

  const [csvPath] = program.args;
  const { endpoint, run: doRun } = program.opts();

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
    collective: string;
    name: string;
  }[] = [];
  for (const row of rows) {
    const legacyId = parseInt(row.tierId, 10);
    const data = await gql(endpoint, token, LOOKUP_QUERY, { legacyId });
    if (!data.tier) {
      throw new Error(`Tier ${legacyId} not found`);
    }
    const { id: publicId, name, type: currentType, collective } = data.tier;
    plan.push({ legacyId, publicId, currentType, newType: row.type, name, collective: collective.slug });
    console.log(`  #${legacyId} "${name}" (${collective.slug}): ${currentType} -> ${row.type}`);
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
      console.log(`[ok] Tier #${item.legacyId} "${item.name}": ${item.currentType} -> ${item.newType}`);
      success++;
    } catch (e) {
      console.error(`[fail] Tier #${item.legacyId} "${item.name}": ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} updated, ${failed} failed.`);
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
